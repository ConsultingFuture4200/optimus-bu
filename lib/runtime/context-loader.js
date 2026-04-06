import { query } from '../db.js';
import { sanitize, countInjectionAttempts, detectAndRecordThreats, detectPII } from './sanitizer.js';
import { getAdapterForMessage } from '../adapters/registry.js';
import { checkPermission, logCapabilityInvocation } from './permissions.js';

/**
 * Context loader: assemble context for agent LLM calls.
 * Tiers control how much context an agent receives:
 *   Q1 (Haiku executors): Minimal — just the task + email metadata
 *   Q2 (Sonnet orchestrator/reviewer): Task + email + related signals + draft
 *   Q3 (Opus strategist): Full context — email + signals + contact history + voice profile
 *   Q4 (Sonnet architect): Aggregate — daily stats, pipeline metrics, no individual emails
 */

const CONTEXT_TIERS = {
  'executor-intake':     'Q1',
  'executor-triage':     'Q1',
  'executor-responder':  'Q2',
  orchestrator:          'Q2',
  reviewer:              'Q2',
  strategist:            'Q3',
  architect:             'Q4',
};

// Token budgets per tier (metric 4 target: max 8,000 input tokens)
const TIER_TOKEN_BUDGETS = { Q1: 4000, Q2: 6000, Q3: 7000, Q4: 6000 };

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// Truncate context to fit within token budget (metric 4 compliance)
function enforceTokenBudget(context) {
  const budget = TIER_TOKEN_BUDGETS[context.tier] || 6000;
  let tokens = estimateTokens(context);
  if (tokens <= budget) return context;

  // Truncate fields in order of expendability (least critical first)
  const truncatable = [
    { key: 'contactHistory', keep: 5 },   // reduce from 20 to 5
    { key: 'specAlignment', maxChars: 500 },
    { key: 'signals', keep: 5 },
    { key: 'emailBody', maxChars: 3000 },
    { key: 'fewShots', keep: 2 },
    { key: 'dailyBriefing', maxChars: 2000 },
    { key: 'agentActivity', keep: 5 },
  ];

  for (const rule of truncatable) {
    if (tokens <= budget) break;
    const val = context[rule.key];
    if (!val) continue;

    if (Array.isArray(val) && rule.keep != null) {
      context[rule.key] = val.slice(0, rule.keep);
    } else if (typeof val === 'string' && rule.maxChars != null) {
      context[rule.key] = val.slice(0, rule.maxChars);
    } else if (typeof val === 'object' && rule.maxChars != null) {
      const s = JSON.stringify(val);
      if (s.length > rule.maxChars) {
        context[rule.key] = JSON.parse(s.slice(0, rule.maxChars - 1) + '}') ?? val;
      }
    }
    tokens = estimateTokens(context);
  }

  if (tokens > budget) {
    context._tokenBudgetExceeded = true;
    context._estimatedTokens = tokens;
  }
  return context;
}

/**
 * Load context for an agent working on a task.
 *
 * @param {string} agentId - Agent requesting context
 * @param {string} workItemId - The task being worked on
 * @param {Object} [extra] - Additional context (few-shots, etc.)
 * @returns {Promise<Object>} Assembled context object
 */
export async function loadContext(agentId, workItemId, extra = {}) {
  const tier = CONTEXT_TIERS[agentId] || 'Q1';
  const context = { tier, agentId, workItemId };

  // All tiers: get the work item (account_id included via SELECT *)
  const workItem = await query(
    `SELECT * FROM agent_graph.work_items WHERE id = $1`,
    [workItemId]
  );
  context.workItem = workItem.rows[0] || null;

  // Expose account_id at top level for convenient access by agent handlers
  context.accountId = context.workItem?.account_id || null;

  // Get associated email if this is an email task
  // PGlite may return JSONB as a string — parse if needed
  let metadata = context.workItem?.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const emailId = metadata?.email_id;
  if (emailId) {
    const email = await query(
      `SELECT * FROM inbox.messages WHERE id = $1`,
      [emailId]
    );
    context.email = email.rows[0] || null;

    // Check for injection attempts in email metadata
    if (context.email) {
      const fields = [context.email.subject, context.email.snippet, context.email.from_name].filter(Boolean).join(' ');
      const attempts = countInjectionAttempts(fields);
      if (attempts > 0) {
        console.warn(`[context] INJECTION DETECTED: ${attempts} pattern(s) in email ${context.email.id}`);
        // Record to threat_memory for graduated escalation (spec §8)
        detectAndRecordThreats(fields, agentId).catch(() => {});
      }
    }

    // Fetch body + prompt context via adapter (centralizes provider-specific logic)
    // Permission check: agent must have adapter grant for this channel (ADR-017)
    try {
      const adapter = getAdapterForMessage(context.email);
      // Use provider (gmail, outlook, slack, webhook, telegram) to match grant names.
      // Not channel ('email', 'slack', etc.) — 'email' doesn't match 'gmail'/'outlook'.
      const adapterName = context.email.provider || 'gmail';
      const adapterAllowed = await checkPermission(agentId, 'adapter', adapterName);
      if (!adapterAllowed) {
        // Graceful degradation: denied adapter = null body, not crash
        console.warn(`[context] Permission denied: ${agentId} lacks adapter grant for '${adapterName}'`);
        logCapabilityInvocation({
          agentId, resourceType: 'adapter', resourceName: adapterName,
          success: false, errorMessage: 'permission_denied', workItemId,
        });
        context.emailBody = null;
        context.promptContext = null;
      } else {
        const startMs = Date.now();
        try {
          context.emailBody = await adapter.fetchContent(context.email);
          logCapabilityInvocation({
            agentId, resourceType: 'adapter', resourceName: adapterName,
            success: true, durationMs: Date.now() - startMs, workItemId,
          });
        } catch (err) {
          console.error(`[context] Failed to fetch body for message ${context.email.id}: ${err.message}`);
          logCapabilityInvocation({
            agentId, resourceType: 'adapter', resourceName: adapterName,
            success: false, durationMs: Date.now() - startMs, errorMessage: err.message, workItemId,
          });
          context.emailBody = null;
        }
        context.promptContext = adapter.buildPromptContext(context.email, context.emailBody);
      }
    } catch {
      // No adapter registered (e.g., tests without registry) — agents fall back to null
      context.emailBody = null;
      context.promptContext = null;
    }
  }

  // PII detection on fetched content (spec §5 step 4f, Gap 12)
  // Flags work items containing PII for data classification review — does not block.
  if (context.emailBody) {
    const piiResult = detectPII(context.emailBody);
    if (piiResult.hasPII) {
      context._piiDetected = piiResult.detections;
      // Flag the work item for data classification review (non-blocking)
      query(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || $1
         WHERE id = $2 AND NOT (metadata ? 'pii_flagged')`,
        [JSON.stringify({ pii_flagged: true, pii_types: piiResult.detections.map(d => d.type) }), workItemId]
      ).catch(() => {}); // non-critical
    }
  }

  // Spec alignment context (all tiers, advisory only per P2)
  try {
    const { getAgentSpecContext, formatSpecContext } = await import('../graph/spec-queries.js');
    const specCtx = await getAgentSpecContext(agentId);
    const agentTier = tier === 'Q1' ? 'haiku' : tier === 'Q4' ? 'sonnet' : tier === 'Q3' ? 'opus' : 'sonnet';
    const specSection = formatSpecContext(specCtx, agentTier);
    if (specSection) context.specAlignment = specSection;
  } catch {
    // Neo4j unavailable — no spec context (graceful degradation)
  }

  // RAG knowledge base context (from brain-rag — meeting transcripts, documents)
  // Q2+ tiers get RAG context for richer responses. Graceful degradation if unavailable.
  if (tier !== 'Q1' && context.email) {
    try {
      const { getRAGContext } = await import('../rag/client.js');
      const ragContext = await getRAGContext(context.email);
      if (ragContext) context.ragContext = ragContext;
    } catch {
      // brain-rag unavailable — proceed without (graceful degradation)
    }
  }

  // Q1: Just task + email metadata + body. Done.
  if (tier === 'Q1') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q2+: Parallel context assembly (Change 0 — 10x M14 lever) ──────────
  // Previously all queries ran sequentially (~500-1200ms). Independent queries
  // now run via Promise.all(), bounded by the slowest single query (~200-500ms).
  // Inspired by Claude Code's four-stage context pipeline.

  const targetProject = metadata?.target_project || metadata?.triage_result?.target_project;
  const fromAddress = context.email?.from_address;

  // ── Q2 parallel batch: signals + drafts + spec + RAG ──────────
  if (tier !== 'Q1' && emailId) {
    const q2Promises = [];

    // Signals (project-scoped when available)
    if (targetProject && fromAddress) {
      q2Promises.push(
        query(
          `SELECT s.* FROM inbox.signals s
           JOIN inbox.messages m ON m.id = s.message_id
           WHERE m.from_address = $1
             AND s.created_at >= NOW() - INTERVAL '30 days'
             AND (s.metadata->>'target_project' = $2 OR s.message_id = $3)
           ORDER BY s.created_at`,
          [fromAddress, targetProject, emailId]
        ).then(r => { context.signals = r.rows; context._contextScope = { project: targetProject, window: '30d' }; })
         .catch(() => { context.signals = []; })
      );
    } else {
      q2Promises.push(
        query(`SELECT * FROM inbox.signals WHERE message_id = $1 ORDER BY created_at`, [emailId])
          .then(r => { context.signals = r.rows; })
          .catch(() => { context.signals = []; })
      );
    }

    // Drafts
    q2Promises.push(
      query(
        `SELECT * FROM agent_graph.action_proposals WHERE message_id = $1 AND action_type = 'email_draft' ORDER BY version DESC LIMIT 3`,
        [emailId]
      ).then(r => { context.drafts = r.rows; })
       .catch(() => { context.drafts = []; })
    );

    await Promise.all(q2Promises);
  }

  if (tier === 'Q2') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q3 parallel batch: contact + voice + history + few-shots ──────────
  if (fromAddress) {
    const q3Promises = [];

    // Contact lookup
    q3Promises.push(
      query(`SELECT * FROM signal.contacts WHERE email_address = $1`, [fromAddress])
        .then(r => { context.contact = r.rows[0] || null; })
        .catch(() => { context.contact = null; })
    );

    // Voice profile resolution (account-scoped, with fallback chain)
    q3Promises.push(
      (async () => {
        let voiceAccountId = context.accountId || null;
        if (voiceAccountId) {
          try {
            const sourceR = await query(
              `SELECT voice_profile_source FROM inbox.accounts WHERE id = $1`,
              [voiceAccountId]
            );
            const source = sourceR.rows[0]?.voice_profile_source;
            if (source && source !== voiceAccountId) voiceAccountId = source;
          } catch { /* column may not exist yet */ }
        }
        context.voiceAccountId = voiceAccountId;

        // Try in priority order: scoped recipient → scoped global → unscoped recipient → unscoped global
        if (voiceAccountId) {
          const scopedRecip = await query(
            `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 AND account_id = $2`,
            [fromAddress, voiceAccountId]
          );
          if (scopedRecip.rows[0]) { context.voiceProfile = scopedRecip.rows[0]; return; }

          const scopedGlobal = await query(
            `SELECT * FROM voice.profiles WHERE scope = 'global' AND account_id = $1 LIMIT 1`,
            [voiceAccountId]
          );
          if (scopedGlobal.rows[0]) { context.voiceProfile = scopedGlobal.rows[0]; return; }
        }

        const unscoped = await query(
          `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1`,
          [fromAddress]
        );
        if (unscoped.rows[0]) { context.voiceProfile = unscoped.rows[0]; return; }

        const globalFallback = await query(`SELECT * FROM voice.profiles WHERE scope = 'global' LIMIT 1`);
        context.voiceProfile = globalFallback.rows[0] || null;
      })().catch(() => { context.voiceProfile = null; })
    );

    // Contact history (project-scoped when available)
    if (targetProject) {
      q3Promises.push(
        query(
          `SELECT m.id, m.subject, m.snippet, m.received_at, m.from_address
           FROM inbox.messages m
           WHERE m.from_address = $1
             AND m.received_at >= NOW() - INTERVAL '30 days'
           ORDER BY m.received_at DESC
           LIMIT 20`,
          [fromAddress]
        ).then(r => {
          context.contactHistory = r.rows;
          context._contextScope = { ...(context._contextScope || {}), project: targetProject, window: '30d' };
        }).catch(() => { context.contactHistory = []; })
      );
    }

    await Promise.all(q3Promises);
  }

  if (extra.fewShots) context.fewShots = extra.fewShots;

  if (tier === 'Q3') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q4 parallel batch: architect aggregate metrics ──────────
  const [dailyBriefing, agentActivity, budgetStatus] = await Promise.all([
    query(`SELECT * FROM signal.v_daily_briefing`).catch(() => ({ rows: [] })),
    query(`SELECT * FROM agent_graph.v_agent_activity`).catch(() => ({ rows: [] })),
    query(`SELECT * FROM agent_graph.v_budget_status WHERE period_end >= CURRENT_DATE`).catch(() => ({ rows: [] })),
  ]);
  context.dailyBriefing = dailyBriefing.rows[0] || null;
  context.agentActivity = agentActivity.rows;
  context.budgetStatus = budgetStatus.rows;

  return sanitize(enforceTokenBudget(context));
}

/**
 * Load reflection context for an agent: recent outcomes + Neo4j patterns.
 * Called by agent reflect() methods for self-improvement.
 */
export async function loadReflectionContext(agentId) {
  const context = { agentId };

  // Intent match rate from Postgres
  try {
    const matchRate = await query(
      `SELECT * FROM agent_graph.intent_match_rate WHERE agent_id = $1`,
      [agentId]
    );
    context.intentMatchRate = matchRate.rows;
  } catch {
    context.intentMatchRate = [];
  }

  // Recent task outcomes (last 7 days)
  try {
    const outcomes = await query(
      `SELECT wi.id, wi.title, wi.status, wi.metadata,
              st.cost_usd, st.reason, st.created_at as completed_at
       FROM agent_graph.work_items wi
       JOIN agent_graph.state_transitions st ON st.work_item_id = wi.id AND st.to_state = wi.status
       WHERE wi.assigned_to = $1
         AND wi.status IN ('completed', 'failed')
         AND st.created_at > now() - INTERVAL '7 days'
       ORDER BY st.created_at DESC
       LIMIT 20`,
      [agentId]
    );
    context.recentOutcomes = outcomes.rows;
  } catch {
    context.recentOutcomes = [];
  }

  // Neo4j multi-hop patterns (if available) — ADR-019
  // P2: Neo4j data is advisory only — never use for enforcement decisions
  try {
    const { getDecisionOutcomeChain, getDelegationEffectiveness } = await import('../graph/queries.js');
    const [decisionChains, delegationEffectiveness] = await Promise.all([
      getDecisionOutcomeChain(agentId),
      getDelegationEffectiveness(),
    ]);
    context.decisionChains = decisionChains || [];
    context.delegationEffectiveness = delegationEffectiveness || [];
  } catch {
    context.decisionChains = [];
    context.delegationEffectiveness = [];
  }

  return context;
}

/**
 * Load system topology for an agent: who can do what, delegation paths.
 * Used by orchestrator for dynamic routing decisions.
 */
export async function loadSystemTopology(forAgent) {
  const topology = { forAgent };

  // Active agents with their capabilities
  try {
    const agents = await query(
      `SELECT ac.id, ac.agent_type, ac.model, ac.is_active,
              ac.tools_allowed,
              (SELECT array_agg(can_assign) FROM agent_graph.agent_assignment_rules WHERE agent_id = ac.id) AS can_delegate_to,
              (SELECT COUNT(*) FROM agent_graph.work_items WHERE assigned_to = ac.id AND status = 'in_progress') AS active_tasks
       FROM agent_graph.agent_configs ac
       WHERE ac.is_active = true
       ORDER BY ac.agent_type, ac.id`
    );
    topology.agents = agents.rows;
  } catch {
    topology.agents = [];
  }

  // Recent routing success rates (last 7 days)
  try {
    const successRates = await query(
      `SELECT wi.assigned_to,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE wi.status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE wi.status = 'failed') AS failed,
              ROUND(100.0 * COUNT(*) FILTER (WHERE wi.status = 'completed') / NULLIF(COUNT(*), 0), 1) AS success_pct
       FROM agent_graph.work_items wi
       WHERE wi.created_at > now() - INTERVAL '7 days'
         AND wi.status IN ('completed', 'failed')
       GROUP BY wi.assigned_to
       ORDER BY success_pct DESC`
    );
    topology.successRates = successRates.rows;
  } catch {
    topology.successRates = [];
  }

  return topology;
}

/**
 * Executor-Intake Agent Handler
 *
 * Multi-channel intake classifier. Sits above the orchestrator:
 *   1. Check deterministic routes first (zero LLM cost)
 *   2. If no deterministic match, classify via LLM (Haiku)
 *   3. Route based on classification: TRIVIAL → resolve + review,
 *      MODERATE → assign to executor, COMPLEX → assign to orchestrator,
 *      SPECIALIZED → flag for clarification
 *
 * Design: Dustin's triage-01 behavioral contract, adapted per
 * Liotta (executor-tier, not new tier) and Linus (enforce via
 * infrastructure, route all resolutions through reviewer).
 *
 * See: config/agents/triage-01.agents.md
 */

import { query } from '../../lib/db.js';
import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load behavioral contract as system prompt context
let _behavioralContract = null;
function getBehavioralContract() {
  if (!_behavioralContract) {
    try {
      _behavioralContract = readFileSync(
        join(__dirname, '..', '..', 'config', 'agents', 'triage-01.agents.md'),
        'utf-8'
      );
    } catch {
      _behavioralContract = '';
    }
  }
  return _behavioralContract;
}

/**
 * Check deterministic routes before LLM classification.
 * Returns { action, confidence, rationale } or null if no match.
 */
async function checkDeterministicRoutes(context) {
  // Channel-agnostic: resolve sender and subject from promptContext or email fallback
  const sender = context.promptContext?.sender;
  const fromAddress = sender?.address || context.email?.from_address || '';
  const fromDomain = fromAddress.split('@')[1] || '';
  const subject = context.promptContext?.threading?.subject || context.email?.subject || '';
  const channel = context.promptContext?.channel || context.email?.channel || 'email';

  if (!fromAddress && !subject) return null;

  // Check the deterministic_routes table
  try {
    const result = await query(
      `SELECT match_type, match_value, action, domain_tags, confidence
       FROM inbox.deterministic_routes
       WHERE enabled = true
       ORDER BY priority ASC`,
    );

    for (const route of result.rows) {
      let matched = false;

      switch (route.match_type) {
        case 'sender_domain':
          matched = fromDomain === route.match_value;
          break;
        case 'sender_address':
          matched = fromAddress === route.match_value;
          break;
        case 'subject_contains':
          matched = subject.toLowerCase().includes(route.match_value.toLowerCase());
          break;
        case 'subject_regex':
          try { matched = new RegExp(route.match_value, 'i').test(subject); } catch { matched = false; }
          break;
        case 'auto_reply':
          matched = /^(re:\s*)?(out of office|automatic reply|auto-reply|undeliverable|delivery status)/i.test(subject)
            || (context.email?.headers && /auto-submitted:\s*auto/i.test(JSON.stringify(context.email.headers)));
          break;
      }

      if (matched) {
        return {
          action: route.action,
          confidence: route.confidence || 5,
          rationale: `Deterministic route: ${route.match_type} = "${route.match_value}"`,
          domain_tags: typeof route.domain_tags === 'string' ? JSON.parse(route.domain_tags) : route.domain_tags || [],
          deterministic: true,
        };
      }
    }
  } catch (err) {
    // Table may not exist yet — fall through to LLM
    if (!err.message.includes('does not exist')) {
      console.warn(`[executor-intake] Deterministic route check failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * Parse the LLM's classification response.
 * Expects JSON with complexity, confidence, domain_tags, rationale, recommended_action.
 */
function parseClassification(text) {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      complexity: 'COMPLEX',
      confidence: 1,
      domain_tags: [],
      rationale: 'Failed to parse classification — escalating',
      recommended_action: 'ROUTE_ORCHESTRATOR',
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      complexity: parsed.complexity || 'COMPLEX',
      confidence: parsed.confidence || 1,
      domain_tags: parsed.domain_tags || [],
      rationale: parsed.rationale || '',
      recommended_action: parsed.recommended_action || 'ROUTE_ORCHESTRATOR',
      clarification_needed: parsed.clarification_needed || null,
    };
  } catch {
    return {
      complexity: 'COMPLEX',
      confidence: 1,
      domain_tags: [],
      rationale: 'JSON parse error — escalating',
      recommended_action: 'ROUTE_ORCHESTRATOR',
    };
  }
}

/**
 * Map classification to routing action.
 * Returns { assignTo, routingClass, needsReview }.
 */
function mapClassificationToRoute(classification, agentConfig) {
  const config = agentConfig.classification || {};
  const directThreshold = config.confidenceThresholdDirectResolve || 4;
  const routeThreshold = config.confidenceThresholdRoute || 3;

  // Low confidence → always escalate
  if (classification.confidence < routeThreshold) {
    return {
      assignTo: 'orchestrator',
      routingClass: 'COMPLEX',
      needsReview: false,
      reason: `Low confidence (${classification.confidence}) — escalating`,
    };
  }

  switch (classification.complexity) {
    case 'TRIVIAL':
      if (classification.confidence >= directThreshold) {
        // Per Linus: route ALL direct resolutions through reviewer
        return {
          assignTo: 'executor-triage',  // existing triage handles the actual classification
          routingClass: 'TRIVIAL',
          needsReview: true,
          reason: classification.rationale,
        };
      }
      // Below direct threshold, treat as MODERATE
      return {
        assignTo: 'executor-triage',
        routingClass: 'MODERATE',
        needsReview: false,
        reason: `TRIVIAL confidence below threshold (${classification.confidence})`,
      };

    case 'MODERATE':
      return {
        assignTo: 'executor-triage',
        routingClass: 'MODERATE',
        needsReview: false,
        reason: classification.rationale,
      };

    case 'COMPLEX':
      return {
        assignTo: 'orchestrator',
        routingClass: 'COMPLEX',
        needsReview: false,
        reason: classification.rationale,
      };

    case 'SPECIALIZED':
      return {
        assignTo: 'orchestrator',
        routingClass: 'SPECIALIZED',
        needsReview: false,
        needsClarification: true,
        clarification: classification.clarification_needed,
        reason: classification.rationale,
      };

    default:
      return {
        assignTo: 'orchestrator',
        routingClass: 'COMPLEX',
        needsReview: false,
        reason: 'Unknown complexity — escalating',
      };
  }
}

/**
 * Agent handler — called by AgentLoop.
 *
 * @param {Object} task - The claimed task event
 * @param {Object} context - Loaded context from context-loader
 * @param {Object} agent - Agent config
 * @returns {Object} { success, result, metadata }
 */
export default async function handler(task, context, agent) {
  const workItemId = task.work_item_id;

  // Step 0: Gmail label-based fast-path (zero cost, no DB lookup needed)
  // Calendar invites and promotional emails never need LLM classification
  if (context.email) {
    const labels = context.email.labels || [];
    const subject = context.email.subject || '';

    // Calendar invites → FYI (skip LLM entirely)
    if (/^(Invitation|Accepted|Updated invitation|Reminder):/i.test(subject)
        || labels.includes('CATEGORY_PERSONAL') && /\d{1,2}(am|pm)/i.test(subject)) {
      console.log(`[executor-intake] Fast-path: calendar invite "${subject}" → fyi`);
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          triage_result: { category: 'fyi', needs_strategist: false, quick_score: 0.95, pipeline: null },
          intake_classification: { complexity: 'TRIVIAL', confidence: 5, deterministic: true, rationale: 'Gmail label fast-path: calendar invite' },
        }), workItemId]
      );
      return {
        success: true,
        result: JSON.stringify({ classification: 'fyi', routing_class: 'TRIVIAL', action: 'label', deterministic: true }),
        metadata: { triage_result: { category: 'fyi', needs_strategist: false, quick_score: 0.95 }, cost_usd: 0 },
      };
    }

    // Promotions/Social → noise (skip LLM entirely)
    if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) {
      console.log(`[executor-intake] Fast-path: promotional/social "${subject}" → noise`);
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          triage_result: { category: 'noise', needs_strategist: false, quick_score: 0.99, pipeline: null },
          intake_classification: { complexity: 'TRIVIAL', confidence: 5, deterministic: true, rationale: 'Gmail label fast-path: promotions/social' },
        }), workItemId]
      );
      return {
        success: true,
        result: JSON.stringify({ classification: 'noise', routing_class: 'TRIVIAL', action: 'archive', deterministic: true }),
        metadata: { triage_result: { category: 'noise', needs_strategist: false, quick_score: 0.99 }, cost_usd: 0 },
      };
    }

    // Cold outreach / sales emails → noise (auto-archive, no reply)
    // Replying to cold outreach validates the sender and invites more follow-ups.
    // Detect via subject patterns common to unsolicited pitches and follow-ups.
    const coldOutreachSubjectPatterns = /\b(intro x|introduction x|quick intro|touching base|circle back|following up on my|had a chance to|take a look at my|not of interest|open to a conversation|love to connect|partnership opportunity|grow your|scale your|boost your)\b/i;
    if (coldOutreachSubjectPatterns.test(subject)) {
      // Check if sender is in inner circle — don't auto-archive known contacts
      const fromAddr = context.email.from_address || '';
      const contactR = await query(
        `SELECT tier FROM signal.contacts WHERE email_address = $1 LIMIT 1`,
        [fromAddr]
      ).catch(() => ({ rows: [] }));
      const tier = contactR.rows[0]?.tier;
      if (!tier || tier === 'unknown' || tier === 'inbound_only') {
        console.log(`[executor-intake] Fast-path: cold outreach "${subject}" from ${fromAddr} (tier=${tier || 'unknown'}) → noise`);
        await query(
          `UPDATE agent_graph.work_items
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({
            triage_result: { category: 'noise', needs_strategist: false, quick_score: 0.90, pipeline: null, cold_outreach: true },
            intake_classification: { complexity: 'TRIVIAL', confidence: 4, deterministic: true, rationale: `Cold outreach subject pattern: "${subject}"` },
          }), workItemId]
        );
        return {
          success: true,
          result: JSON.stringify({ classification: 'noise', routing_class: 'TRIVIAL', action: 'archive', deterministic: true, cold_outreach: true }),
          metadata: { triage_result: { category: 'noise', needs_strategist: false, quick_score: 0.90, cold_outreach: true }, cost_usd: 0 },
        };
      }
    }

    // Noreply/automated senders → FYI signal, never draft a reply
    // These are notifications (Google Drive shares, GitHub, CI, etc.) that need awareness but not email responses
    // Many automated senders DON'T use "noreply" — detect by address patterns AND known automated domains
    const fromAddress = context.email.from_address || '';
    const isAutomatedSender =
      // Explicit noreply addresses
      /noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster/i.test(fromAddress)
      // Generic automated prefixes (notifications@, alerts@, email@, etc.)
      || /^(drive-shares-dm-noreply|notifications?|alerts?|updates?|email|info|support|team|news|digest|hello|workspace-noreply)@/i.test(fromAddress)
      // Known automated sender domains (subdomain pattern: email.shopify.com, mail.google.com, etc.)
      || /^[^@]+@(email|mail|e|m|send|msg|notify)\.[^.]+\.(com|io|net|org)$/i.test(fromAddress)
      // Specific known automated senders
      || /\b(shopify\.com|googleusercontent\.com|google\.com|github\.com|linear\.app|vercel\.com|railway\.app|slack\.com|notion\.so|figma\.com|anthropic\.com|openai\.com|stripe\.com|hubspot\.com|calendly\.com|zoom\.us|tldv\.io|loom\.com|intercom\.io)\b/i.test(fromAddress.split('@')[1] || '');
    if (isAutomatedSender) {
      // Extract signal info (who shared what, etc.) from subject
      const isActionable = /shared.*with you|assigned|mentioned|invited/i.test(subject);
      const category = isActionable ? 'fyi' : 'noise';
      console.log(`[executor-intake] Fast-path: noreply sender "${fromAddress}" → ${category}`);
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          triage_result: { category, needs_strategist: false, quick_score: 0.95, pipeline: null, no_reply: true },
          intake_classification: { complexity: 'TRIVIAL', confidence: 5, deterministic: true, rationale: `Noreply sender fast-path: ${fromAddress}` },
        }), workItemId]
      );
      return {
        success: true,
        result: JSON.stringify({ classification: category, routing_class: 'TRIVIAL', action: category === 'fyi' ? 'signal' : 'archive', deterministic: true }),
        metadata: { triage_result: { category, needs_strategist: false, quick_score: 0.95, no_reply: true }, cost_usd: 0 },
      };
    }
  }

  // Step 1: Check deterministic routes (zero LLM cost)
  const deterministicResult = await checkDeterministicRoutes(context);

  let classification;
  if (deterministicResult) {
    console.log(`[executor-intake] Deterministic match: ${deterministicResult.action} (${deterministicResult.rationale})`);
    classification = {
      complexity: deterministicResult.action === 'archive' ? 'TRIVIAL' : 'MODERATE',
      confidence: deterministicResult.confidence,
      domain_tags: deterministicResult.domain_tags,
      rationale: deterministicResult.rationale,
      recommended_action: deterministicResult.action === 'archive' ? 'RESOLVE_DIRECT' : 'ROUTE_MID_TIER',
      deterministic: true,
    };
  }
  // If no deterministic match, the LLM classification happens in the standard
  // AgentLoop flow — the handler result includes routing metadata that the
  // orchestrator uses for assignment.

  if (!classification) {
    // HEURISTIC PATH: subject-based classification when no deterministic route matches.
    // Logs classification method + signals for drift tracking (Liotta recommendation).
    // When LLM classification is fully wired, compare heuristic vs LLM category here.
    const emailSubject = context.email?.subject || '';
    const fromAddress = context.email?.from_address || '';
    const isQuestion = /\?|can you|could you|do you|would you/i.test(emailSubject);
    const defaultCategory = isQuestion ? 'needs_response' : 'action_required';

    // Drift tracking: store heuristic signals so we can later compare against LLM
    const heuristicSignals = {
      method: 'subject_heuristic',
      isQuestion,
      subjectLength: emailSubject.length,
      fromDomain: fromAddress.split('@')[1] || 'unknown',
      timestamp: new Date().toISOString(),
    };

    console.log(`[executor-intake] Heuristic path: "${emailSubject.slice(0, 60)}" → ${defaultCategory} (isQuestion=${isQuestion})`);

    await query(
      `UPDATE agent_graph.work_items
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify({
        triage_result: {
          category: defaultCategory,
          needs_strategist: false,
          quick_score: 0.5,
          pipeline: null,
        },
        intake_classification: {
          method: 'heuristic',
          heuristic_category: defaultCategory,
          llm_category: null, // populated when LLM drift check runs
          drift: null,        // true/false after comparison
          signals: heuristicSignals,
        },
      }), workItemId]
    );

    return {
      success: true,
      result: JSON.stringify({ category: defaultCategory, routing_class: 'MODERATE', method: 'heuristic' }),
      metadata: {
        triage_result: { category: defaultCategory, needs_strategist: false, quick_score: 0.5 },
        intake_classification: { method: 'heuristic', heuristic_category: defaultCategory },
      },
    };
  }

  // Step 2: Map classification to routing
  const route = mapClassificationToRoute(classification, agent);

  // Step 3: Map classification to triage_result so orchestrator routes directly
  // (avoids delegating to executor-triage which causes duplicate processing)
  const category = classification.complexity === 'TRIVIAL' && classification.confidence >= 0.8 ? 'fyi'
    : classification.complexity === 'COMPLEX' || classification.complexity === 'SPECIALIZED' ? 'action_required'
    : 'needs_response';
  const needsStrategist = classification.complexity === 'COMPLEX' || classification.complexity === 'SPECIALIZED';

  await query(
    `UPDATE agent_graph.work_items
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify({
      triage_result: {
        category,
        needs_strategist: needsStrategist,
        quick_score: classification.confidence || 0,
        pipeline: null,
      },
      intake_classification: classification,
      routing: {
        assigned_to: route.assignTo,
        routing_class: route.routingClass,
        needs_review: route.needsReview,
        domain_tags: classification.domain_tags,
      },
    }), workItemId]
  );

  // Step 4: For deterministic archive, mark as noise
  if (classification.deterministic && classification.recommended_action === 'RESOLVE_DIRECT') {
    return {
      success: true,
      result: JSON.stringify({
        classification: 'noise',
        routing_class: 'TRIVIAL',
        action: 'archive',
        deterministic: true,
      }),
      metadata: {
        intake_classification: classification,
        routing: route,
        cost_usd: 0,  // Zero LLM cost
      },
    };
  }

  return {
    success: true,
    result: JSON.stringify(classification),
    metadata: {
      intake_classification: classification,
      routing: route,
    },
  };
}

/**
 * Build the classification prompt for the LLM call.
 */
function buildClassificationPrompt(context) {
  const parts = ['Classify this inbound request.\n'];

  if (context.email) {
    parts.push(`FROM: ${context.email.from_address || 'unknown'}`);
    parts.push(`SUBJECT: ${context.email.subject || '(no subject)'}`);
    if (context.email.snippet) parts.push(`PREVIEW: ${context.email.snippet}`);
  }

  if (context.workItem) {
    parts.push(`\nTASK TYPE: ${context.workItem.type}`);
    if (context.workItem.title) parts.push(`TITLE: ${context.workItem.title}`);
  }

  parts.push(`\nRespond with a JSON classification record. Do not include anything else.`);

  return parts.join('\n');
}

export const intakeLoop = new AgentLoop('executor-intake', handler);

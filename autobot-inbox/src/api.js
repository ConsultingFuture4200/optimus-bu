import { createServer } from 'http';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { query } from './db.js';
import { emitHalt, clearHalt, onAnyEvent } from './runtime/event-bus.js';
import { getAuthUrl, exchangeCode, clearAuthCache, getAuthForAccount } from './gmail/auth.js';
import { approveDraft as approveViaDispatcher, sendDraft as sendViaDispatcher } from './comms/sender.js';
import { encryptCredentials } from './runtime/credentials.js';
import { google } from 'googleapis';
import { publishEvent, logCommsIntent } from './runtime/infrastructure.js';
import { registerGateRoutes } from './api-routes/gates.js';
import { registerFinanceRoutes } from './api-routes/finance.js';
import { registerAuditRoutes } from './api-routes/audit.js';
import { registerConstitutionalRoutes } from './api-routes/constitutional.js';
import { registerPhaseRoutes } from './api-routes/phase.js';
import { registerDistributionRoutes } from './api-routes/distribution.js';
import { registerValueRoutes } from './api-routes/value.js';
import { registerGovernanceRoutes } from './api-routes/governance.js';
import { registerPublicArchiveRoutes } from './api-routes/public-archive.js';
import { registerResearchRoutes } from './api-routes/research.js';
import { registerRedesignRoutes } from './api-routes/redesign.js';
import { registerIntentRoutes } from './api-routes/intents.js';
import { registerBlueprintRoutes } from './api-routes/blueprint.js';
import { registerSpecGraphRoutes } from './api-routes/spec-graph.js';
import { registerCampaignRoutes } from './api-routes/campaigns.js';
import { registerProjectRoutes } from './api-routes/projects.js';
import { registerTriageRoutes } from './api-routes/triage.js';
import { registerActivityRoutes } from './api-routes/activity.js';
import { registerTraceRoutes } from './api-routes/traces.js';
import { registerPipelineRoutes } from './api-routes/pipeline.js';
import { registerCronRoutes } from './api-routes/cron.js';
import { registerAgentRoutes } from './api-routes/agents.js';
import { registerRunRoutes } from './api-routes/runs.js';
import { registerDocumentRoutes } from './api-routes/documents.js';
import { registerSearchRoutes } from './api-routes/search.js';
import { registerBoardAuthRoutes } from './api-routes/board-auth.js';
import { registerBoardRoutes } from './api-routes/board.js';
import { collectPhase1Metrics } from './runtime/phase1-metrics.js';
import { bootstrapSentEmails } from './gmail/sent-analyzer.js';
import { syncGoogleContacts } from './gmail/contacts-sync.js';
import { buildGlobalProfile, buildRecipientProfiles, rebuildAllProfiles } from './voice/profile-builder.js';
import { generateEmbeddings, hasEmbeddingProvider } from './voice/embeddings.js';
import { recordEditDelta } from './voice/edit-tracker.js';

const webhookSources = JSON.parse(
  readFileSync(new URL('../config/webhook-sources.json', import.meta.url), 'utf-8')
);

// CORS: localhost defaults + optional ALLOWED_ORIGINS env var (comma-separated)
const ALLOWED_ORIGINS = new Set([
  'http://localhost', 'http://localhost:3100', 'http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1', 'http://127.0.0.1:3100', 'http://127.0.0.1:3000',
  'https://staqs.io', 'https://www.staqs.io', 'https://inbox.staqs.io', 'https://board.staqs.io', 'https://preview.staqs.io',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : []),
]);

// In-memory cache to avoid PGlite contention on dashboard page loads.
// PGlite is single-connection WASM — agent loop queries block API queries.
// Cache dashboard reads for a short TTL so pages load instantly.
// When PGlite is busy (agents processing emails), queries queue indefinitely.
// The timeout races PGlite against a deadline and serves stale data on timeout.
const _cache = new Map();
const CACHE_TTL_MS = 300_000; // 5 minutes — PGlite single-thread means frequent cache misses hang
const QUERY_TIMEOUT_MS = 5_000; // 5s — first-load timeout (before stale data exists)
const BG_REFRESH_TIMEOUT_MS = 15_000; // 15s — background refresh has more time (stale data shown while waiting)

function cachedQuery(key, queryFn, ttlMs = CACHE_TTL_MS) {
  const entry = _cache.get(key);
  const now = Date.now();

  // Fresh cache hit — serve immediately
  if (entry?.data && now - entry.ts < ttlMs) {
    return Promise.resolve(entry.data);
  }

  // Stale-while-revalidate: if we have stale data, serve it instantly
  // and kick off a background refresh. User never waits for PGlite.
  if (entry?.data) {
    if (!entry.pending) {
      _refreshInBackground(key, queryFn);
    }
    return Promise.resolve(entry.data);
  }

  // No cached data at all (first load) — must wait for PGlite
  if (entry?.pending) return entry.pending;
  return _refreshAndWait(key, queryFn);
}

/** Background refresh: fire-and-forget with timeout. Updates cache on success. */
function _refreshInBackground(key, queryFn) {
  const queryPromise = queryFn();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('query_timeout')), BG_REFRESH_TIMEOUT_MS)
  );
  const pending = Promise.race([queryPromise, timeoutPromise]).then(data => {
    _cache.set(key, { data, ts: Date.now(), pending: null });
  }).catch(() => {
    // Background refresh failed — stale data persists, no user impact
    const stale = _cache.get(key);
    if (stale) stale.pending = null;
  });
  const existing = _cache.get(key);
  _cache.set(key, { ...(existing || {}), pending });
}

/** First-load wait: block until PGlite responds or timeout. */
function _refreshAndWait(key, queryFn) {
  const queryPromise = queryFn();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('query_timeout')), QUERY_TIMEOUT_MS)
  );
  const pending = Promise.race([queryPromise, timeoutPromise]).then(data => {
    _cache.set(key, { data, ts: Date.now(), pending: null });
    return data;
  }).catch(() => {
    const stale = _cache.get(key);
    if (stale) stale.pending = null;
    return null;
  });
  _cache.set(key, { pending });
  return pending;
}

function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  // Only set Allow-Origin for known origins; omit for unknown (browser blocks)
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// Legacy Bearer token auth (timing-safe to prevent oracle attacks)
function requireLegacyAuth(req) {
  const secret = process.env.API_SECRET;
  if (!secret) return false; // P1: deny by default — require API_SECRET to be configured
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Unified auth resolver — supports board JWT, agent JWT, and legacy Bearer.
 * Attaches req.auth = { sub, role, source, scope, github_username } on success.
 * Returns true if authenticated, false otherwise.
 *
 * Three modes (no fallthrough between JWT and legacy to prevent timing oracle):
 *   1. JWT with iss: 'optimus-board' → board member
 *   2. JWT with iss: 'optimus-agent' → internal agent
 *   3. Legacy Bearer API_SECRET → backward compat
 */
async function resolveAuth(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;

  const token = auth.slice(7);

  // Detect JWT format (three dot-separated parts) vs opaque Bearer
  const isJwt = token.split('.').length === 3;

  if (isJwt) {
    // Try board JWT first (separate keypair, iss: 'optimus-board')
    try {
      const { verifyBoardToken } = await import('./runtime/board-jwt.js');
      const claims = await verifyBoardToken(token);
      req.auth = {
        sub: claims.sub,
        role: 'board',
        source: 'jwt',
        scope: claims.scope || ['*'],
        github_username: claims.github_username,
        jti: claims.jti,
      };
      return true;
    } catch {
      // Not a valid board token — try agent token
    }

    try {
      const { verifyAgentToken } = await import('./runtime/agent-jwt.js');
      const claims = verifyAgentToken(token);
      req.auth = {
        sub: claims.sub,
        role: claims.tier || 'agent',
        source: 'agent_jwt',
        scope: ['*'], // internal agents have full scope
        github_username: null,
      };
      return true;
    } catch {
      // Not a valid agent token either
      return false;
    }
  }

  // Opaque Bearer — legacy API_SECRET
  if (requireLegacyAuth(req)) {
    req.auth = {
      sub: 'legacy',
      role: 'board',
      source: 'api_secret',
      scope: ['*'],
      github_username: req.headers?.['x-board-user'] || null,
    };
    return true;
  }

  return false;
}

// Backward compat wrapper — existing code calls requireAuth(req)
function requireAuth(req) {
  // Sync check for legacy Bearer only (resolveAuth is async and used in the main handler)
  return requireLegacyAuth(req);
}

/**
 * Check if req.auth has the required scope.
 * Scope '*' is wildcard (admin/legacy). Returns true/false.
 */
function requireScope(req, scope) {
  if (!req.auth) return false;
  if (req.auth.scope.includes('*')) return true;
  return req.auth.scope.includes(scope);
}

// Routes that are explicitly public (no auth required) — P1 inverted: opt-in exemption
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/auth/github',
  'GET /api/auth/github/callback',
  'GET /api/auth/gmail-url',       // OAuth flow start — can't be authed yet
  'GET /api/auth/gmail-callback',  // OAuth callback from Google
  'POST /api/webhooks/tldv',       // TLDv webhook uses its own query-param secret auth
]);

/**
 * Lightweight HTTP API that bridges PGlite → dashboard.
 * Replaces Supabase client calls with direct PGlite queries.
 * No Express — just http.createServer (P4: boring infrastructure).
 */

const routes = new Map();

// GET /api/briefing — daily briefing + latest briefing content
// Single query with all counts to minimize PGlite connection time.
routes.set('GET /api/briefing', async () => {
  const result = await cachedQuery('briefing', async () => {
    const stats = await query(`
      SELECT
        CURRENT_DATE AS briefing_date,
        (SELECT COUNT(*) FROM inbox.messages WHERE received_at >= CURRENT_DATE) AS emails_received_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE processed_at >= CURRENT_DATE) AS emails_triaged_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'action_required' AND processed_at >= CURRENT_DATE) AS action_required_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'needs_response' AND processed_at >= CURRENT_DATE) AS needs_response_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'pending') AS emails_awaiting_triage,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at >= CURRENT_DATE) AS drafts_created_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'approved' AND acted_at >= CURRENT_DATE) AS drafts_approved_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'edited' AND acted_at >= CURRENT_DATE) AS drafts_edited_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'rejected' AND acted_at >= CURRENT_DATE) AS drafts_rejected_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NULL AND reviewer_verdict IS NOT NULL) AS drafts_awaiting_review,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NOT NULL AND acted_at >= CURRENT_DATE - interval '14 days') AS drafts_reviewed_14d,
        0 AS edit_rate_14d_pct,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE) AS cost_today_usd,
        (SELECT allocated_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start <= CURRENT_DATE AND period_end >= CURRENT_DATE LIMIT 1) AS budget_today_usd,
        0 AS upcoming_deadlines
    `);
    // Latest briefing from signal.briefings
    const briefingResult = await query(
      `SELECT * FROM signal.briefings ORDER BY briefing_date DESC LIMIT 1`
    );

    // Recent drafts awaiting review (with summary/intent for quick overview)
    const pendingDrafts = await query(
      `SELECT d.id, d.email_summary, d.draft_intent, d.reviewer_verdict, d.tone_score, d.created_at,
              m.from_address, m.from_name, m.subject, m.channel, a.label AS account_label
       FROM agent_graph.action_proposals d
       JOIN inbox.messages m ON m.id = d.message_id
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE d.action_type = 'email_draft' AND d.board_action IS NULL AND d.reviewer_verdict IS NOT NULL
       ORDER BY d.created_at ASC LIMIT 5`
    );

    // Recent action-required emails (not yet drafted)
    const actionEmails = await query(
      `SELECT m.id, m.from_address, m.from_name, m.subject, m.snippet, m.received_at, m.priority_score,
              m.channel, a.label AS account_label
       FROM inbox.messages m
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE m.triage_category = 'action_required'
         AND NOT EXISTS (SELECT 1 FROM agent_graph.action_proposals d WHERE d.message_id = m.id AND d.action_type = 'email_draft')
       ORDER BY m.received_at DESC LIMIT 5`
    );

    return {
      stats: stats.rows[0] || null,
      briefing: briefingResult.rows[0] || null,
      pendingDrafts: pendingDrafts.rows,
      actionEmails: actionEmails.rows,
    };
  }, 15_000);
  return result || { stats: null, briefing: null, pendingDrafts: [], actionEmails: [] };
});

// GET /api/drafts — pending drafts with email join
routes.set('GET /api/drafts', async () => {
  const result = await cachedQuery('drafts', async () => {
    const r = await query(
      `SELECT d.*,
              json_build_object(
                'from_address', m.from_address,
                'from_name', m.from_name,
                'subject', m.subject,
                'triage_category', m.triage_category,
                'snippet', m.snippet,
                'received_at', m.received_at,
                'priority_score', m.priority_score,
                'channel', m.channel,
                'account_label', a.label
              ) AS emails
       FROM agent_graph.action_proposals d
       JOIN inbox.messages m ON m.id = d.message_id
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE d.action_type = 'email_draft' AND d.board_action IS NULL
       ORDER BY d.created_at DESC`
    );
    return { drafts: r.rows };
  }, 15_000);
  return result || { drafts: [] };
});

// Log board member actions to activity feed (shared activity stream)
async function logBoardAction(action, draftId, actedBy, metadata = {}) {
  try {
    await query(
      `INSERT INTO agent_graph.agent_activity_steps
       (agent_id, step_type, description, status, completed_at, metadata)
       VALUES ($1, 'decision', $2, 'completed', now(), $3)`,
      [
        actedBy || 'board',
        `Board ${action}: draft ${draftId}`,
        JSON.stringify({ draft_id: draftId, action, acted_by: actedBy, ...metadata }),
      ]
    );
  } catch { /* non-critical — don't block approval */ }
}

// Self-approval prevention (Linus): external agents cannot approve their own proposals
async function checkSelfApproval(req, proposalId) {
  if (req.auth?.role === 'external_agent' || req.auth?.sub?.startsWith('nemoclaw-')) {
    const proposal = await query(
      'SELECT created_by FROM agent_graph.action_proposals WHERE id = $1', [proposalId]
    );
    const createdBy = proposal.rows[0]?.created_by;
    if (createdBy && (createdBy === req.auth.sub || createdBy === req.auth.github_username)) {
      throw Object.assign(new Error('Cannot approve your own proposal'), { statusCode: 403 });
    }
  }
}

// POST /api/drafts/:id/approve
routes.set('POST /api/drafts/approve', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  await checkSelfApproval(req, id);
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || body.acted_by || null;
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2, send_state = 'approved' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };

  await logBoardAction('approved', id, acted_by);
  await publishEvent('draft_approved', `Draft ${id} approved by board`, null, null, { draft_id: id });

  // Create platform draft via channel-aware dispatcher (email→Gmail draft, Slack→no-op)
  try {
    const result = await approveViaDispatcher(id);
    return { ok: true, platformDraftId: result.platformDraftId, channel: result.channel, note: result.channel === 'slack' ? 'Approved. Send to deliver Slack message.' : 'Draft created in Gmail — open Gmail to review and send.' };
  } catch (err) {
    console.error(`[api] Failed to create platform draft for ${id}:`, err.message);
    return { ok: true, platformDraftId: null, note: 'Approved but platform draft creation failed: ' + err.message };
  }
});

// POST /api/drafts/send — approve and send in one step (board approval IS the L0 check)
routes.set('POST /api/drafts/send', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || body.acted_by || null;

  // Approve the draft
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2, send_state = 'approved' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };

  await logBoardAction('sent', id, acted_by);

  // Send via channel-aware dispatcher
  try {
    const sentId = await sendViaDispatcher(id);
    return { ok: true, sentId, note: 'Approved and sent.' };
  } catch (err) {
    console.error(`[api] Failed to send draft ${id}:`, err.message);
    return { ok: false, error: err.message, note: 'Approved but send failed.' };
  }
});

// POST /api/drafts/send-approved — send a previously approved draft
routes.set('POST /api/drafts/send-approved', async (_req, body) => {
  const { id } = body;

  try {
    const sentId = await sendViaDispatcher(id);
    return { ok: true, sentId };
  } catch (err) {
    console.error(`[api] Failed to send approved draft ${id}:`, err.message);
    return { ok: false, error: err.message };
  }
});

// POST /api/drafts/:id/reject
routes.set('POST /api/drafts/reject', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || body.acted_by || null;
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'rejected', acted_at = now(), acted_by = $2, send_state = 'cancelled' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };
  await logBoardAction('rejected', id, acted_by);
  await publishEvent('draft_reviewed', `Draft ${id} rejected by board`, null, null, { draft_id: id, action: 'rejected' });
  return { ok: true };
});

// POST /api/drafts/:id/edit — edit-then-approve (records edit delta)
routes.set('POST /api/drafts/edit', async (_req, body) => {
  _cache.delete('drafts');
  const { id, editedBody, notes } = body;

  // Get original draft + email context for edit delta
  const original = await query(
    `SELECT d.body, d.message_id, d.subject, d.to_addresses,
            m.from_address, m.triage_category
     FROM agent_graph.action_proposals d
     JOIN inbox.messages m ON m.id = d.message_id
     WHERE d.id = $1`,
    [id]
  );
  if (original.rows.length === 0) return { error: 'Draft not found' };

  const row = original.rows[0];
  const originalBody = row.body;

  // Update draft with edited version
  await query(
    `UPDATE agent_graph.action_proposals
     SET board_action = 'edited',
         board_edited_body = $1,
         board_notes = $2,
         acted_at = now(),
         send_state = 'approved'
     WHERE id = $3`,
    [editedBody, notes || null, id]
  );

  // Record edit delta via edit-tracker (D4: most valuable data in the system)
  // Uses proper diff computation, edit type classification, and magnitude calculation
  await recordEditDelta({
    draftId: id,
    emailId: row.message_id,
    originalBody,
    editedBody,
    recipient: row.from_address,
    subject: row.subject,
    triageCategory: row.triage_category,
  });

  // Create platform draft with edited body via dispatcher (L0: draft-only, D2/G5)
  try {
    const result = await approveViaDispatcher(id);
    return { ok: true, platformDraftId: result.platformDraftId, channel: result.channel, note: 'Edited draft created.' };
  } catch (err) {
    console.error(`[api] Failed to create platform draft for ${id}:`, err.message);
    return { ok: true, platformDraftId: null, note: 'Approved but platform draft creation failed: ' + err.message };
  }
});

// GET /api/emails/body — fetch email body on-demand from Gmail (D1: metadata-only storage)
routes.set('GET /api/emails/body', async (req) => {
  const url = new URL(req.url, `http://localhost`);
  const emailId = url.searchParams.get('id');
  if (!emailId) return { error: 'Missing ?id= parameter' };

  const result = await query(
    `SELECT provider_msg_id, snippet, account_id, channel FROM inbox.messages WHERE id = $1`,
    [emailId]
  );
  if (result.rows.length === 0) return { error: 'Email not found' };

  const { provider_msg_id, snippet, account_id, channel } = result.rows[0];

  // Non-email channels don't have provider bodies — return snippet
  if (channel !== 'email' || !provider_msg_id) {
    return { body: snippet, snippet, channel };
  }

  try {
    const { fetchEmailBody } = await import('./gmail/client.js');
    const body = await fetchEmailBody(provider_msg_id, account_id);
    return { body, snippet, channel };
  } catch (err) {
    return { body: null, snippet, channel, error: err.message };
  }
});

// POST /api/drafts/bulk — batch approve/send/reject multiple drafts
routes.set('POST /api/drafts/bulk', async (req, body) => {
  _cache.delete('drafts');
  const { ids, action } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || body.acted_by || null;
  const VALID_ACTIONS = new Set(['approve', 'send', 'reject']);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !action || !VALID_ACTIONS.has(action)) {
    return { error: 'Invalid request: ids must be 1-100 items with a valid action (approve/send/reject)' };
  }

  const results = [];
  for (const id of ids) {
    try {
      if (action === 'reject') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'rejected', acted_at = now(), acted_by = $2,
           send_state = 'cancelled' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        results.push({ id, ok: true });
      } else if (action === 'approve') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2,
           send_state = 'approved' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        await logBoardAction('approved', id, acted_by);
        try {
          const result = await approveViaDispatcher(id);
          results.push({ id, ok: true, platformDraftId: result.platformDraftId, channel: result.channel });
        } catch (err) {
          results.push({ id, ok: true, platformDraftId: null, error: err.message });
        }
      } else if (action === 'send') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2,
           send_state = 'approved' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        try {
          const sentId = await sendViaDispatcher(id);
          results.push({ id, ok: true, sentId });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return { results, processed: results.length };
});

// GET /api/signals/feed — signals grouped by message with draft status + contact info
routes.set('GET /api/signals/feed', async () => {
  const result = await cachedQuery('signals_feed', async () => {
    const feed = await query(`
      SELECT
        m.id AS message_id,
        m.from_address, m.from_name, m.subject, m.snippet,
        m.triage_category, m.priority_score, m.received_at,
        m.channel, a.label AS account_label,
        CASE WHEN m.channel = 'webhook' THEN
          (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
        END AS webhook_source,
        json_agg(json_build_object(
          'id', s.id, 'signal_type', s.signal_type,
          'content', s.content, 'confidence', s.confidence,
          'due_date', s.due_date, 'resolved', s.resolved
        ) ORDER BY s.due_date ASC NULLS LAST) AS signals,
        CASE
          WHEN bool_or(s.resolved) THEN 'resolved'
          WHEN EXISTS (SELECT 1 FROM agent_graph.action_proposals ap2
            WHERE ap2.message_id = m.id
            AND (ap2.send_state IN ('delivered','cancelled') OR ap2.action_type = 'ticket_create'))
          THEN 'actioned'
          WHEN EXISTS (SELECT 1 FROM agent_graph.action_proposals ap2
            WHERE ap2.message_id = m.id AND ap2.send_state = 'pending')
          THEN 'in_progress'
          ELSE 'open'
        END AS computed_status,
        ap_agg.actions,
        c.name AS contact_name, c.contact_type,
        c.is_vip
      FROM inbox.signals s
      JOIN inbox.messages m ON m.id = s.message_id
      LEFT JOIN inbox.accounts a ON a.id = m.account_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id', ap.id, 'action_type', ap.action_type,
          'send_state', ap.send_state,
          'reviewer_verdict', ap.reviewer_verdict,
          'board_action', ap.board_action,
          'tone_score', ap.tone_score,
          'email_summary', ap.email_summary,
          'draft_intent', ap.draft_intent,
          'linear_issue_url', ap.linear_issue_url,
          'github_issue_url', ap.github_issue_url,
          'github_issue_number', ap.github_issue_number,
          'github_pr_number', ap.github_pr_number,
          'github_pr_url', ap.github_pr_url,
          'target_repo', ap.target_repo,
          'created_at', ap.created_at
        ) ORDER BY ap.created_at DESC) AS actions
        FROM agent_graph.action_proposals ap
        WHERE ap.message_id = m.id
      ) ap_agg ON true
      LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
      WHERE s.resolved = false
      GROUP BY m.id, m.from_address, m.from_name, m.subject, m.snippet,
               m.triage_category, m.priority_score, m.received_at,
               m.channel, m.labels, a.label,
               ap_agg.actions,
               c.name, c.contact_type, c.is_vip
      ORDER BY c.is_vip DESC NULLS LAST,
               m.priority_score DESC NULLS LAST,
               m.received_at DESC
    `);
    return { feed: feed.rows };
  }, 15_000);
  return result || { feed: [] };
});

// POST /api/signals/resolve — mark signals as resolved
routes.set('POST /api/signals/resolve', async (_req, body) => {
  _cache.delete('signals_feed');
  _cache.delete('signals');
  _cache.delete('today');

  const { id, ids, messageId } = body;
  if (messageId) {
    const r = await query(
      `UPDATE inbox.signals SET resolved = true, resolved_at = now() WHERE message_id = $1 AND resolved = false`,
      [messageId]
    );
    return { ok: true, resolved: r.rowCount };
  }
  const idList = ids || (id ? [id] : []);
  if (idList.length === 0) return { ok: false, error: 'Provide id, ids, or messageId' };
  const r = await query(
    `UPDATE inbox.signals SET resolved = true, resolved_at = now() WHERE id = ANY($1) AND resolved = false`,
    [idList]
  );
  return { ok: true, resolved: r.rowCount };
});

// POST /api/signals/unresolve — undo signal resolution (5s undo window)
routes.set('POST /api/signals/unresolve', async (_req, body) => {
  _cache.delete('signals_feed');
  _cache.delete('signals');
  _cache.delete('today');

  const { id, ids, messageId } = body;
  if (messageId) {
    const r = await query(
      `UPDATE inbox.signals SET resolved = false, resolved_at = NULL WHERE message_id = $1 AND resolved = true`,
      [messageId]
    );
    return { ok: true, unresolved: r.rowCount };
  }
  const idList = ids || (id ? [id] : []);
  if (idList.length === 0) return { ok: false, error: 'Provide id, ids, or messageId' };
  const r = await query(
    `UPDATE inbox.signals SET resolved = false, resolved_at = NULL WHERE id = ANY($1) AND resolved = true`,
    [idList]
  );
  return { ok: true, unresolved: r.rowCount };
});

// POST /api/emails/archive — archive message + resolve all signals
routes.set('POST /api/emails/archive', async (_req, body) => {
  _cache.delete('signals_feed');
  _cache.delete('signals');
  _cache.delete('today');

  const { messageId } = body;
  if (!messageId) return { ok: false, error: 'Provide messageId' };

  const archiveResult = await query(
    `UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
    [messageId]
  );
  const resolveResult = await query(
    `UPDATE inbox.signals SET resolved = true, resolved_at = now(),
       metadata = COALESCE(metadata, '{}'::jsonb) || '{"resolution_reason":"manual_archive"}'::jsonb
     WHERE message_id = $1 AND resolved = false`,
    [messageId]
  );
  return { ok: true, archived: archiveResult.rowCount, resolved: resolveResult.rowCount };
});

// POST /api/emails/unarchive — undo archive + unresolve signals resolved by archive
routes.set('POST /api/emails/unarchive', async (_req, body) => {
  _cache.delete('signals_feed');
  _cache.delete('signals');
  _cache.delete('today');

  const { messageId } = body;
  if (!messageId) return { ok: false, error: 'Provide messageId' };

  await query(
    `UPDATE inbox.messages SET archived_at = NULL WHERE id = $1`,
    [messageId]
  );
  const unresolveResult = await query(
    `UPDATE inbox.signals SET resolved = false, resolved_at = NULL,
       metadata = metadata - 'resolution_reason'
     WHERE message_id = $1 AND resolved = true AND metadata->>'resolution_reason' = 'manual_archive'`,
    [messageId]
  );
  return { ok: true, unresolved: unresolveResult.rowCount };
});

// POST /api/signals/feedback — record signal accuracy feedback (ADR-014, D4 append-only)
routes.set('POST /api/signals/feedback', async (_req, body) => {
  const { signalId, verdict, correction, source } = body;
  if (!signalId || !verdict) return { ok: false, error: 'Provide signalId and verdict' };
  if (!['correct', 'incorrect', 'partial'].includes(verdict)) {
    return { ok: false, error: 'verdict must be correct, incorrect, or partial' };
  }
  await query(
    `INSERT INTO signal.feedback (signal_id, verdict, correction, source)
     VALUES ($1, $2, $3, $4)`,
    [signalId, verdict, correction ? JSON.stringify(correction) : null, source || 'dashboard']
  );
  return { ok: true };
});

// GET /api/signals/feedback/metrics — signal accuracy metrics for v1.0 tracking
routes.set('GET /api/signals/feedback/metrics', async () => {
  const result = await cachedQuery('feedback_metrics', async () => {
    const metrics = await query(`SELECT * FROM signal.v_feedback_metrics`);
    return metrics.rows[0] || {};
  }, 60_000);
  return result || {};
});

// GET /api/signals — signals, contacts, topics
routes.set('GET /api/signals', async () => {
  const result = await cachedQuery('signals', async () => {
    const signals = await query(
      `SELECT s.*,
              json_build_object(
                'from_address', m.from_address,
                'subject', m.subject,
                'channel', m.channel,
                'account_label', a.label
              ) AS emails
       FROM inbox.signals s
       JOIN inbox.messages m ON m.id = s.message_id
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE s.resolved = false
       ORDER BY s.due_date ASC NULLS LAST`
    );
    const contacts = await query(
      `SELECT * FROM signal.contacts ORDER BY emails_received DESC, (metadata->>'google_contact')::boolean DESC NULLS LAST`
    );
    const topics = await query(
      `SELECT * FROM signal.topics ORDER BY trend_score DESC LIMIT 10`
    );
    return { signals: signals.rows, contacts: contacts.rows, topics: topics.rows };
  }, 15_000);
  return result || { signals: [], contacts: [], topics: [] };
});

// GET /api/today — OWE / WAITING / CONNECT dashboard data (ADR-014)
// ?owner=username filters to a specific board member's accounts
routes.set('GET /api/today', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const ownerFilter = url.searchParams.get('owner');
  // Validate owner is a safe GitHub username (alphanumeric + hyphens only)
  const safeOwner = ownerFilter && /^[a-zA-Z0-9_-]+$/.test(ownerFilter) ? ownerFilter : null;
  const cacheKey = safeOwner ? `today:${safeOwner}` : 'today';
  const result = await cachedQuery(cacheKey, async () => {
    const ownerCondition = safeOwner ? 'AND a.owner = $1' : '';
    const ownerParams = safeOwner ? [safeOwner] : [];
    // OWE: signals where someone expects something from the user (inbound)
    const owe = await query(`
      SELECT s.id, s.signal_type, s.content, s.confidence, s.due_date, s.direction, s.domain,
             s.created_at, s.message_id,
             m.from_address, m.from_name, m.subject, m.received_at, m.channel,
             CASE WHEN m.channel = 'webhook' THEN
               (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
             END AS webhook_source,
             c.contact_type, c.is_vip, c.tier,
             a.label AS account_label, a.owner AS account_owner
      FROM inbox.signals s
      JOIN inbox.messages m ON m.id = s.message_id
      LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
      LEFT JOIN inbox.accounts a ON a.id = m.account_id
      WHERE s.resolved = false AND s.direction = 'inbound' ${ownerCondition}
      ORDER BY
        CASE WHEN s.due_date < now() THEN 0 ELSE 1 END,
        s.due_date ASC NULLS LAST,
        m.priority_score DESC NULLS LAST,
        s.created_at DESC
    `, ownerParams);

    // WAITING: signals where the user expects something from someone (outbound)
    const waiting = await query(`
      SELECT s.id, s.signal_type, s.content, s.confidence, s.due_date, s.direction, s.domain,
             s.created_at, s.message_id, s.metadata,
             m.from_address, m.from_name, m.subject, m.received_at, m.channel,
             CASE WHEN m.channel = 'webhook' THEN
               (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
             END AS webhook_source,
             c.contact_type, c.is_vip, c.tier,
             a.label AS account_label
      FROM inbox.signals s
      JOIN inbox.messages m ON m.id = s.message_id
      LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
      LEFT JOIN inbox.accounts a ON a.id = m.account_id
      WHERE s.resolved = false AND s.direction = 'outbound' ${ownerCondition}
      ORDER BY s.created_at ASC
    `, ownerParams);

    // CONNECT: contacts with decaying relationship strength, coldest first
    const connect = await query(`
      SELECT v.*, c.vip_reason, c.notes
      FROM signal.v_contact_strength v
      JOIN signal.contacts c ON c.id = v.id
      WHERE v.tier IN ('inner_circle', 'active')
        AND v.relationship_strength < 60
      ORDER BY v.relationship_strength ASC
      LIMIT 15
    `);

    // Summary stats (owner-filtered when in personal view)
    const statsOwnerJoin = safeOwner
      ? 'JOIN inbox.messages m ON m.id = s.message_id LEFT JOIN inbox.accounts a ON a.id = m.account_id'
      : '';
    const statsOwnerWhere = safeOwner ? 'AND a.owner = $1' : '';
    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM inbox.signals s ${statsOwnerJoin} WHERE s.resolved = false AND s.direction = 'inbound' ${statsOwnerWhere}) AS owe_count,
        (SELECT COUNT(*) FROM inbox.signals s ${statsOwnerJoin} WHERE s.resolved = false AND s.direction = 'outbound' ${statsOwnerWhere}) AS waiting_count,
        (SELECT COUNT(*) FROM inbox.signals s ${statsOwnerJoin} WHERE s.resolved = false AND s.due_date < now() ${statsOwnerWhere}) AS overdue_count,
        (SELECT COUNT(*) FROM inbox.signals s ${statsOwnerJoin} WHERE s.resolved = false AND s.due_date BETWEEN now() AND now() + interval '7 days' ${statsOwnerWhere}) AS due_this_week
    `, ownerParams);

    return {
      owe: owe.rows,
      waiting: waiting.rows,
      connect: connect.rows,
      stats: stats.rows[0] || { owe_count: 0, waiting_count: 0, overdue_count: 0, due_this_week: 0 },
    };
  }, 15_000);
  return result || { owe: [], waiting: [], connect: [], stats: {} };
});

// GET /api/metrics — Phase 1 success metrics (spec §14: all 13 targets)
// v_phase1_metrics has 13 subqueries — use a longer timeout and cache aggressively.
routes.set('GET /api/metrics', async () => {
  const result = await cachedQuery('metrics', async () => {
    const metrics = await query(`SELECT * FROM agent_graph.v_phase1_metrics`);
    return { metrics: metrics.rows[0] || null };
  }, 120_000); // 2 min cache — metrics don't change fast
  return result || { metrics: null };
});

// GET /api/stats — agent activity, budget, cost history
// Single query for agent activity (replaces v_agent_activity's 30 correlated subqueries).
routes.set('GET /api/stats', async () => {
  const result = await cachedQuery('stats', async () => {
    const agents = await query(`
      SELECT ac.id AS agent_id, ac.agent_type, ac.model,
        COALESCE(li.calls_today, 0) AS calls_today,
        COALESCE(li.cost_today_usd, 0) AS cost_today_usd,
        COALESCE(li.tokens_today, 0) AS tokens_today,
        COALESCE(wi_active.cnt, 0) AS active_tasks,
        COALESCE(wi_done.cnt, 0) AS completed_today
      FROM agent_graph.agent_configs ac
      LEFT JOIN (
        SELECT agent_id, COUNT(*) AS calls_today, SUM(cost_usd) AS cost_today_usd,
               SUM(input_tokens + output_tokens) AS tokens_today
        FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE GROUP BY agent_id
      ) li ON li.agent_id = ac.id
      LEFT JOIN (
        SELECT assigned_to, COUNT(*) AS cnt FROM agent_graph.work_items WHERE status = 'in_progress' GROUP BY assigned_to
      ) wi_active ON wi_active.assigned_to = ac.id
      LEFT JOIN (
        SELECT assigned_to, COUNT(*) AS cnt FROM agent_graph.work_items WHERE status = 'completed' AND updated_at >= CURRENT_DATE GROUP BY assigned_to
      ) wi_done ON wi_done.assigned_to = ac.id
      WHERE ac.is_active = true
    `);

    const budget = await query(`
      SELECT id, scope, scope_id, allocated_usd, spent_usd, reserved_usd,
        (allocated_usd - spent_usd - reserved_usd) AS remaining_usd,
        CASE WHEN allocated_usd > 0 THEN ROUND((spent_usd / allocated_usd) * 100, 2) ELSE 0 END AS utilization_pct,
        period_start, period_end
      FROM agent_graph.budgets WHERE period_end >= CURRENT_DATE
    `);

    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM inbox.messages WHERE received_at >= CURRENT_DATE) AS emails_received_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE processed_at >= CURRENT_DATE) AS emails_triaged_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'action_required' AND processed_at >= CURRENT_DATE) AS action_required_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'needs_response' AND processed_at >= CURRENT_DATE) AS needs_response_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'pending') AS emails_awaiting_triage,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at >= CURRENT_DATE) AS drafts_created_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NULL AND reviewer_verdict IS NOT NULL) AS drafts_awaiting_review,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'approved' AND updated_at >= CURRENT_DATE) AS drafts_approved_today,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE) AS cost_today_usd
    `);

    // Check halt status
    const haltResult = await query(
      `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const haltActive = haltResult.rows.length > 0;

    const statsRow = stats.rows[0] || {};
    statsRow.halt_active = haltActive;

    return { agents: agents.rows, budget: budget.rows, stats: statsRow, costHistory: [] };
  });
  return result || { agents: [], budget: [], stats: null, costHistory: [] };
});

// GET /api/events — SSE stream for real-time dashboard updates
// Combines heartbeat polling (stats every 5s) with pg_notify event forwarding.
routes.set('GET /api/events', async (req, _body, res) => {
  res.writeHead(200, {
    ...getCorsHeaders(req),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');

  // Forward pg_notify events to SSE clients in real-time
  let eventCleanup = null;
  try {
    const { onAnyEvent } = await import('../lib/runtime/event-bus.js');
    eventCleanup = onAnyEvent((event) => {
      try {
        const eventType = event.eventType || event.event_type || 'unknown';
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch { /* client disconnected */ }
    });
  } catch { /* event bus not available */ }

  // Heartbeat: poll for summary stats every 15s (pg_notify handles real-time events)
  const interval = setInterval(async () => {
    try {
      const briefingData = await cachedQuery('briefing', async () => {
        const s = await query(`SELECT * FROM signal.v_daily_briefing`);
        return { stats: s.rows[0] || null, briefing: null };
      });
      const pending = await cachedQuery('sse_pending', async () => {
        const p = await query(
          `SELECT COUNT(*) AS count FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND reviewer_verdict IS NOT NULL AND board_action IS NULL`
        );
        return parseInt(p.rows[0]?.count || '0');
      }, 10_000);
      // Pending HITL requests
      const hitlPending = await cachedQuery('sse_hitl', async () => {
        const h = await query(
          `SELECT COUNT(*) AS count FROM agent_graph.campaign_hitl_requests WHERE status = 'pending'`
        );
        return parseInt(h.rows[0]?.count || '0');
      }, 10_000);
      res.write(`event: heartbeat\ndata: ${JSON.stringify({
        type: 'heartbeat',
        stats: briefingData.stats,
        pendingDrafts: pending,
        pendingHitl: hitlPending,
      })}\n\n`);
    } catch {
      // ignore query errors during SSE
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(interval);
    if (eventCleanup) eventCleanup();
  });
  return '__sse__'; // signal to handler not to send JSON response
});

// GET /api/debug — safe predefined queries only (dev only, no arbitrary SQL)
// No string interpolation — each table maps to a hardcoded query.
const DEBUG_TABLE_QUERIES = {
  'agent_graph.work_items': 'SELECT * FROM agent_graph.work_items ORDER BY created_at DESC LIMIT $1',
  'agent_graph.task_events': 'SELECT * FROM agent_graph.task_events ORDER BY created_at DESC LIMIT $1',
  'agent_graph.state_transitions': 'SELECT * FROM agent_graph.state_transitions ORDER BY created_at DESC LIMIT $1',
  'agent_graph.agent_configs': 'SELECT * FROM agent_graph.agent_configs ORDER BY created_at DESC LIMIT $1',
  'agent_graph.budgets': 'SELECT * FROM agent_graph.budgets ORDER BY created_at DESC LIMIT $1',
  'agent_graph.llm_invocations': 'SELECT * FROM agent_graph.llm_invocations ORDER BY created_at DESC LIMIT $1',
  'agent_graph.halt_signals': 'SELECT * FROM agent_graph.halt_signals ORDER BY created_at DESC LIMIT $1',
  'inbox.messages': 'SELECT * FROM inbox.messages ORDER BY created_at DESC LIMIT $1',
  'inbox.drafts': 'SELECT * FROM agent_graph.action_proposals ORDER BY created_at DESC LIMIT $1',
  'agent_graph.action_proposals': 'SELECT * FROM agent_graph.action_proposals ORDER BY created_at DESC LIMIT $1',
  'inbox.signals': 'SELECT * FROM inbox.signals ORDER BY created_at DESC LIMIT $1',
  'signal.contacts': 'SELECT * FROM signal.contacts ORDER BY created_at DESC LIMIT $1',
  'signal.topics': 'SELECT * FROM signal.topics ORDER BY created_at DESC LIMIT $1',
  'signal.briefings': 'SELECT * FROM signal.briefings ORDER BY created_at DESC LIMIT $1',
  'voice.edit_deltas': 'SELECT * FROM voice.edit_deltas ORDER BY created_at DESC LIMIT $1',
};
routes.set('GET /api/debug', async (req) => {
  const url = new URL(req.url, `http://localhost`);
  const table = url.searchParams.get('table');
  const sql = DEBUG_TABLE_QUERIES[table];
  if (!sql) {
    return { error: `Use ?table= with one of: ${Object.keys(DEBUG_TABLE_QUERIES).join(', ')}` };
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  const result = await query(sql, [limit]);
  return { rows: result.rows, count: result.rows.length };
});

// POST /api/inject — inject test emails into the pipeline (dev/demo only)
routes.set('POST /api/inject', async (_req, body) => {
  const isDemo = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';
  if (process.env.NODE_ENV === 'production' && !isDemo) {
    return { error: 'Inject endpoint is disabled in production' };
  }
  const { createWorkItem } = await import('./runtime/state-machine.js');
  const emails = body.emails || [];
  const results = [];

  for (const email of emails) {
    const gmailId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const threadId = `thread_${gmailId}`;

    const emailResult = await query(
      `INSERT INTO inbox.messages
       (provider_msg_id, thread_id, message_id, from_address, from_name, to_addresses, cc_addresses,
        subject, snippet, received_at, labels, has_attachments, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        gmailId, threadId, `<${gmailId}@test>`,
        email.from_address, email.from_name || 'Unknown',
        ['eric@staqs.io'], [],
        email.subject, email.snippet,
        new Date().toISOString(), email.labels || [],
        false, null,
      ]
    );

    const emailId = emailResult.rows[0]?.id;
    if (!emailId) continue;

    const workItem = await createWorkItem({
      type: 'task',
      title: `Process: ${email.subject}`,
      description: `Email from ${email.from_address}`,
      createdBy: 'orchestrator',
      assignedTo: 'executor-triage',
      priority: email.priority || 0,
      metadata: { email_id: emailId, provider_msg_id: gmailId },
    });

    if (workItem) {
      await query(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, emailId]);
      results.push({ emailId, workItemId: workItem.id, subject: email.subject });
    }
  }

  return { injected: results.length, results };
});

// POST /api/webhooks/tldv — TLDv "Transcript Ready" webhook
// Auth: query param ?secret= (timing-safe comparison against TLDV_WEBHOOK_SECRET)
routes.set('POST /api/webhooks/tldv', async (req, body) => {
  const { handleTldvWebhook } = await import('./tldv/webhook.js');
  const url = new URL(req.url, 'http://localhost');
  return handleTldvWebhook(req, body, url);
});

// POST /api/webhooks/:source — ingest webhook events into the governed pipeline
// Auth: HMAC signature verification (per-source) OR Bearer token. Fail-closed.
routes.set('POST /api/webhooks/:source', async (req, body) => {
  const { createWorkItem } = await import('./runtime/state-machine.js');

  // Extract source from URL path
  const urlParts = new URL(req.url, 'http://localhost').pathname.split('/');
  const source = urlParts[3]; // /api/webhooks/:source

  // Validate source exists in config
  const sourceConfig = webhookSources.sources[source];
  if (!sourceConfig || !sourceConfig.enabled) {
    console.warn(`[webhook] Rejected unknown/disabled source: ${source}`);
    throw Object.assign(new Error('Invalid webhook source'), { statusCode: 400 });
  }

  // Auth: HMAC signature OR Bearer token (one must pass)
  const hmacSecretEnvKey = `WEBHOOK_SECRET_${source.toUpperCase()}`;
  const hmacSecret = process.env[hmacSecretEnvKey];
  const bearerAuthed = requireAuth(req);

  if (!bearerAuthed) {
    // HMAC verification path
    if (!hmacSecret) {
      // P1: fail-closed — no secret configured means no HMAC verification possible
      console.error(`[webhook] No HMAC secret configured for source: ${source} (env: ${hmacSecretEnvKey})`);
      throw Object.assign(new Error('Webhook authentication unavailable'), { statusCode: 500 });
    }

    const signatureHeader = req.headers[sourceConfig.hmacHeader.toLowerCase()] || '';
    if (!signatureHeader) {
      // DEBUG: log all headers to diagnose Linear webhook signature delivery
      console.warn(`[webhook] Missing HMAC header "${sourceConfig.hmacHeader}" for source: ${source}. Headers: ${Object.keys(req.headers).join(', ')}`);
      throw Object.assign(new Error('Missing HMAC signature header'), { statusCode: 401 });
    }

    const rawBody = req.rawBody || '';
    const computed = createHmac(sourceConfig.hmacAlgorithm, hmacSecret)
      .update(rawBody)
      .digest('hex');
    const expected = sourceConfig.hmacPrefix
      ? `${sourceConfig.hmacPrefix}${computed}`
      : computed;

    // Timing-safe comparison to prevent timing attacks
    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      // DEBUG: log signature mismatch details (lengths, not values) to diagnose
      console.warn(`[webhook] HMAC mismatch for ${source}: header="${sourceConfig.hmacHeader}" sigLen=${sigBuf.length} expectedLen=${expBuf.length} rawBodyLen=${rawBody.length} match=${sigBuf.length === expBuf.length}`);
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
  }

  // GitHub-specific handling: route to appropriate handler by event type
  if (source === 'github') {
    const githubEvent = req.headers['x-github-event'];
    console.log(`[webhook] GitHub event: x-github-event=${githubEvent} action=${body.action}`);
    const { handleGitHubWebhook } = await import('./github/webhook-handler.js');
    const result = await handleGitHubWebhook(githubEvent, body, createWorkItem);
    console.log(`[webhook] GitHub ingest result: ${JSON.stringify(result)}`);
    return result;
  }

  // Linear-specific handling: route issues + comments
  if (source === 'linear') {
    // Linear webhook payloads have type at top level (e.g. "Issue", "Comment")
    // OAuth app webhooks may omit type — detect issues by presence of data.teamId or data.stateId
    const isIssueEvent = body.type === 'Issue'
      || body.data?.teamId
      || body.data?.stateId
      || body.data?.labelIds;
    const isCommentEvent = body.type === 'Comment' || (body.data?.body && body.data?.issueId);
    console.log(`[webhook] Linear event: type=${body.type} action=${body.action} isIssue=${isIssueEvent} isComment=${isCommentEvent} keys=${Object.keys(body).join(',')}`);

    // AgentSessionEvent: Linear's Agent API — Jamie Bot was assigned/mentioned
    if (body.type === 'AgentSessionEvent') {
      const sessionId = body.agentSession?.id;
      const issueId = body.agentSession?.issueId;
      console.log(`[webhook] Linear AgentSession: action=${body.action} session=${sessionId} issue=${issueId}`);

      if (!issueId) {
        console.warn('[webhook] AgentSession missing issueId — skipping');
        return { skipped: true, reason: 'No issueId in agent session' };
      }

      // Route through ingest (not comment handler) — this is an assignment, not a comment
      const { handleLinearWebhook } = await import('./linear/ingest.js');
      const synthesizedIssue = {
        type: 'Issue',
        action: 'update',
        data: { id: issueId },
        updatedFrom: { assigneeId: null }, // triggers "delegated to" path in ingest
      };
      const result = await handleLinearWebhook(synthesizedIssue, createWorkItem);
      console.log(`[webhook] Linear AgentSession ingest result: ${JSON.stringify(result)}`);

      // Respond to Linear Agent API so Jamie Bot doesn't show "Did not respond"
      if (sessionId && process.env.LINEAR_API_KEY) {
        try {
          const workItemId = result?.workItemId || result?.id;
          const message = workItemId
            ? `Working on it — tracked as work item ${workItemId}`
            : result?.skipped ? `Already tracking this issue`
            : `Acknowledged — processing`;

          const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: process.env.LINEAR_API_KEY,
            },
            body: JSON.stringify({
              query: `mutation($sessionId: String!, $message: String!) {
                agentSessionResponse(input: { sessionId: $sessionId, message: $message }) { success }
              }`,
              variables: { sessionId, message },
            }),
          });
          const data = await res.json();
          if (data.errors) {
            // Fallback: post a comment on the issue instead
            const { addBotComment } = await import('./linear/client.js');
            await addBotComment(issueId, message);
            console.log(`[webhook] Linear AgentSession: GraphQL mutation not available, posted comment instead`);
          } else {
            console.log(`[webhook] Linear AgentSession responded: "${message}"`);
          }
        } catch (err) {
          console.warn(`[webhook] Failed to respond to Linear Agent API: ${err.message}`);
        }
      }

      return result;
    }

    if (isIssueEvent) {
      const { handleLinearWebhook } = await import('./linear/ingest.js');
      const result = await handleLinearWebhook(body, createWorkItem);
      console.log(`[webhook] Linear ingest result: ${JSON.stringify(result)}`);
      return result;
    }

    if (isCommentEvent && body.data?.body) {
      // Try comment-driven command handler first (board member /retry, /update, @Jamie)
      const { handleLinearComment } = await import('./linear/comment-handler.js');
      const commandResult = await handleLinearComment(body, createWorkItem);
      if (!commandResult.skipped) {
        console.log(`[webhook] Linear comment command result: ${JSON.stringify(commandResult)}`);
        return commandResult;
      }
      console.log(`[webhook] Linear comment no command (${commandResult.reason}) — falling back to signal`);

      // Tier 3: Comment on a Linear issue → signal-only (surfaces in briefing)
      const { ingestAsSignal } = await import('./webhooks/signal-ingester.js');
      const issueId = body.data.issueId || body.data.issue?.id;
      const result = await ingestAsSignal({
        source: 'linear',
        title: `Linear comment on ${issueId ? 'issue' : 'unknown'}`,
        snippet: String(body.data.body).slice(0, 2000),
        from: body.data.user?.name || body.data.userId || 'Linear',
        signals: [{
          signal_type: 'info',
          content: `Comment: ${String(body.data.body).slice(0, 500)}`,
          confidence: 0.7,
          direction: 'inbound',
        }],
        metadata: {
          linear_comment_id: body.data.id,
          linear_issue_id: issueId,
          webhook_source: 'linear',
        },
        labels: ['linear:comment'],
        providerMsgId: `linear_comment_${body.data.id}`,
      });
      console.log(`[webhook] Linear comment signal: ${JSON.stringify(result)}`);
      return result || { skipped: true, reason: 'Duplicate comment signal' };
    }

    return { skipped: true, reason: `Linear event type=${body.type}, not an issue or comment event` };
  }

  // Normalize payload — truncate attacker-controlled fields to prevent oversized inserts
  // Only accept string values for text fields; objects (e.g. localized string objects) would
  // produce "[object Object]" via String() coercion and corrupt stored data.
  const strField = (...fields) => fields.find(f => typeof f === 'string' && f) || null;
  const title = (strField(body.title, body.subject) || `Webhook event from ${source}`).slice(0, 500);
  const snippet = (strField(body.body, body.description, body.text) || '').slice(0, 2000) || `[${source} webhook event]`;
  const from = (strField(body.from, body.sender) || source).slice(0, 255);
  const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};
  const providerMsgId = String(body.id || body.event_id || `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 255);

  // Normalize attachments (feedback pipeline uses these for context)
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.slice(0, 10).map(a => ({
        url: String(a.url || '').slice(0, 2000),
        type: String(a.type || 'unknown').slice(0, 50),
        name: String(a.name || '').slice(0, 255),
      }))
    : [];

  // Insert message into inbox
  const msgResult = await query(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (channel, channel_id) WHERE channel_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      providerMsgId, 'webhook', 'webhook',
      `wh_thread_${providerMsgId}`, `<${providerMsgId}@webhook>`,
      from, source, ['system@autobot'],
      title, snippet,
      new Date().toISOString(), [`webhook:${source}`],
      attachments.length > 0, providerMsgId,
    ]
  );

  const msgId = msgResult.rows[0]?.id;
  if (!msgId) {
    // Dedup: ON CONFLICT triggered — event already processed
    console.log(`[webhook] Dedup: skipped duplicate ${source} event (providerMsgId=${providerMsgId})`);
    return { skipped: true, reason: 'Duplicate webhook event' };
  }

  // Create work item — enters standard governed pipeline
  const workItem = await createWorkItem({
    type: 'task',
    title: `Webhook: ${title}`,
    description: `${source} webhook event`,
    createdBy: 'orchestrator',
    assignedTo: 'executor-triage',
    priority: 0,
    metadata: { ...metadata, email_id: msgId, provider_msg_id: providerMsgId, webhook_source: source, attachments },
  });

  if (workItem) {
    await query(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, msgId]);
  }

  return { id: msgId, workItemId: workItem?.id, source };
});

// GET /api/status — system status (derived from DB accounts, not env vars)
routes.set('GET /api/status', async () => {
  const hasClientCreds = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
  const demoMode = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';

  // Check Gmail connection from DB accounts, not env vars
  const gmailResult = await cachedQuery('status_gmail', async () => {
    const r = await query(
      `SELECT identifier FROM inbox.accounts WHERE channel = 'email' AND is_active = true LIMIT 1`
    );
    return r.rows[0] || null;
  });

  return {
    gmail_connected: !!gmailResult,
    gmail_credentials: hasClientCreds,
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    openai_configured: !!process.env.OPENAI_API_KEY,
    voyage_configured: !!process.env.VOYAGE_API_KEY,
    slack_configured: !!process.env.SLACK_BOT_TOKEN,
    demo_mode: demoMode,
    gmail_email: gmailResult?.identifier || null,
  };
});

// Compute the base URL for OAuth redirects — works locally and on Railway/cloud
function getBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = parseInt(process.env.API_PORT || '3001', 10);
  return `http://localhost:${port}`;
}

// GET /api/auth/gmail-url — generate OAuth URL for Gmail setup
// Accepts ?label= and ?owner= query params (passed through OAuth state)
routes.set('GET /api/auth/gmail-url', async (req) => {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return { error: 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env first' };
  }
  const url = new URL(req.url, getBaseUrl());
  const label = url.searchParams.get('label') || '';
  const owner = url.searchParams.get('owner') || '';
  const redirectUri = `${getBaseUrl()}/api/auth/gmail-callback`;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts.other.readonly',
    ],
    state: JSON.stringify({ label, owner }),
  });
  return { url: authUrl };
});

// GET /api/auth/gmail-callback — OAuth callback, saves token to .env
routes.set('GET /api/auth/gmail-callback', async (req, _body, res) => {
  const url = new URL(req.url, getBaseUrl());
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    const safeError = String(error).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#ef4444">Auth Failed</h1><p>${safeError}</p><p>Close this tab and try again.</p></body></html>`);
    return '__sse__';
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body>Missing auth code</body></html>');
    return '__sse__';
  }

  try {
    const redirectUri = `${getBaseUrl()}/api/auth/gmail-callback`;
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      redirectUri
    );
    const { tokens } = await oauth2Client.getToken(code);

    // Verify the token works
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;

    // Parse state parameter for label + owner
    const stateParam = url.searchParams.get('state');
    let label = 'Gmail';
    let owner = null;
    try {
      if (stateParam) {
        const state = JSON.parse(stateParam);
        label = state.label || label;
        owner = state.owner || null;
      }
    } catch {}

    // Save to inbox.accounts table (encrypted credentials)
    const encryptedCreds = encryptCredentials({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });

    // Resolve owner_id from board_members table
    let ownerId = null;
    if (owner) {
      const bmResult = await query(`SELECT id FROM agent_graph.board_members WHERE github_username = $1`, [owner]);
      ownerId = bmResult.rows[0]?.id || null;
    }

    const insertResult = await query(
      `INSERT INTO inbox.accounts (channel, provider, label, identifier, credentials, sync_status, owner, owner_id)
       VALUES ('email', 'gmail', $1, $2, $3, 'setup', $4, $5)
       ON CONFLICT (channel, provider, identifier) DO UPDATE SET
         credentials = $3, label = $1, is_active = true, sync_status = 'setup',
         owner = COALESCE($4, inbox.accounts.owner),
         owner_id = COALESCE($5, inbox.accounts.owner_id),
         updated_at = now()
       RETURNING id`,
      [label, email, encryptedCreds, owner, ownerId]
    );
    const accountId = insertResult.rows[0]?.id;
    _cache.delete('accounts');
    clearAuthCache(email);
    console.log(`[api] Gmail account saved to DB: ${email[0]}***@${email.split('@')[1] || '?'} (setup mode)`);

    // Redirect back to settings page with success params
    const dashboardUrl = process.env.DASHBOARD_URL;
    if (dashboardUrl) {
      res.writeHead(302, {
        Location: `${dashboardUrl.replace(/\/$/, '')}/settings?accountId=${accountId}&email=${encodeURIComponent(email)}&connected=true`
      });
      res.end();
    } else {
      const safeEmail = String(email).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#22c55e">Gmail Connected!</h1><p>Account <strong>${safeEmail}</strong> linked successfully.</p><p>Account ID: ${accountId}</p><p>Next: call <code>POST /api/voice/bootstrap?accountId=${accountId}</code> to train voice profiles, then <code>POST /api/accounts/${accountId}/activate</code> to start polling.</p></body></html>`);
    }
    return '__sse__';
  } catch (err) {
    console.error('[api] Gmail OAuth error:', err.message);
    const safeErr = String(err.message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#ef4444">Token Exchange Failed</h1><p>${safeErr}</p><p>Close this tab and try again.</p></body></html>`);
    return '__sse__';
  }
});

// GET /api/debug/pipeline — show work items, events, transitions (dev only)
// 30s TTL safety net — event-driven invalidation handles freshness via startCacheInvalidationListener()
routes.set('GET /api/debug/pipeline', async () => {
  const result = await cachedQuery('pipeline', async () => {
    const workItems = await query(
      `WITH recent AS (
        SELECT w.id, w.type, w.title, w.status, w.assigned_to, w.created_by, w.metadata, w.created_at, w.updated_at,
               m.channel AS message_channel, a.label AS account_label
        FROM agent_graph.work_items w
        LEFT JOIN inbox.messages m ON m.id = (w.metadata->>'email_id')
        LEFT JOIN inbox.accounts a ON a.id = m.account_id
        ORDER BY w.updated_at DESC LIMIT 20
      ),
      demo AS (
        SELECT w.id, w.type, w.title, w.status, w.assigned_to, w.created_by, w.metadata, w.created_at, w.updated_at,
               NULL::text AS message_channel, NULL::text AS account_label
        FROM agent_graph.work_items w
        WHERE w.assigned_to IN ('executor-redesign', 'executor-blueprint')
        ORDER BY w.updated_at DESC LIMIT 10
      )
      SELECT * FROM recent
      UNION
      SELECT * FROM demo
      ORDER BY updated_at DESC`
    );
    const events = await query(
      `SELECT event_id, event_type, work_item_id, target_agent_id, processed_at, created_at
       FROM agent_graph.task_events ORDER BY created_at DESC LIMIT 30`
    );
    const transitions = await query(
      `SELECT id, work_item_id, from_state, to_state, agent_id, reason, created_at
       FROM agent_graph.state_transitions ORDER BY created_at DESC LIMIT 20`
    );
    return { work_items: workItems.rows, events: events.rows, transitions: transitions.rows };
  }, 30_000);
  return result || { work_items: [], events: [], transitions: [] };
});

// POST /api/auth/gmail-disconnect — clear Gmail token
routes.set('POST /api/auth/gmail-disconnect', async () => {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, 'utf-8');
    envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
    envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
    envContent = envContent.replace(/\n{3,}/g, '\n\n'); // clean up blank lines
    writeFileSync(envPath, envContent);
  }
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.GMAIL_USER_EMAIL;
  console.log('[api] Gmail disconnected');
  return { ok: true };
});

// POST /api/halt — trigger HALT
routes.set('POST /api/halt', async () => {
  await emitHalt('Board triggered HALT via dashboard');
  return { ok: true, message: 'HALT signal emitted' };
});

// POST /api/resume — clear HALT
routes.set('POST /api/resume', async () => {
  await clearHalt();
  return { ok: true, message: 'HALT cleared, agents resuming' };
});

// GET /api/inbox — recent emails with triage status (direct query, no view)
routes.set('GET /api/inbox', async () => {
  const result = await cachedQuery('inbox', async () => {
    const r = await query(`
      SELECT m.id, m.provider_msg_id, m.from_address, m.from_name, m.subject, m.snippet,
        m.received_at, m.triage_category, m.priority_score,
        m.channel, m.account_id,
        a.label AS account_label,
        (m.processed_at IS NOT NULL) AS is_processed
      FROM inbox.messages m
      LEFT JOIN inbox.accounts a ON a.id = m.account_id
      ORDER BY m.received_at DESC LIMIT 50
    `);
    return { emails: r.rows };
  });
  return result || { emails: [] };
});

// GET /api/board-members — list all board members
routes.set('GET /api/board-members', async () => {
  const result = await query(
    `SELECT id, github_username, display_name, email, telegram_id, role, is_active, created_at
     FROM agent_graph.board_members WHERE is_active = true ORDER BY created_at`
  );
  return { members: result.rows };
});

// GET /api/accounts — list configured accounts with sync status
// ?owner=username filters to a specific board member's accounts
routes.set('GET /api/accounts', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const ownerFilter = url.searchParams.get('owner');
  const cacheKey = ownerFilter ? `accounts:${ownerFilter}` : 'accounts';
  const result = await cachedQuery(cacheKey, async () => {
    const r = ownerFilter
      ? await query(
          `SELECT id, channel, label, identifier, is_active, last_sync_at, sync_status, last_error, owner, created_at
           FROM inbox.accounts WHERE owner = $1 ORDER BY created_at`, [ownerFilter])
      : await query(
          `SELECT id, channel, label, identifier, is_active, last_sync_at, sync_status, last_error, owner, created_at
           FROM inbox.accounts ORDER BY created_at`);
    return { accounts: r.rows };
  }, 30_000);
  return result || { accounts: [] };
});

// POST /api/voice/bootstrap — run voice training for a newly connected account
routes.set('POST /api/voice/bootstrap', async (_req, body) => {
  const { accountId, sampleSize } = body;
  if (!accountId) return { error: 'accountId required' };

  const authClient = await getAuthForAccount(accountId);
  const contactsSynced = await syncGoogleContacts(authClient).catch(err => {
    console.warn('[voice/bootstrap] Contacts sync failed (non-fatal):', err.message);
    return 0;
  });

  // Import sent emails for voice training (default 500 for better profile quality)
  const importCount = sampleSize || 500;
  const imported = await bootstrapSentEmails(importCount, authClient);

  // Build account-scoped profiles (was missing accountId — caused weak G3 scores)
  const profile = await buildGlobalProfile(accountId);
  await buildRecipientProfiles(accountId);

  // Also rebuild legacy/unscoped profiles for backward compat
  await buildGlobalProfile();
  await buildRecipientProfiles();

  let embeddingsGenerated = 0;
  if (hasEmbeddingProvider()) {
    embeddingsGenerated = await generateEmbeddings(importCount);
  }

  // Activate the account (setup → pending) so the poller picks it up
  await query(
    `UPDATE inbox.accounts SET sync_status = 'pending', updated_at = now() WHERE id = $1 AND sync_status = 'setup'`,
    [accountId]
  );
  _cache.delete('accounts');

  return { imported, contactsSynced, profile: !!profile, embeddingsGenerated, sampleSize: importCount };
});

// POST /api/voice/rebuild — rebuild all voice profiles with edit delta corrections
routes.set('POST /api/voice/rebuild', async () => {
  const stats = await rebuildAllProfiles();
  return { ok: true, ...stats };
});

// POST /api/contacts/sync — import Google Contacts into signal.contacts
routes.set('POST /api/contacts/sync', async (_req, body) => {
  const { accountId } = body;
  const count = await syncGoogleContacts(null, accountId || null);
  _cache.delete('signals');
  _cache.delete('signals_feed');
  return { ok: true, synced: count };
});

// POST /api/accounts/activate — skip voice training and activate account
routes.set('POST /api/accounts/activate', async (_req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  const result = await query(
    `UPDATE inbox.accounts SET sync_status = 'pending', updated_at = now() WHERE id = $1 AND sync_status = 'setup' RETURNING id`,
    [accountId]
  );
  _cache.delete('accounts');

  if (result.rows.length === 0) return { error: 'Account not found or not in setup state' };
  return { ok: true, accountId: result.rows[0].id };
});

// GET /api/auth/gmail — start OAuth flow for adding a new Gmail account
routes.set('GET /api/auth/gmail', async (req) => {
  const url = new URL(req.url, `http://localhost`);
  const label = url.searchParams.get('label') || 'Gmail';
  const owner = url.searchParams.get('owner') || null;
  const authUrl = getAuthUrl(label, owner);
  return { url: authUrl };
});

// GET /api/voice/status — voice training state for settings page
routes.set('GET /api/voice/status', async () => {
  const result = await cachedQuery('voice_status', async () => {
    const sentResult = await query(`SELECT COUNT(*) AS cnt FROM voice.sent_emails`);
    const sentEmails = parseInt(sentResult.rows[0]?.cnt || '0', 10);

    const embResult = await query(`SELECT COUNT(*) AS cnt FROM voice.sent_emails WHERE embedding IS NOT NULL`);
    const embeddingsGenerated = parseInt(embResult.rows[0]?.cnt || '0', 10);

    const profileResult = await query(
      `SELECT sample_count, formality_score, last_updated FROM voice.profiles WHERE scope = 'global' LIMIT 1`
    );
    const globalProfile = profileResult.rows[0]
      ? { sampleCount: Number(profileResult.rows[0].sample_count), formality: Number(profileResult.rows[0].formality_score), lastUpdated: profileResult.rows[0].last_updated }
      : null;

    const recipientResult = await query(`SELECT COUNT(*) AS cnt FROM voice.profiles WHERE scope = 'recipient'`);
    const recipientProfiles = parseInt(recipientResult.rows[0]?.cnt || '0', 10);

    const deltaResult = await query(`SELECT COUNT(*) AS cnt FROM voice.edit_deltas`);
    const editDeltas = parseInt(deltaResult.rows[0]?.cnt || '0', 10);

    const embeddingProvider = process.env.VOYAGE_API_KEY ? 'voyage' : process.env.OPENAI_API_KEY ? 'openai' : null;

    return { sentEmails, embeddingsGenerated, globalProfile, recipientProfiles, editDeltas, embeddingProvider };
  });
  return result || { sentEmails: 0, embeddingsGenerated: 0, globalProfile: null, recipientProfiles: 0, editDeltas: 0, embeddingProvider: null };
});

// POST /api/accounts/disconnect — deactivate a specific account
routes.set('POST /api/accounts/disconnect', async (_req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  const result = await query(
    `UPDATE inbox.accounts SET is_active = false, updated_at = now() WHERE id = $1 RETURNING identifier`,
    [accountId]
  );
  if (result.rows.length === 0) return { error: 'Account not found' };

  const identifier = result.rows[0].identifier;

  // If this account matches the default env var email, clear env vars too
  if (identifier && identifier === process.env.GMAIL_USER_EMAIL) {
    const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
      envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
      envContent = envContent.replace(/\n{3,}/g, '\n\n');
      writeFileSync(envPath, envContent);
    }
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_USER_EMAIL;
  }

  _cache.delete('accounts');
  _cache.delete('status');
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  _cache.delete('briefing');
  return { ok: true, identifier };
});

// POST /api/accounts/delete — permanently remove an account and its associated data
routes.set('POST /api/accounts/delete', async (_req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  // Verify account exists
  const acct = await query(`SELECT identifier FROM inbox.accounts WHERE id = $1`, [accountId]);
  if (acct.rows.length === 0) return { error: 'Account not found' };
  const identifier = acct.rows[0].identifier;

  // Delete associated data in dependency order (children before parents)
  await query(`DELETE FROM inbox.signals WHERE message_id IN (SELECT id FROM inbox.messages WHERE account_id = $1)`, [accountId]);
  await query(`DELETE FROM agent_graph.action_proposals WHERE message_id IN (SELECT id FROM inbox.messages WHERE account_id = $1)`, [accountId]);
  await query(`DELETE FROM agent_graph.action_proposals WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.sync_state WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.messages WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.accounts WHERE id = $1`, [accountId]);

  // Clear env vars if this was the default account
  if (identifier && identifier === process.env.GMAIL_USER_EMAIL) {
    const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
      envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
      envContent = envContent.replace(/\n{3,}/g, '\n\n');
      writeFileSync(envPath, envContent);
    }
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_USER_EMAIL;
  }

  _cache.delete('accounts');
  _cache.delete('status');
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  _cache.delete('briefing');
  return { ok: true, identifier, deleted: true };
});

// POST /api/accounts/resync — reset sync state so next poll re-fetches recent emails
routes.set('POST /api/accounts/resync', async (_req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  const acct = await query(
    `SELECT id, identifier FROM inbox.accounts WHERE id = $1 AND is_active = true`, [accountId]
  );
  if (acct.rows.length === 0) return { error: 'Account not found or inactive' };

  await query(`DELETE FROM inbox.sync_state WHERE account_id = $1`, [accountId]);

  _cache.delete('accounts');
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  _cache.delete('briefing');

  return { ok: true, message: 'Sync reset — re-fetching on next poll' };
});

// POST /api/settings/keys — set API keys via UI (writes to .env)
routes.set('POST /api/settings/keys', async (_req, body) => {
  const { key, value } = body;
  const ALLOWED_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'SLACK_BOT_TOKEN']);
  if (!key || !ALLOWED_KEYS.has(key)) return { error: `Invalid key. Allowed: ${[...ALLOWED_KEYS].join(', ')}` };
  if (!value || typeof value !== 'string' || value.length < 8) return { error: 'Value must be a string of at least 8 characters' };

  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
  }

  writeFileSync(envPath, envContent);
  process.env[key] = value;

  return { ok: true };
});

// GET /api/drive/watches — list all Drive folder watches
routes.set('GET /api/drive/watches', async () => {
  const result = await query(
    `SELECT id, account_id, folder_id, folder_url, label, preset, is_active, last_poll_at, last_error, created_at
     FROM inbox.drive_watches
     ORDER BY created_at DESC`
  );
  return { watches: result.rows };
});

// POST /api/drive/watches — add a new Drive folder watch
routes.set('POST /api/drive/watches', async (_req, body) => {
  const { folder_url, folder_id: rawFolderId, label, account_id, preset } = body;
  if (!account_id) return { error: 'account_id required' };
  if (!folder_url && !rawFolderId) return { error: 'folder_url or folder_id required' };
  if (!label) return { error: 'label required' };

  // Parse folder ID from Google Drive URL if provided
  let folderId = rawFolderId;
  if (!folderId && folder_url) {
    const match = folder_url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!match) return { error: 'Could not parse folder ID from URL. Expected: drive.google.com/drive/folders/{ID}' };
    folderId = match[1];
  }

  // Validate account exists and is active
  const acct = await query(
    `SELECT id FROM inbox.accounts WHERE id = $1 AND is_active = true`, [account_id]
  );
  if (acct.rows.length === 0) return { error: 'Account not found or inactive' };

  // Check for duplicate
  const existing = await query(
    `SELECT id FROM inbox.drive_watches WHERE folder_id = $1`, [folderId]
  );
  if (existing.rows.length > 0) return { error: 'A watch for this folder already exists' };

  const validPresets = ['tldv', 'generic'];
  const normalizedPreset = preset && validPresets.includes(preset) ? preset : null;

  const result = await query(
    `INSERT INTO inbox.drive_watches (account_id, folder_id, folder_url, label, preset)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, folder_id, label, preset, is_active, created_at`,
    [account_id, folderId, folder_url || null, label, normalizedPreset]
  );

  return { ok: true, watch: result.rows[0] };
});

// POST /api/drive/watches/remove — remove a watch by id
routes.set('POST /api/drive/watches/remove', async (_req, body) => {
  const { id } = body;
  if (!id) return { error: 'id required' };

  const result = await query(
    `DELETE FROM inbox.drive_watches WHERE id = $1 RETURNING id`, [id]
  );
  if (result.rows.length === 0) return { error: 'Watch not found' };
  return { ok: true, deleted: id };
});

// POST /api/drive/watches/poll — trigger an immediate poll (for testing)
routes.set('POST /api/drive/watches/poll', async () => {
  const { pollAllDriveWatches } = await import('./drive/watcher.js');
  const ingested = await pollAllDriveWatches();
  return { ok: true, ingested };
});

// GET /api/contacts/:id — single contact with projects and recent signals
routes.set('GET /api/contacts/:id', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.pathname.split('/').pop();

  // Contact + relationship strength
  const contactResult = await query(
    `SELECT c.*, v.relationship_strength
     FROM signal.contacts c
     LEFT JOIN signal.v_contact_strength v ON v.id = c.id
     WHERE c.id = $1`,
    [id]
  );
  if (contactResult.rows.length === 0) {
    return { error: 'Contact not found' };
  }
  const contact = contactResult.rows[0];

  // Identities
  const identitiesResult = await query(
    `SELECT id, channel, identifier, verified_at, source, created_at FROM signal.contact_identities WHERE contact_id = $1 ORDER BY channel, created_at`,
    [id]
  );

  // Active projects
  const projectsResult = await query(
    `SELECT * FROM signal.contact_projects WHERE contact_id = $1 AND is_active = true ORDER BY is_primary DESC, created_at`,
    [id]
  );

  // Recent signals from this contact's emails
  const signalsResult = await query(
    `SELECT s.id, s.signal_type, s.content, s.confidence, s.due_date,
            s.resolved, s.resolved_at, s.direction, s.domain, s.created_at,
            m.subject, m.channel
     FROM inbox.signals s
     JOIN inbox.messages m ON m.id = s.message_id
     WHERE lower(m.from_address) = lower($1)
     ORDER BY s.created_at DESC LIMIT 20`,
    [contact.email_address]
  );

  return { contact, identities: identitiesResult.rows, projects: projectsResult.rows, signals: signalsResult.rows };
});

// POST /api/contacts/:id/projects — add a project to a contact
routes.set('POST /api/contacts/:id/projects', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2]; // /api/contacts/:id/projects

  const { project_name, platform, locator, platform_config, is_primary } = body;
  if (!project_name || !platform || !locator) {
    return { error: 'project_name, platform, and locator are required' };
  }
  const validPlatforms = ['github', 'shopify', 'wordpress', 'vercel', 'linear', 'database', 'other'];
  if (!validPlatforms.includes(platform)) {
    return { error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}` };
  }

  const result = await query(
    `INSERT INTO signal.contact_projects (contact_id, project_name, platform, locator, platform_config, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contact_id, platform, locator)
     DO UPDATE SET is_active = true, updated_at = now()
     RETURNING *`,
    [contactId, project_name, platform, locator, platform_config || '{}', is_primary || false]
  );

  return { project: result.rows[0] };
});

// POST /api/contacts/:id/projects/remove — soft-delete a project
routes.set('POST /api/contacts/:id/projects/remove', async (_req, body) => {
  const { projectId } = body;
  if (!projectId) {
    return { error: 'projectId is required' };
  }

  const result = await query(
    `UPDATE signal.contact_projects SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`,
    [projectId]
  );
  if (result.rows.length === 0) {
    return { error: 'Project not found' };
  }
  return { project: result.rows[0] };
});

// GET /api/contacts — list all contacts with identities and projects
routes.set('GET /api/contacts', async () => {
  const result = await query(
    `SELECT c.id, c.email_address, c.name, c.contact_type, c.is_vip,
            c.phone, c.default_repos, c.emails_received, c.emails_sent,
            c.last_received_at, c.created_at, c.organization, c.tier, c.notes,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ci.id, 'channel', ci.channel, 'identifier', ci.identifier)) FROM signal.contact_identities ci WHERE ci.contact_id = c.id), '[]'::jsonb) AS identities,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', cp.id, 'project_name', cp.project_name, 'platform', cp.platform, 'locator', cp.locator, 'is_primary', cp.is_primary)) FROM signal.contact_projects cp WHERE cp.contact_id = c.id AND cp.is_active = true), '[]'::jsonb) AS projects
     FROM signal.contacts c
     ORDER BY COALESCE(c.last_received_at, c.created_at) DESC
     LIMIT 200`
  );
  return { contacts: result.rows };
});

// POST /api/contacts/classify — auto-classify contacts by email frequency and patterns
routes.set('POST /api/contacts/classify', async () => {
  // Inbound email counts per sender
  const inboundResult = await query(
    `SELECT lower(from_address) AS email, COUNT(*)::int AS cnt
     FROM inbox.messages
     WHERE direction = 'inbound' AND from_address IS NOT NULL
     GROUP BY lower(from_address)`
  );
  const inboundMap = new Map();
  for (const row of inboundResult.rows) {
    inboundMap.set(row.email, row.cnt);
  }

  // Outbound email counts per recipient
  const outboundResult = await query(
    `SELECT lower(addr) AS email, COUNT(*)::int AS cnt
     FROM inbox.messages, unnest(to_addresses) AS addr
     WHERE direction = 'outbound' AND to_addresses IS NOT NULL
     GROUP BY lower(addr)`
  );
  const outboundMap = new Map();
  for (const row of outboundResult.rows) {
    outboundMap.set(row.email, row.cnt);
  }

  // All contacts
  const contactsResult = await query(
    `SELECT id, email_address, contact_type, tier FROM signal.contacts WHERE email_address IS NOT NULL`
  );

  const automatedPattern = /no-reply|mailer-daemon|postmaster|bounce|auto-?reply|daemon/i;
  const newsletterPattern = /noreply|newsletter|notifications?|updates?@|digest@|news@|info@|marketing@/i;
  const serviceDomains = new Set([
    'github.com', 'linear.app', 'vercel.com', 'railway.app',
    'stripe.com', 'slack.com', 'notion.so', 'figma.com', 'sentry.io'
  ]);

  let updated = 0;
  for (const contact of contactsResult.rows) {
    const email = contact.email_address.toLowerCase();
    const inbound = inboundMap.get(email) || 0;
    const outbound = outboundMap.get(email) || 0;
    const total = inbound + outbound;
    const domain = email.split('@')[1] || '';

    let newTier = contact.tier;
    let newType = contact.contact_type;

    // Classify tier by email pattern
    if (automatedPattern.test(email)) {
      newTier = 'automated';
    } else if (newsletterPattern.test(email)) {
      newTier = 'newsletter';
    } else if (total >= 10) {
      newTier = 'inner_circle';
    } else if (total >= 5) {
      newTier = 'active';
    } else if (inbound > 0 && outbound === 0) {
      newTier = 'inbound_only';
    }

    // Classify type for known service domains
    if (serviceDomains.has(domain)) {
      newType = 'service';
    }

    // Only update if something changed
    if (newTier !== contact.tier || newType !== contact.contact_type) {
      await query(
        `UPDATE signal.contacts SET tier = $1, contact_type = $2, updated_at = now() WHERE id = $3`,
        [newTier, newType, contact.id]
      );
      updated++;
    }
  }

  return { classified: updated, total: contactsResult.rows.length };
});

// POST /api/contacts/:id — update contact fields (enrichment)
routes.set('POST /api/contacts/:id', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.pathname.split('/').pop();
  const { name, contact_type, is_vip, phone, default_repos, organization, notes, vip_reason } = body;

  // Validate phone format if provided (empty string = clear)
  if (phone && !/^\+[1-9]\d{1,14}$/.test(phone)) {
    return { error: 'Phone must be E.164 format (e.g. +14155551234)' };
  }

  // Validate default_repos format if provided
  if (default_repos && !Array.isArray(default_repos)) {
    return { error: 'default_repos must be an array' };
  }
  if (default_repos) {
    for (const r of default_repos) {
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(r)) {
        return { error: `Invalid repo format: ${r}. Use owner/repo.` };
      }
    }
  }

  // Build SET clauses dynamically — only update fields that were sent.
  // Distinguishes "not sent" (undefined → keep existing) from "sent empty" (clear it).
  const setClauses = ['updated_at = now()'];
  const params = [id];
  let paramIdx = 2;

  if (name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(name || null); }
  if (contact_type !== undefined) { setClauses.push(`contact_type = $${paramIdx++}`); params.push(contact_type || 'unknown'); }
  if (is_vip !== undefined) { setClauses.push(`is_vip = $${paramIdx++}`); params.push(is_vip); }
  if (phone !== undefined) { setClauses.push(`phone = $${paramIdx++}`); params.push(phone || null); }
  if (default_repos !== undefined) { setClauses.push(`default_repos = $${paramIdx++}`); params.push(default_repos); }
  if (organization !== undefined) { setClauses.push(`organization = $${paramIdx++}`); params.push(organization || null); }
  if (notes !== undefined) { setClauses.push(`notes = $${paramIdx++}`); params.push(notes || null); }
  if (vip_reason !== undefined) { setClauses.push(`vip_reason = $${paramIdx++}`); params.push(vip_reason || null); }

  if (setClauses.length === 1) {
    return { error: 'No fields to update' };
  }

  const result = await query(
    `UPDATE signal.contacts SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    return { error: 'Contact not found' };
  }
  return { contact: result.rows[0] };
});

// GET /api/github/repos — list accessible repos for repo picker
routes.set('GET /api/github/repos', async () => {
  if (!process.env.GITHUB_TOKEN && !process.env.GITHUB_APP_ID) {
    return { error: 'GitHub credentials not configured (GITHUB_TOKEN or GITHUB_APP_ID)' };
  }
  const { listAccessibleRepos } = await import('./github/issues.js');
  const repos = await listAccessibleRepos();
  return { repos };
});

// ── Entity Resolution (GitHub #56) ──

// GET /api/contacts/:id/identities — list identities for a contact
routes.set('GET /api/contacts/:id/identities', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2]; // /api/contacts/:id/identities
  const result = await query(
    `SELECT id, channel, identifier, label, verified_at, stale_after, source, created_at
     FROM signal.contact_identities WHERE contact_id = $1 ORDER BY channel, created_at`,
    [contactId]
  );
  return { identities: result.rows };
});

// POST /api/contacts/:id/identities — add an identity to a contact
routes.set('POST /api/contacts/:id/identities', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2];
  const { channel, identifier, label, source } = body;
  if (!channel || !identifier) return { error: 'channel and identifier required' };
  try {
    // Check if identity already belongs to a different contact (P3: no silent ownership theft)
    const existing = await query(
      `SELECT id, contact_id FROM signal.contact_identities WHERE channel = $1 AND identifier = $2`,
      [channel, identifier]
    );
    if (existing.rows.length > 0 && existing.rows[0].contact_id !== contactId) {
      return { error: `Identity ${channel}:${identifier} already belongs to contact ${existing.rows[0].contact_id}. Use merge to combine contacts.` };
    }

    const result = await query(
      `INSERT INTO signal.contact_identities (contact_id, channel, identifier, label, source, verified_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (channel, identifier) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [contactId, channel, identifier, label || null, source || 'manual']
    );
    return { ok: true, id: result.rows[0]?.id };
  } catch (err) {
    return { error: err.message };
  }
});

// POST /api/contacts/merge — merge two contacts into one
routes.set('POST /api/contacts/merge', async (req, body) => {
  const { primaryId, secondaryId, reason } = body;
  if (!primaryId || !secondaryId) return { error: 'primaryId and secondaryId required' };
  if (primaryId === secondaryId) return { error: 'Cannot merge a contact with itself' };
  const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'board';
  try {
    const result = await query(
      `SELECT signal.merge_contacts($1, $2, $3, $4) AS result`,
      [primaryId, secondaryId, reason || 'manual merge', boardUser]
    );
    return result.rows[0]?.result || { error: 'Merge failed' };
  } catch (err) {
    return { error: err.message };
  }
});

// GET /api/contacts/duplicates — find potential duplicate contacts for merge suggestions
routes.set('GET /api/contacts/duplicates', async () => {
  const result = await query(`
    SELECT c1.id AS id_a, c1.name AS name_a, c1.email_address AS email_a,
           c2.id AS id_b, c2.name AS name_b, c2.email_address AS email_b,
           similarity(COALESCE(c1.name,''), COALESCE(c2.name,'')) AS name_sim
    FROM signal.contacts c1
    JOIN signal.contacts c2 ON c1.id < c2.id
    WHERE (
      c1.organization IS NOT NULL AND c1.organization = c2.organization
      AND similarity(COALESCE(c1.name,''), COALESCE(c2.name,'')) > 0.4
    )
    OR similarity(COALESCE(c1.name,''), COALESCE(c2.name,'')) > 0.7
    ORDER BY name_sim DESC
    LIMIT 20
  `);
  return { duplicates: result.rows };
});

// Register modular route handlers
registerGateRoutes(routes);
registerFinanceRoutes(routes);
registerAuditRoutes(routes);
registerConstitutionalRoutes(routes);
registerPhaseRoutes(routes);
registerDistributionRoutes(routes);
registerValueRoutes(routes);
registerGovernanceRoutes(routes, cachedQuery);
registerPublicArchiveRoutes(routes);
registerResearchRoutes(routes);
registerRedesignRoutes(routes);
registerIntentRoutes(routes);
registerBlueprintRoutes(routes);
registerSpecGraphRoutes(routes);
registerCampaignRoutes(routes, cachedQuery);
registerProjectRoutes(routes);
registerTriageRoutes(routes);
registerActivityRoutes(routes);
registerTraceRoutes(routes);
registerPipelineRoutes(routes, cachedQuery);
registerRunRoutes(routes, cachedQuery);
registerCronRoutes(routes);
registerAgentRoutes(routes);
registerDocumentRoutes(routes, cachedQuery);
registerSearchRoutes(routes);
registerBoardAuthRoutes(routes);
registerBoardRoutes(routes);

// Phase 1 success metrics (SPEC §14)
routes.set('GET /api/metrics/phase1', async (_req, _body) => {
  const metrics = await cachedQuery('phase1-metrics', collectPhase1Metrics, 120_000);
  return metrics;
});

routes.set('GET /api/strategic-decisions', async () => {
  const result = await cachedQuery('strategic-decisions', async () => {
    const r = await query(`
      SELECT id, proposed_action, rationale, decision_type, recommendation,
             board_verdict, board_notes, decided_at,
             perspective_scores, created_at
      FROM agent_graph.strategic_decisions
      WHERE board_verdict IS NULL
      UNION ALL
      SELECT * FROM (
        SELECT id, proposed_action, rationale, decision_type, recommendation,
               board_verdict, board_notes, decided_at,
               perspective_scores, created_at
        FROM agent_graph.strategic_decisions
        WHERE board_verdict IS NOT NULL
        ORDER BY decided_at DESC
        LIMIT 10
      ) recent
      ORDER BY created_at DESC
    `);
    return { decisions: r.rows };
  }, 30_000);
  return result || { decisions: [] };
});

/**
 * Parse JSON body from request.
 */
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return resolve({});
    const chunks = [];
    let size = 0;
    const MAX = 1024 * 1024; // 1MB
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); resolve({}); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      req.rawBody = buf; // Buffer preserves exact bytes for HMAC verification
      try { resolve(JSON.parse(buf.toString('utf8'))); } catch { resolve({}); }
    });
  });
}

/**
 * Match a request to a route handler.
 * Supports simple path patterns like POST /api/drafts/approve with { id } in body.
 */
function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`;
  if (routes.has(key)) return routes.get(key);

  // Prefix match: POST /api/webhooks/:source (check exact routes first)
  if (method === 'POST' && pathname.startsWith('/api/webhooks/')) {
    const exactKey = `POST ${pathname}`;
    if (routes.has(exactKey)) return routes.get(exactKey);
    return routes.get('POST /api/webhooks/:source') || null;
  }

  // Prefix match: GET /api/redesign/status/:id
  if (method === 'GET' && /^\/api\/redesign\/status\/[^/]+$/.test(pathname)) {
    return routes.get('GET /api/redesign/status/:id') || null;
  }
  // Prefix match: GET /api/redesign/preview/:id
  if (method === 'GET' && /^\/api\/redesign\/preview\/[^/]+$/.test(pathname)) {
    return routes.get('GET /api/redesign/preview/:id') || null;
  }
  // Prefix match: POST /api/redesign/:id/cancel
  if (method === 'POST' && /^\/api\/redesign\/[^/]+\/cancel$/.test(pathname)) {
    return routes.get('POST /api/redesign/:id/cancel') || null;
  }
  // Prefix match: POST /api/redesign/:id/retry
  if (method === 'POST' && /^\/api\/redesign\/[^/]+\/retry$/.test(pathname)) {
    return routes.get('POST /api/redesign/:id/retry') || null;
  }
  // Prefix match: GET /api/blueprint/status/:id
  if (method === 'GET' && /^\/api\/blueprint\/status\/[^/]+$/.test(pathname)) {
    return routes.get('GET /api/blueprint/status/:id') || null;
  }
  // Prefix match: GET /api/blueprint/view/:id
  if (method === 'GET' && /^\/api\/blueprint\/view\/[^/]+$/.test(pathname)) {
    return routes.get('GET /api/blueprint/view/:id') || null;
  }

  // Prefix match: POST /api/intents/:id/approve
  if (method === 'POST' && /^\/api\/intents\/[^/]+\/approve$/.test(pathname)) {
    return routes.get('POST /api/intents/:id/approve') || null;
  }
  // Prefix match: POST /api/intents/:id/reject
  if (method === 'POST' && /^\/api\/intents\/[^/]+\/reject$/.test(pathname)) {
    return routes.get('POST /api/intents/:id/reject') || null;
  }

  // Prefix match: GET /api/contacts/:id/identities
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/identities$/.test(pathname)) {
    return routes.get('GET /api/contacts/:id/identities') || null;
  }
  // Prefix match: POST /api/contacts/:id/identities
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/identities$/.test(pathname)) {
    return routes.get('POST /api/contacts/:id/identities') || null;
  }
  // Prefix match: POST /api/contacts/:id/projects/remove (most specific first)
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/projects\/remove$/.test(pathname)) {
    return routes.get('POST /api/contacts/:id/projects/remove') || null;
  }
  // Prefix match: POST /api/contacts/:id/projects
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/projects$/.test(pathname)) {
    return routes.get('POST /api/contacts/:id/projects') || null;
  }
  // Prefix match: GET /api/contacts/:id (not the list endpoint)
  if (method === 'GET' && /^\/api\/contacts\/[^/]+$/.test(pathname) && pathname !== '/api/contacts' && pathname !== '/api/contacts/duplicates') {
    return routes.get('GET /api/contacts/:id') || null;
  }
  // Prefix match: POST /api/contacts/classify (before :id catch-all)
  if (method === 'POST' && pathname === '/api/contacts/classify') {
    return routes.get('POST /api/contacts/classify') || null;
  }
  // Prefix match: POST /api/contacts/:id
  if (method === 'POST' && /^\/api\/contacts\/[^/]+$/.test(pathname) && pathname !== '/api/contacts/merge' && pathname !== '/api/contacts/classify') {
    return routes.get('POST /api/contacts/:id') || null;
  }

  // Campaign routes
  if (method === 'POST' && pathname === '/api/campaigns') {
    return routes.get('POST /api/campaigns') || null;
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/preview$/.test(pathname)) {
    return routes.get('GET /api/campaigns/:id/preview') || null;
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/download$/.test(pathname)) {
    return routes.get('GET /api/campaigns/:id/download') || null;
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/iterations$/.test(pathname)) {
    return routes.get('GET /api/campaigns/:id/iterations') || null;
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+$/.test(pathname) && pathname !== '/api/campaigns') {
    return routes.get('GET /api/campaigns/:id') || null;
  }
  if (method === 'PATCH' && /^\/api\/campaigns\/[^/]+$/.test(pathname)) {
    return routes.get('PATCH /api/campaigns/:id') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/approve$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/approve') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/pause$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/pause') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/resume$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/resume') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/cancel$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/cancel') || null;
  }
  // Campaign history + HITL routes
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/history$/.test(pathname)) {
    return routes.get('GET /api/campaigns/:id/history') || null;
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/hitl\/pending$/.test(pathname)) {
    return routes.get('GET /api/campaigns/:id/hitl/pending') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/hitl\/request$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/hitl/request') || null;
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/hitl\/[^/]+\/respond$/.test(pathname)) {
    return routes.get('POST /api/campaigns/:id/hitl/:requestId/respond') || null;
  }
  // Explorer domain toggle: /api/explorer/domains/:domain/toggle
  if (method === 'POST' && /^\/api\/explorer\/domains\/[^/]+\/toggle$/.test(pathname)) {
    return routes.get('POST /api/explorer/domains/:domain/toggle') || null;
  }

  return null;
}

/**
 * Start the API server.
 */
export function startApiServer(port = 3001) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, getCorsHeaders(req));
      res.end();
      return;
    }

    const handler = matchRoute(req.method, pathname);
    if (!handler) {
      res.writeHead(404, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Request-level timeout: prevents dashboard hanging when DB is busy.
    // Long-running endpoints (voice bootstrap, embeddings) get extended timeouts.
    const LONG_RUNNING = new Set(['/api/voice/bootstrap', '/api/voice/rebuild', '/api/contacts/sync', '/api/drive/watches/poll', '/api/cron/explorer', '/api/chat/message']);
    const timeoutMs = LONG_RUNNING.has(pathname) ? 300_000
      : req.method === 'POST' ? 30_000 : 10_000;
    let responded = false;
    const requestTimeout = setTimeout(() => {
      if (!responded && !res.writableEnded) {
        responded = true;
        console.warn(`[api] Request timeout: ${req.method} ${pathname}`);
        res.writeHead(503, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service busy — agents processing, try again shortly' }));
      }
    }, timeoutMs);

    try {
      // Auth: unified resolver supports board JWT, agent JWT, and legacy Bearer.
      // Webhooks, redesign, blueprint handle their own auth inside the handler.
      const isWebhook = pathname.startsWith('/api/webhooks/');
      const isRedesign = pathname.startsWith('/api/redesign/');
      const isBlueprint = pathname.startsWith('/api/blueprint/');
      // Linus: campaign preview/download now requires auth (P1 deny by default)
      const routeKey = `${req.method} ${pathname}`;
      const isPublic = PUBLIC_ROUTES.has(routeKey);
      // P1: deny by default — auth everything except explicit exemptions
      const needsAuth = !isWebhook && !isRedesign && !isBlueprint && !isPublic;

      if (needsAuth) {
        const authed = await resolveAuth(req);
        if (!authed) {
          responded = true;
          clearTimeout(requestTimeout);
          res.writeHead(401, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        // Rate limiting (board JWT only — agents + legacy Bearer are exempt)
        if (req.auth && req.auth.source !== 'agent_jwt' && req.auth.source !== 'api_secret') {
          try {
            const { checkRateLimit } = await import('./runtime/rate-limiter.js');
            const limit = await checkRateLimit(req.auth.sub, req.auth.role);
            if (!limit.allowed) {
              responded = true;
              clearTimeout(requestTimeout);
              res.writeHead(429, {
                ...getCorsHeaders(req),
                'Content-Type': 'application/json',
                'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)),
              });
              res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs }));
              return;
            }
          } catch (e) {
            // Rate limiter failure is non-blocking (fail-open for availability)
            console.warn(`[api] Rate limiter error: ${e.message}`);
          }
        }
        // NemoClaw heartbeat: record board JWT activity for dashboard visibility (fire-and-forget)
        if (req.auth && req.auth.source === 'jwt' && req.auth.role === 'board' && req.auth.github_username) {
          const extAgentId = `nemoclaw-${req.auth.github_username}`;
          query(
            `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
             VALUES ($1, now(), 'online', 0)
             ON CONFLICT (agent_id) DO UPDATE SET heartbeat_at = now(), status = 'online'`,
            [extAgentId]
          ).catch(() => {});
        }
      } else if (!isWebhook && !isRedesign && !isBlueprint && !isPublic) {
        // GET requests: attempt auth but don't require it (attaches req.auth if available)
        await resolveAuth(req).catch(() => {});
        // NemoClaw heartbeat on GET requests too (external clients mostly read)
        if (req.auth && req.auth.source === 'jwt' && req.auth.role === 'board' && req.auth.github_username) {
          const extAgentId = `nemoclaw-${req.auth.github_username}`;
          query(
            `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
             VALUES ($1, now(), 'online', 0)
             ON CONFLICT (agent_id) DO UPDATE SET heartbeat_at = now(), status = 'online'`,
            [extAgentId]
          ).catch(() => {});
        }
      }

      const body = await parseBody(req);
      const result = await handler(req, body, res);

      if (responded) return; // timeout already sent 503
      responded = true;
      clearTimeout(requestTimeout);

      // SSE handlers manage their own response
      if (result === '__sse__') return;

      // OAuth redirect support (board-auth.js returns { _redirect: url })
      if (result && result._redirect) {
        res.writeHead(302, { ...getCorsHeaders(req), 'Location': result._redirect });
        res.end();
        return;
      }

      res.writeHead(200, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (responded) return; // timeout already sent 503
      responded = true;
      clearTimeout(requestTimeout);
      const status = err.statusCode || 500;
      console.error(`[api] ${req.method} ${pathname} error (${status}):`, err.message);
      res.writeHead(status, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[api] Port ${port} is already in use. Kill the other process or set API_PORT in .env`);
    } else {
      console.error(`[api] Server error:`, err.message);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`[api] Dashboard API listening on http://localhost:${port}`);
  });

  return server;
}

/**
 * Warm the API cache. Call this BEFORE starting agent loops so PGlite is idle.
 * On first boot the cache is empty — without a warm, every dashboard page
 * gets null data until PGlite becomes available between agent queries.
 */
export async function warmApiCache() {
  const endpoints = ['GET /api/briefing', 'GET /api/stats', 'GET /api/signals',
    'GET /api/signals/feed', 'GET /api/signals/feedback/metrics', 'GET /api/drafts',
    'GET /api/metrics', 'GET /api/inbox', 'GET /api/debug/pipeline',
    'GET /api/status', 'GET /api/accounts', 'GET /api/voice/status'];
  let ok = 0;
  for (const key of endpoints) {
    try {
      const handler = routes.get(key);
      if (handler) { await handler({ url: '/', headers: {} }, {}); ok++; }
    } catch (err) { console.warn(`[api] Cache warm failed for ${key}: ${err.message}`); }
  }
  console.log(`[api] Cache warmed (${ok}/${endpoints.length} endpoints)`);
}

/**
 * Listen for pg_notify state changes and invalidate API cache.
 * Call after initPgNotify() so the event bus receives cross-process notifications.
 */
export function startCacheInvalidationListener() {
  onAnyEvent((payload) => {
    if (payload.event_type === 'state_changed' || payload.event_type === 'task_assigned') {
      _cache.delete('pipeline');
      _cache.delete('status');
    }
  });
  console.log('[api] Cache invalidation listener active');
}

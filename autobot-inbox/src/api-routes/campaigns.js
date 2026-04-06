import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import archiver from 'archiver';

// Linus: sanitize HITL answers before they reach agent LLM context
let sanitize;
async function loadSanitizer() {
  if (!sanitize) {
    try {
      const mod = await import('../../lib/runtime/sanitizer.js');
      sanitize = mod.sanitize;
    } catch { /* sanitizer unavailable in test — answers pass through */ }
  }
}

/**
 * Campaign Management API routes (ADR-021, Phase F).
 *
 * GET  /api/campaigns              — list all campaigns with summary stats
 * GET  /api/campaigns/:id          — campaign detail + iteration history
 * GET  /api/campaigns/:id/iterations — paginated iteration list
 * GET  /api/campaigns/:id/preview  — serve best iteration output as rendered HTML
 * GET  /api/campaigns/:id/download — extract code files from best iteration as zip
 * POST /api/campaigns/:id/approve  — board approves campaign envelope
 * POST /api/campaigns/:id/pause    — board pauses a running campaign
 * POST /api/campaigns/:id/resume   — board resumes a paused campaign
 * POST /api/campaigns/:id/cancel   — board cancels a campaign
 * GET  /api/explorer/status        — explorer cycle history + domain stats
 * POST /api/explorer/domains/:domain/toggle — enable/disable a domain
 */
export function registerCampaignRoutes(routes, cachedQuery) {

  // Helper: extract campaign ID from URL like /api/campaigns/<id>/...
  function getCampaignId(req) {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    // /api/campaigns/:id → parts = ['', 'api', 'campaigns', '<id>', ...]
    return parts[3] || null;
  }

  // POST /api/campaigns — create a new campaign
  routes.set('POST /api/campaigns', async (req, body) => {
    if (!body?.goal_description) return { error: 'goal_description is required' };
    const createdBy = req.auth?.github_username || 'board';

    const budgetUsd = parseFloat(body.budget_envelope_usd || '10');
    const maxIterations = parseInt(body.max_iterations || '20', 10);
    const timeBudget = body.iteration_time_budget || '5 minutes';
    const successCriteria = body.success_criteria || [{ metric: 'quality_score', operator: '>=', threshold: 0.85 }];
    const constraints = body.constraints || { tool_allowlist: ['llm_invoke', 'db_read'], max_cost_per_iteration: 0.50 };

    // Stateful mode now supported — workspace provisioned during claim.
    // Default to stateless. Only honor explicit stateful from the request.
    const mode = body.campaign_mode || 'stateless';
    const isSystemMod = mode === 'stateful';

    // Create work_item — created_by must be 'board' to satisfy assignment rules trigger (P2).
    // The actual creator is tracked in the campaigns table for notification routing.
    const wi = await query(
      `INSERT INTO agent_graph.work_items (id, type, title, description, status, priority, assigned_to, created_by, delegation_depth)
       VALUES (gen_random_uuid(), 'campaign', $1, $2, 'assigned', 5, 'claw-campaigner', 'board', 0)
       RETURNING id`,
      [body.title || `Campaign: ${body.goal_description.slice(0, 60)}`, body.goal_description]
    );
    const workItemId = wi.rows[0].id;

    // Build metadata JSONB (merge promotion config if provided)
    const metadata = {};
    if (body.promotion) metadata.promotion = body.promotion;
    if (body.metadata) Object.assign(metadata, body.metadata);

    // System-mod campaigns default to PR promotion if none specified
    if (isSystemMod && !metadata.promotion) {
      metadata.promotion = { type: 'pr', target_repo: 'staqsIO/optimus' };
      metadata.campaign_type = 'system_mod';
    }

    // Create campaign
    const c = await query(
      `INSERT INTO agent_graph.campaigns (
        id, work_item_id, goal_description, success_criteria, constraints,
        budget_envelope_usd, max_iterations, iteration_time_budget,
        campaign_status, campaign_mode, created_by, metadata
      ) VALUES (
        gen_random_uuid(), $1, $2, $3::jsonb, $4::jsonb,
        $5, $6, $7::interval, $8, $9, $10, $11::jsonb
      ) RETURNING id, campaign_status`,
      [
        workItemId, body.goal_description,
        JSON.stringify(successCriteria), JSON.stringify(constraints),
        budgetUsd, maxIterations, timeBudget,
        body.auto_approve ? 'approved' : 'pending_approval',
        mode,
        createdBy,
        JSON.stringify(metadata),
      ]
    );

    const campaign = c.rows[0];
    if (campaign.campaign_status === 'approved') {
      await publishEvent('campaign_approved', `Campaign ${campaign.id} created and auto-approved by board`, 'board', null, { campaign_id: campaign.id }).catch(() => {});
    }

    return { ok: true, campaign_id: campaign.id, work_item_id: workItemId, status: campaign.campaign_status };
  });

  // GET /api/campaigns — list all campaigns
  routes.set('GET /api/campaigns', async () => {
    const result = await cachedQuery('campaigns-list', async () => {
      const r = await query(`
        SELECT
          c.id, c.work_item_id, c.goal_description, c.campaign_status,
          c.budget_envelope_usd, c.spent_usd, c.reserved_usd,
          c.max_iterations, c.completed_iterations,
          c.created_at, c.completed_at, c.updated_at,
          c.campaign_mode, c.source_intent_id, c.created_by,
          w.title AS work_item_title, w.status AS work_item_status,
          (SELECT COUNT(*) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = c.id) AS total_iterations,
          (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = c.id AND ci.decision = 'keep') AS best_score
        FROM agent_graph.campaigns c
        JOIN agent_graph.work_items w ON w.id = c.work_item_id
        ORDER BY c.created_at DESC
        LIMIT 50
      `);
      return { campaigns: r.rows };
    }, 10_000);
    return result || { campaigns: [] };
  });

  // GET /api/campaigns/:id — campaign detail (metadata column added 2026-04-02)
  routes.set('GET /api/campaigns/:id', async (req) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) return { error: 'Missing campaign ID' };

    const r = await query(`
      SELECT
        c.*, c.iteration_time_budget::text AS iteration_time_budget,
        w.title AS work_item_title, w.status AS work_item_status, w.assigned_to,
        (SELECT json_agg(json_build_object(
          'iteration_number', ci.iteration_number,
          'quality_score', ci.quality_score,
          'decision', ci.decision,
          'cost_usd', ci.cost_usd,
          'duration_ms', ci.duration_ms,
          'strategy_used', ci.strategy_used,
          'git_commit_hash', ci.git_commit_hash,
          'failure_analysis', ci.failure_analysis,
          'action_taken', ci.action_taken,
          'created_at', ci.created_at
        ) ORDER BY ci.iteration_number DESC)
        FROM agent_graph.campaign_iterations ci
        WHERE ci.campaign_id = c.id
        LIMIT 100) AS iterations
      FROM agent_graph.campaigns c
      JOIN agent_graph.work_items w ON w.id = c.work_item_id
      WHERE c.id = $1
    `, [campaignId]);

    if (r.rows.length === 0) return { error: 'Campaign not found' };

    // Look up PR URL if campaign was promoted (uses dedicated columns, not metadata JSONB)
    const prResult = await query(
      `SELECT github_pr_url AS pr_url, github_pr_number AS pr_number, target_repo AS branch
       FROM agent_graph.action_proposals
       WHERE campaign_id = $1 AND action_type = 'code_fix_pr' AND github_pr_url IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [campaignId]
    );
    const campaign = r.rows[0];
    if (prResult.rows[0]) {
      campaign.pr_url = prResult.rows[0].pr_url;
      campaign.pr_number = prResult.rows[0].pr_number;
      campaign.pr_branch = prResult.rows[0].branch;
    }

    return { campaign };
  });

  // GET /api/campaigns/:id/iterations — paginated iterations
  routes.set('GET /api/campaigns/:id/iterations', async (req) => {
    const campaignId = getCampaignId(req);
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const r = await query(`
      SELECT
        ci.iteration_number, ci.quality_score, ci.quality_details,
        ci.decision, ci.cost_usd, ci.duration_ms,
        ci.strategy_used, ci.failure_analysis, ci.strategy_adjustment,
        ci.git_commit_hash, ci.content_policy_result, ci.action_taken, ci.created_at
      FROM agent_graph.campaign_iterations ci
      WHERE ci.campaign_id = $1
      ORDER BY ci.iteration_number DESC
      LIMIT $2 OFFSET $3
    `, [campaignId, limit, offset]);

    return { iterations: r.rows };
  });

  // POST /api/campaigns/:id/approve — board approves campaign envelope
  routes.set('POST /api/campaigns/:id/approve', async (req) => {
    const campaignId = getCampaignId(req);

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (check.rows[0].campaign_status !== 'pending_approval') {
      return { error: `Cannot approve: status is ${check.rows[0].campaign_status}` };
    }

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'approved', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await publishEvent('campaign_approved', `Campaign ${campaignId} approved by board`, 'board', null, { campaign_id: campaignId }).catch(() => {});

    return { ok: true, campaign_id: campaignId, status: 'approved' };
  });

  // POST /api/campaigns/:id/pause — board pauses a running campaign
  routes.set('POST /api/campaigns/:id/pause', async (req) => {
    const campaignId = getCampaignId(req);

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (check.rows[0].campaign_status !== 'running') {
      return { error: `Cannot pause: status is ${check.rows[0].campaign_status}` };
    }

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'paused', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await publishEvent('campaign_paused', `Campaign ${campaignId} paused by board`, 'board', null, { campaign_id: campaignId }).catch(() => {});

    return { ok: true, campaign_id: campaignId, status: 'paused' };
  });

  // POST /api/campaigns/:id/resume — board resumes a paused campaign
  routes.set('POST /api/campaigns/:id/resume', async (req) => {
    const campaignId = getCampaignId(req);

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (!['paused', 'plateau_paused'].includes(check.rows[0].campaign_status)) {
      return { error: `Cannot resume: status is ${check.rows[0].campaign_status}` };
    }

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'approved', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await publishEvent('campaign_resumed', `Campaign ${campaignId} resumed by board`, 'board', null, { campaign_id: campaignId }).catch(() => {});

    return { ok: true, campaign_id: campaignId, status: 'approved' };
  });

  // POST /api/campaigns/:id/cancel — board cancels a campaign
  routes.set('POST /api/campaigns/:id/cancel', async (req) => {
    const campaignId = getCampaignId(req);

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (['succeeded', 'failed', 'cancelled'].includes(check.rows[0].campaign_status)) {
      return { error: `Cannot cancel: status is ${check.rows[0].campaign_status}` };
    }

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await publishEvent('campaign_cancelled', `Campaign ${campaignId} cancelled by board`, 'board', null, { campaign_id: campaignId }).catch(() => {});

    return { ok: true, campaign_id: campaignId, status: 'cancelled' };
  });

  // PATCH /api/campaigns/:id — edit campaign fields (only when pending_approval or approved)
  routes.set('PATCH /api/campaigns/:id', async (req, body) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) return { error: 'Missing campaign ID' };

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (!['pending_approval', 'approved'].includes(check.rows[0].campaign_status)) {
      return { error: `Cannot edit: status is ${check.rows[0].campaign_status}` };
    }

    const EDITABLE = {
      goal_description: 'text',
      budget_envelope_usd: 'numeric',
      max_iterations: 'int',
      iteration_time_budget: 'interval',
      campaign_mode: 'text',
      metadata: 'jsonb',
    };

    const setClauses = [];
    const values = [campaignId]; // $1 = id
    let idx = 2;

    for (const [field, type] of Object.entries(EDITABLE)) {
      if (body[field] !== undefined) {
        const cast = type === 'jsonb' ? '::jsonb' : type === 'interval' ? '::interval' : '';
        setClauses.push(`${field} = $${idx}${cast}`);
        values.push(type === 'jsonb' ? JSON.stringify(body[field]) : body[field]);
        idx++;
      }
    }

    if (setClauses.length === 0) return { error: 'No editable fields provided' };

    setClauses.push('updated_at = now()');
    await query(
      `UPDATE agent_graph.campaigns SET ${setClauses.join(', ')} WHERE id = $1`,
      values
    );

    await publishEvent('campaign_edited', `Campaign ${campaignId} edited by board`, 'board', null, {
      campaign_id: campaignId,
      fields: Object.keys(EDITABLE).filter(f => body[f] !== undefined),
    }).catch(() => {});

    return { ok: true, campaign_id: campaignId };
  });

  // POST /api/campaigns/:id/hitl/request — agent submits a question, campaign transitions to awaiting_input
  routes.set('POST /api/campaigns/:id/hitl/request', async (req, body) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) return { error: 'Missing campaign ID' };
    if (!body?.question) return { error: 'question is required' };

    const check = await query(
      `SELECT campaign_status FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (check.rows.length === 0) return { error: 'Campaign not found' };
    if (!['running', 'paused'].includes(check.rows[0].campaign_status)) {
      return { error: `Cannot request input: status is ${check.rows[0].campaign_status}` };
    }

    // Linus: sanitize question on write — agent could be prompt-injected
    let question = String(body.question || '').slice(0, 4096);
    if (!sanitize) await loadSanitizer();
    if (sanitize) question = sanitize(question);

    const r = await query(
      `INSERT INTO agent_graph.campaign_hitl_requests (campaign_id, agent_id, question)
       VALUES ($1, $2, $3) RETURNING id`,
      [campaignId, body.agent_id || 'claw-campaigner', question]
    );
    const requestId = r.rows[0].id;

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'awaiting_input', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await publishEvent('campaign_awaiting_input', `Campaign ${campaignId} awaiting human input`, body.agent_id || 'claw-campaigner', null, {
      campaign_id: campaignId,
      request_id: requestId,
      question: body.question,
    }).catch(() => {});

    return { ok: true, request_id: requestId };
  });

  // GET /api/campaigns/:id/hitl/pending — returns the oldest unresolved HITL request
  routes.set('GET /api/campaigns/:id/hitl/pending', async (req) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) return { error: 'Missing campaign ID' };

    const r = await query(
      `SELECT id, agent_id, question, status, created_at
       FROM agent_graph.campaign_hitl_requests
       WHERE campaign_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
      [campaignId]
    );

    return { request: r.rows[0] || null };
  });

  // POST /api/campaigns/:id/hitl/:requestId/respond — operator submits answer, campaign resumes
  routes.set('POST /api/campaigns/:id/hitl/:requestId/respond', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    // /api/campaigns/:id/hitl/:requestId/respond → parts[3]=id, parts[5]=requestId
    const campaignId = parts[3];
    const requestId = parts[5];

    if (!campaignId || !requestId) return { error: 'Missing campaign ID or request ID' };
    if (!body?.answer) return { error: 'answer is required' };

    // Linus: sanitize + length-cap answer before it reaches agent LLM context
    let answer = String(body.answer);
    if (answer.length > 4096) {
      const e = new Error('Answer exceeds maximum length (4096 chars)');
      e.statusCode = 400;
      throw e;
    }
    // Sanitize — answer flows directly into agent prompts via pg_notify → awaitHumanInput()
    if (!sanitize) await loadSanitizer();
    if (sanitize) answer = sanitize(answer);

    const check = await query(
      `SELECT status FROM agent_graph.campaign_hitl_requests WHERE id = $1 AND campaign_id = $2`,
      [requestId, campaignId]
    );
    if (check.rows.length === 0) return { error: 'HITL request not found' };
    if (check.rows[0].status !== 'pending') return { error: 'Request already resolved' };

    await query(
      `UPDATE agent_graph.campaign_hitl_requests
       SET answer = $1, status = 'resolved', resolved_at = now()
       WHERE id = $2`,
      [answer, requestId]
    );

    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'running', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    // Fire pg_notify so awaitHumanInput() in lib/hitl/index.js resolves immediately
    await query(
      `SELECT pg_notify('hitl_resolved', $1)`,
      [JSON.stringify({ requestId, answer })]
    ).catch(() => {});

    await publishEvent('campaign_input_provided', `Campaign ${campaignId} received human input`, 'board', null, {
      campaign_id: campaignId,
      request_id: requestId,
    }).catch(() => {});

    return { ok: true, campaign_id: campaignId, request_id: requestId };
  });

  // GET /api/campaigns/:id/history — chronological merge of iterations + HITL requests
  routes.set('GET /api/campaigns/:id/history', async (req) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) return { error: 'Missing campaign ID' };

    const [iterRows, hitlRows] = await Promise.all([
      query(`
        SELECT
          'iteration' AS event_type,
          ci.id::text AS id,
          ci.iteration_number,
          ci.quality_score,
          ci.decision,
          ci.cost_usd,
          ci.duration_ms,
          ci.failure_analysis,
          ci.action_taken,
          ci.strategy_used,
          ci.git_commit_hash,
          NULL::text AS question,
          NULL::text AS answer,
          NULL::text AS hitl_status,
          NULL::text AS agent_id,
          ci.created_at
        FROM agent_graph.campaign_iterations ci
        WHERE ci.campaign_id = $1
      `, [campaignId]),
      query(`
        SELECT
          'hitl_request' AS event_type,
          h.id,
          NULL::int AS iteration_number,
          NULL::numeric AS quality_score,
          NULL::text AS decision,
          NULL::numeric AS cost_usd,
          NULL::int AS duration_ms,
          NULL::text AS failure_analysis,
          NULL::text AS action_taken,
          NULL::jsonb AS strategy_used,
          NULL::text AS git_commit_hash,
          h.question,
          h.answer,
          h.status AS hitl_status,
          h.agent_id,
          h.created_at
        FROM agent_graph.campaign_hitl_requests h
        WHERE h.campaign_id = $1
      `, [campaignId]),
    ]);

    const merged = [...iterRows.rows, ...hitlRows.rows]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return { history: merged };
  });

  // GET /api/campaigns/:id/preview — serve campaign output as rendered HTML
  routes.set('GET /api/campaigns/:id/preview', async (req, _body, res) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) { const e = new Error('Missing campaign ID'); e.statusCode = 400; throw e; }

    // Find the best iteration: stop_success > keep (highest score) > latest with content
    const result = await query(
      `SELECT action_taken, quality_score, decision, iteration_number
       FROM agent_graph.campaign_iterations
       WHERE campaign_id = $1 AND action_taken IS NOT NULL AND action_taken != ''
       ORDER BY
         CASE decision WHEN 'stop_success' THEN 0 WHEN 'keep' THEN 1 ELSE 2 END,
         quality_score DESC NULLS LAST,
         iteration_number DESC
       LIMIT 1`,
      [campaignId]
    );

    if (result.rows.length === 0) {
      const e = new Error('No campaign output available yet');
      e.statusCode = 404;
      throw e;
    }

    const { action_taken, quality_score, decision, iteration_number } = result.rows[0];

    // Detect if the output is a full HTML document
    const isHtml = /<!doctype\s+html|<html[\s>]/i.test(action_taken);

    let html;
    if (isHtml) {
      // Extract the HTML document — handle cases where LLM wraps it in markdown code fences
      const fenceMatch = action_taken.match(/```html?\s*\n([\s\S]*?)```/);
      html = fenceMatch ? fenceMatch[1] : action_taken;
    } else {
      // Extract files if present, show as a file browser; otherwise raw text
      const files = extractCodeFiles(action_taken);
      if (files.length > 0) {
        const fileBlocks = files.map(f => {
          const ext = f.path.split('.').pop() || 'txt';
          const escaped = f.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<div class="file"><div class="file-header">${f.path.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div><pre><code class="language-${ext}">${escaped}</code></pre></div>`;
        }).join('\n');
        html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign Output — Iteration #${iteration_number} (${files.length} files)</title>
<style>
  body { background: #0a0a0f; color: #e2e8f0; font-family: system-ui, sans-serif; padding: 2rem; margin: 0; }
  .meta { color: #64748b; font-size: 0.85rem; margin-bottom: 1.5rem; border-bottom: 1px solid #1e293b; padding-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }
  .meta span { color: #94a3b8; }
  .meta a { color: #818cf8; text-decoration: none; font-size: 0.8rem; padding: 0.3rem 0.8rem; border: 1px solid #818cf8; border-radius: 0.375rem; }
  .meta a:hover { background: rgba(129,140,248,0.1); }
  .file { margin-bottom: 1.5rem; border: 1px solid #1e293b; border-radius: 0.5rem; overflow: hidden; }
  .file-header { background: #13131a; padding: 0.5rem 1rem; font-size: 0.8rem; font-family: 'JetBrains Mono', monospace; color: #94a3b8; border-bottom: 1px solid #1e293b; }
  pre { margin: 0; padding: 1rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.6; }
  code { font-family: 'JetBrains Mono', monospace; }
</style></head><body>
<div class="meta"><div>Iteration <span>#${iteration_number}</span> · <span>${decision}</span> · Score: <span>${quality_score ?? 'N/A'}</span> · <span>${files.length} files</span></div><a href="download">Download ZIP</a></div>
${fileBlocks}
</body></html>`;
      } else {
        const escaped = action_taken
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign Preview — Iteration #${iteration_number}</title>
<style>
  body { background: #0a0a0f; color: #e2e8f0; font-family: 'JetBrains Mono', monospace; padding: 2rem; margin: 0; }
  .meta { color: #64748b; font-size: 0.85rem; margin-bottom: 1.5rem; border-bottom: 1px solid #1e293b; padding-bottom: 1rem; }
  .meta span { color: #94a3b8; }
  pre { white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; font-size: 0.9rem; }
</style></head><body>
<div class="meta">Iteration <span>#${iteration_number}</span> · Decision: <span>${decision}</span> · Score: <span>${quality_score ?? 'N/A'}</span></div>
<pre>${escaped}</pre>
</body></html>`;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' fonts.googleapis.com fonts.gstatic.com cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' fonts.gstatic.com data:; script-src 'self' cdn.tailwindcss.com",
      'Cache-Control': 'public, max-age=300',
    });
    res.end(html);
    return '__sse__';
  });

  // GET /api/campaigns/:id/download — extract code blocks from best iteration and serve as zip
  routes.set('GET /api/campaigns/:id/download', async (req, _body, res) => {
    const campaignId = getCampaignId(req);
    if (!campaignId) { const e = new Error('Missing campaign ID'); e.statusCode = 400; throw e; }

    // Find the best iteration (same logic as preview)
    const result = await query(
      `SELECT action_taken, iteration_number, decision
       FROM agent_graph.campaign_iterations
       WHERE campaign_id = $1 AND action_taken IS NOT NULL AND action_taken != ''
       ORDER BY
         CASE decision WHEN 'stop_success' THEN 0 WHEN 'keep' THEN 1 ELSE 2 END,
         quality_score DESC NULLS LAST,
         iteration_number DESC
       LIMIT 1`,
      [campaignId]
    );

    if (result.rows.length === 0) {
      const e = new Error('No campaign output available yet');
      e.statusCode = 404;
      throw e;
    }

    const { action_taken, iteration_number } = result.rows[0];

    // Extract fenced code blocks with filenames from LLM output
    // Matches patterns like: ```tsx filename="app/page.tsx"  or  ```python app.py  or  // filepath: src/index.ts
    const files = extractCodeFiles(action_taken);

    if (files.length === 0) {
      // No extractable files — serve the raw text as a single file
      files.push({ path: 'output.txt', content: action_taken });
    }

    // Get campaign goal for the folder name
    const campResult = await query(
      `SELECT goal_description FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    const goalSlug = (campResult.rows[0]?.goal_description || 'campaign')
      .slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const zipName = `${goalSlug}-iter${iteration_number}.zip`;

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Cache-Control': 'private, max-age=60',
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }

    await archive.finalize();
    return '__sse__';
  });

  // GET /api/explorer/status — explorer cycle history + domain stats
  routes.set('GET /api/explorer/status', async () => {
    const result = await cachedQuery('explorer-status', async () => {
      // Recent exploration cycles
      const cycles = await query(`
        SELECT cycle_id, domain, findings_count, intents_created,
               cost_usd, duration_ms, error, created_at
        FROM agent_graph.exploration_log
        ORDER BY created_at DESC
        LIMIT 50
      `);

      // Domain queue with stats
      const domains = await query(`
        SELECT eq.*,
          (SELECT COUNT(*) FROM agent_graph.exploration_log el WHERE el.domain = eq.domain AND el.created_at > now() - interval '7 days') AS runs_7d,
          (SELECT COALESCE(SUM(findings_count), 0) FROM agent_graph.exploration_log el WHERE el.domain = eq.domain AND el.created_at > now() - interval '7 days') AS findings_7d
        FROM agent_graph.exploration_queue eq
        ORDER BY eq.priority DESC
      `);

      // Daily exploration spend
      const spend = await query(`
        SELECT COALESCE(SUM(cost_usd), 0) AS today_spend
        FROM agent_graph.exploration_log
        WHERE created_at >= CURRENT_DATE
      `);

      return {
        cycles: cycles.rows,
        domains: domains.rows,
        today_spend: parseFloat(spend.rows[0]?.today_spend || '0'),
      };
    }, 30_000);
    return result || { cycles: [], domains: [], today_spend: 0 };
  });

  // POST /api/explorer/domains/:domain/toggle — enable/disable a domain
  routes.set('POST /api/explorer/domains/:domain/toggle', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    // /api/explorer/domains/:domain/toggle → parts[4]
    const domainName = parts[4] || null;
    if (!domainName) return { error: 'Missing domain name' };

    const check = await query(
      `SELECT enabled FROM agent_graph.exploration_queue WHERE domain = $1`,
      [domainName]
    );
    if (check.rows.length === 0) return { error: 'Domain not found' };

    const newEnabled = !check.rows[0].enabled;
    await query(
      `UPDATE agent_graph.exploration_queue SET enabled = $1, updated_at = now() WHERE domain = $2`,
      [newEnabled, domainName]
    );

    await publishEvent(
      'exploration_domain_toggled',
      `Explorer domain ${domainName} ${newEnabled ? 'enabled' : 'disabled'} by board`,
      'board', null, { domain: domainName, enabled: newEnabled }
    ).catch(() => {});

    return { ok: true, domain: domainName, enabled: newEnabled };
  });
}

/**
 * Extract code files from LLM output text.
 * Recognizes multiple patterns:
 *   ```lang filename="path/to/file"    (Cursor/Claude style)
 *   ```lang path/to/file               (common shorthand)
 *   // filepath: path/to/file           (inline comment marker)
 *   // File: path/to/file               (another common pattern)
 *   --- path/to/file ---                (separator style)
 */
function extractCodeFiles(text) {
  const files = [];
  const seen = new Set();

  // Pattern 1: ```lang filename="path" or ```lang file="path"
  const fenceWithAttr = /```\w*\s+(?:file(?:name)?|path)\s*=\s*"([^"]+)"\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceWithAttr.exec(text)) !== null) {
    const path = m[1].trim();
    if (!seen.has(path)) { seen.add(path); files.push({ path, content: m[2] }); }
  }

  // Pattern 2: ```lang path/to/file.ext (filename on same line as fence, has path separator or extension)
  const fenceWithPath = /```\w*\s+([\w./-]+\.\w+)\s*\n([\s\S]*?)```/g;
  while ((m = fenceWithPath.exec(text)) !== null) {
    const path = m[1].trim();
    if (!seen.has(path) && /[./]/.test(path)) { seen.add(path); files.push({ path, content: m[2] }); }
  }

  // Pattern 3: // filepath: path/to/file or // File: path/to/file (at start of code block)
  const commentFilepath = /```\w*\s*\n\s*(?:\/\/|#|--|\/\*)\s*(?:filepath|file|filename)\s*:\s*([^\n*]+)/gi;
  while ((m = commentFilepath.exec(text)) !== null) {
    const path = m[1].trim();
    // Find the closing fence for this block
    const blockStart = m.index;
    const codeStart = text.indexOf('\n', blockStart) + 1;
    const codeEnd = text.indexOf('```', codeStart);
    if (codeEnd > codeStart && !seen.has(path)) {
      seen.add(path);
      // Skip the filepath comment line itself
      const code = text.slice(codeStart, codeEnd);
      const firstNewline = code.indexOf('\n');
      files.push({ path, content: firstNewline > -1 ? code.slice(firstNewline + 1) : code });
    }
  }

  return files;
}

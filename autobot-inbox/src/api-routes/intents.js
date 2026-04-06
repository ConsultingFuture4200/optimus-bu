import { query, withTransaction } from '../db.js';
import { transitionIntent } from '../runtime/intent-manager.js';
import { publishEvent } from '../runtime/infrastructure.js';

/**
 * Agent Intents API routes — board review of agent-proposed actions.
 *
 * GET  /api/intents?status=pending  — list intents by status (default: pending)
 * GET  /api/intents/rates           — 90-day match rates from intent_match_rate view
 * POST /api/intents/:id/approve     — atomic approve → create work_item → mark executed
 * POST /api/intents/:id/reject      — reject with optional board_feedback
 */
export function registerIntentRoutes(routes) {
  // GET /api/intents — list intents, filterable by status
  routes.set('GET /api/intents', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || 'pending';

    const allowed = ['pending', 'approved', 'rejected', 'executed', 'expired'];
    if (!allowed.includes(status)) {
      throw Object.assign(new Error(`status must be one of: ${allowed.join(', ')}`), { statusCode: 400 });
    }

    const result = await query(
      `SELECT id, agent_id, agent_tier, intent_type, decision_tier,
              title, reasoning, proposed_action, trigger_context,
              trigger_type, status, board_feedback, expires_at, created_at
       FROM agent_graph.agent_intents
       WHERE status = $1
       ORDER BY
         CASE decision_tier
           WHEN 'existential' THEN 0
           WHEN 'strategic' THEN 1
           WHEN 'tactical' THEN 2
         END,
         created_at ASC
       LIMIT 100`,
      [status]
    );

    return { intents: result.rows };
  });

  // GET /api/intents/rates — 90-day rolling match rates per agent + type
  routes.set('GET /api/intents/rates', async () => {
    const result = await query(
      `SELECT * FROM agent_graph.intent_match_rate ORDER BY total DESC`
    );
    return { rates: result.rows };
  });

  // POST /api/intents/:id/approve — atomic approve → create work_item → executed
  routes.set('POST /api/intents/:id/approve', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/intents/')[1]?.split('/approve')[0];

    if (!id) {
      throw Object.assign(new Error('Missing intent ID'), { statusCode: 400 });
    }

    // Fetch intent to validate action type
    const intentResult = await query(
      `SELECT * FROM agent_graph.agent_intents WHERE id = $1 AND status = 'pending'`,
      [id]
    );

    if (intentResult.rows.length === 0) {
      throw Object.assign(new Error('Intent not found or no longer pending'), { statusCode: 404 });
    }

    const intent = intentResult.rows[0];
    const action = intent.proposed_action;

    // Only create_work_item is implemented (Fix 7 from CLI)
    const supportedActions = ['create_work_item'];
    if (!supportedActions.includes(action.type)) {
      throw Object.assign(
        new Error(`Action type "${action.type}" is not yet implemented. Cannot approve.`),
        { statusCode: 422 }
      );
    }

    // Atomic transaction: approve → create work_item → mark executed
    let workItem;
    await withTransaction(async (client) => {
      // Step 1: Approve (atomic guard — only succeeds if still pending)
      const approveResult = await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'approved', reviewed_by = 'board', reviewed_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      if (approveResult.rows.length === 0) {
        throw new Error('Intent is no longer pending (race condition)');
      }

      // Step 2: Create work item from proposed action
      const payload = action.payload || {};
      const itemResult = await client.query(
        `INSERT INTO agent_graph.work_items
         (type, title, description, created_by, assigned_to, priority, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          payload.type || 'task',
          payload.title || intent.title,
          payload.description || intent.reasoning,
          'board',
          payload.assigned_to || null,
          payload.priority || 0,
          JSON.stringify({
            source: 'intent',
            intent_id: intent.id,
            original_agent: intent.agent_id,
            ...payload.metadata,
          }),
        ]
      );
      workItem = itemResult.rows[0];

      // Step 3: Mark as executed
      await client.query(
        `UPDATE agent_graph.agent_intents
         SET status = 'executed', executed_at = now()
         WHERE id = $1 AND status = 'approved'`,
        [id]
      );
    });

    await publishEvent(
      'intent_approved',
      `Board approved intent: ${intent.title}`,
      null,
      workItem.id,
      { intent_id: id, agent_id: intent.agent_id, work_item_id: workItem.id },
    );

    return { ok: true, workItem };
  });

  // POST /api/intents/:id/reject — reject with optional feedback
  routes.set('POST /api/intents/:id/reject', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/intents/')[1]?.split('/reject')[0];

    if (!id) {
      throw Object.assign(new Error('Missing intent ID'), { statusCode: 400 });
    }

    const feedback = body?.feedback || null;
    if (feedback != null && typeof feedback !== 'string') {
      throw Object.assign(new Error('feedback must be a string'), { statusCode: 400 });
    }

    const result = await transitionIntent(id, 'rejected', 'board', feedback);

    if (!result.success) {
      throw Object.assign(new Error(result.error), { statusCode: 409 });
    }

    await publishEvent(
      'intent_rejected',
      `Board rejected intent: ${id.slice(0, 8)}...`,
      null,
      id,
      { intent_id: id, feedback },
    );

    return { ok: true };
  });
}

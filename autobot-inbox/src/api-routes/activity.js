import { query } from '../db.js';

/**
 * Agent Activity Log API routes.
 *
 * GET /api/activity                  — recent steps across all agents (last 200)
 * GET /api/activity?work_item_id=X   — all steps for a specific work item
 * GET /api/activity?agent_id=X       — recent steps for a specific agent
 * GET /api/activity?campaign_id=X    — all steps for a specific campaign
 * GET /api/activity?since=ISO        — steps created after ISO timestamp (incremental poll)
 *
 * `since` may be combined with `agent_id` for incremental per-agent polling.
 * Steps are returned ascending when `since`, `work_item_id`, or `campaign_id`
 * is present so the client can append in order. The default feed returns
 * descending (newest-first); the client reverses for display.
 */
export function registerActivityRoutes(routes) {

  routes.set('GET /api/activity', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const workItemId  = url.searchParams.get('work_item_id');
    const agentId     = url.searchParams.get('agent_id');
    const campaignId  = url.searchParams.get('campaign_id');
    const since       = url.searchParams.get('since');
    const limit       = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

    const conditions = [];
    const params = [];

    if (workItemId) {
      params.push(workItemId);
      conditions.push(`s.work_item_id = $${params.length}`);
    } else if (campaignId) {
      params.push(campaignId);
      conditions.push(`s.campaign_id = $${params.length}`);
    } else if (agentId) {
      params.push(agentId);
      conditions.push(`s.agent_id = $${params.length}`);
    }

    if (since) {
      params.push(since);
      conditions.push(`s.created_at > $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Ascending when scoped to a specific context or incremental (`since`),
    // descending for the general recent feed.
    const orderClause = (workItemId || campaignId || since)
      ? 'ORDER BY s.created_at ASC'
      : 'ORDER BY s.created_at DESC';

    params.push(limit);
    const limitClause = `LIMIT $${params.length}`;

    const result = await query(
      `SELECT
         s.id,
         s.work_item_id,
         s.campaign_id,
         s.iteration_number,
         s.parent_step_id,
         s.depth,
         s.agent_id,
         s.step_type,
         s.description,
         s.status,
         s.metadata,
         s.created_at,
         s.completed_at,
         CASE WHEN s.completed_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) * 1000
              ELSE EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000
         END AS duration_ms,
         wi.title AS work_item_title
       FROM agent_graph.agent_activity_steps s
       LEFT JOIN agent_graph.work_items wi ON wi.id = s.work_item_id::text
       ${whereClause}
       ${orderClause}
       ${limitClause}`,
      params
    );

    return { steps: result.rows };
  });
}

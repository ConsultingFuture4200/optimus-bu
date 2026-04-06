/**
 * Tick Context Builder (Claude Code Architecture Audit — Change 6).
 *
 * Builds state snapshots for daemon-mode agents on each tick.
 * The tick context tells the agent what has changed since its last action,
 * so it can decide whether to act proactively.
 *
 * Inspired by Claude Code's KAIROS system — periodic `<tick>` prompts
 * with state snapshots for proactive decision-making.
 */

import { query } from '../db.js';

/**
 * Build tick context for a daemon-mode agent.
 * Assembles a snapshot of system state relevant to proactive decisions.
 *
 * @param {string} agentId - The daemon agent
 * @param {Object} [opts]
 * @param {Date} [opts.lastActionAt] - When this agent last took action
 * @returns {Promise<Object>} Tick context snapshot
 */
export async function buildTickContext(agentId, opts = {}) {
  const context = {
    agentId,
    tickAt: new Date().toISOString(),
    timeSinceLastAction: null,
  };

  // All queries are independent — run in parallel
  const [budgetStatus, pipelineHealth, recentEvents, pendingWork, lastAction] = await Promise.all([
    // Budget status
    query(`SELECT * FROM agent_graph.v_budget_status WHERE period_end >= CURRENT_DATE`)
      .then(r => r.rows)
      .catch(() => []),

    // Pipeline health: agent heartbeats + error rate
    query(
      `SELECT h.agent_id, h.status, h.heartbeat_at,
              (SELECT COUNT(*) FROM agent_graph.state_transitions st
               WHERE st.agent_id = h.agent_id AND st.to_state = 'failed'
               AND st.created_at > now() - INTERVAL '1 hour') AS recent_failures
       FROM agent_graph.agent_heartbeats h
       ORDER BY h.heartbeat_at DESC`
    ).then(r => r.rows).catch(() => []),

    // Recent events (last hour, max 20)
    query(
      `SELECT event_type, source_agent, work_item_id, created_at, metadata
       FROM agent_graph.events
       WHERE created_at > now() - INTERVAL '1 hour'
       ORDER BY created_at DESC
       LIMIT 20`
    ).then(r => r.rows).catch(() => []),

    // Pending work items (unclaimed)
    query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE priority >= 8) AS high_priority,
              MIN(created_at) AS oldest
       FROM agent_graph.work_items
       WHERE status IN ('created', 'assigned')
         AND assigned_to IS NULL`
    ).then(r => r.rows[0]).catch(() => ({ total: 0, high_priority: 0, oldest: null })),

    // This agent's last action
    query(
      `SELECT created_at, to_state, reason
       FROM agent_graph.state_transitions
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [agentId]
    ).then(r => r.rows[0]).catch(() => null),
  ]);

  context.budget = budgetStatus;
  context.pipeline = pipelineHealth;
  context.recentEvents = recentEvents;
  context.pendingWork = pendingWork;

  if (lastAction) {
    context.lastAction = lastAction;
    context.timeSinceLastAction = Date.now() - new Date(lastAction.created_at).getTime();
  }

  // Compute alerts: conditions that should prompt proactive action
  context.alerts = [];

  // Budget alert: >80% spent
  for (const b of budgetStatus) {
    if (b.spent_usd && b.ceiling_usd && b.spent_usd / b.ceiling_usd > 0.8) {
      context.alerts.push({ type: 'budget_high', detail: `${Math.round(b.spent_usd / b.ceiling_usd * 100)}% of budget used` });
    }
  }

  // Pipeline alert: agents with high failure rates
  for (const p of pipelineHealth) {
    if (p.recent_failures > 5) {
      context.alerts.push({ type: 'agent_failing', detail: `${p.agent_id}: ${p.recent_failures} failures in last hour` });
    }
    // Stale heartbeat (>5 min)
    if (p.heartbeat_at && Date.now() - new Date(p.heartbeat_at).getTime() > 300_000) {
      context.alerts.push({ type: 'agent_stale', detail: `${p.agent_id}: heartbeat stale (${p.status})` });
    }
  }

  // Work backlog alert
  if (pendingWork.high_priority > 0) {
    context.alerts.push({ type: 'backlog_high_priority', detail: `${pendingWork.high_priority} high-priority items unclaimed` });
  }
  if (pendingWork.oldest && Date.now() - new Date(pendingWork.oldest).getTime() > 3600_000) {
    context.alerts.push({ type: 'backlog_stale', detail: `Oldest unclaimed item is ${Math.round((Date.now() - new Date(pendingWork.oldest).getTime()) / 60000)}m old` });
  }

  return context;
}

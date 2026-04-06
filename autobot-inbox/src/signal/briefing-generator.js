import { query } from '../db.js';

/**
 * Briefing generator: compile and retrieve daily briefings.
 */

/**
 * Get today's briefing (or most recent).
 */
export async function getLatestBriefing() {
  const result = await query(
    `SELECT * FROM signal.briefings ORDER BY briefing_date DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * Get daily stats from the view.
 */
export async function getDailyStats() {
  const result = await query(`SELECT * FROM signal.v_daily_briefing`);
  return result.rows[0] || null;
}

/**
 * Get agent activity breakdown.
 */
export async function getAgentActivity() {
  const result = await query(`SELECT * FROM agent_graph.v_agent_activity`);
  return result.rows;
}

/**
 * Get budget status.
 */
export async function getBudgetStatus() {
  const result = await query(`SELECT * FROM agent_graph.v_budget_status`);
  return result.rows;
}

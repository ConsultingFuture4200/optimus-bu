import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { query } from '../db.js';

const agentsConfig = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/agents.json', import.meta.url), 'utf-8')
);

/**
 * Sync agent config hashes from agents.json into the DB.
 * The AgentLoop computes SHA-256 from the JSON config; the guard check
 * compares against the DB. If they don't match, every task gets blocked
 * with 'config_hash_mismatch'. This updates the DB on every startup.
 */
export async function syncConfigHashes() {
  for (const [agentId, config] of Object.entries(agentsConfig.agents)) {
    const hash = createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);

    const result = await query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1 WHERE id = $2 AND config_hash != $1`,
      [hash, agentId]
    );
    if (result.rowCount > 0) {
      console.log(`[config] Updated ${agentId} config_hash → ${hash}`);
    }
  }
}

/**
 * Ensure today's daily budget exists (G1 financial gate).
 */
export async function ensureDailyBudget() {
  const dailyBudget = parseFloat(process.env.DAILY_BUDGET_USD || '20');

  const existing = await query(
    `SELECT id FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE`
  );

  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO agent_graph.budgets (scope, scope_id, allocated_usd, period_start, period_end)
       VALUES ('daily', 'default', $1, CURRENT_DATE, CURRENT_DATE)`,
      [dailyBudget]
    );
    console.log(`Daily budget created: $${dailyBudget}`);
  }
}

/**
 * Log a deploy/startup event for audit trail.
 * @param {object} [extra] - Additional metadata (e.g. { runner_id, hostname })
 */
export async function logDeployEvent(extra = {}) {
  try {
    const { execFileSync } = await import('child_process');
    let gitSha = null;
    try {
      gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {}
    const metadata = {
      node_version: process.version,
      pid: process.pid,
      ...extra,
    };
    await query(
      `INSERT INTO agent_graph.deploy_events (event_type, git_sha, metadata)
       VALUES ('pipeline_start', $1, $2)`,
      [gitSha, JSON.stringify(metadata)]
    );
    console.log(`Deploy event logged (pipeline_start, ${gitSha || 'no-git'})`);
  } catch (err) {
    // Table may not exist yet (pre-migration) — non-fatal
    console.warn(`[deploy-event] Skip: ${err.message}`);
  }
}

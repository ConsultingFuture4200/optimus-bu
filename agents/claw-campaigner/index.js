/**
 * Claw Campaigner Agent (ADR-021)
 *
 * Operational Claw: claims board-approved campaigns and runs them
 * autonomously within the defined envelope.
 *
 * Uses the same poll/claim pattern as other agents:
 * - Polls for campaigns with status 'approved'
 * - Claims via SELECT...FOR UPDATE SKIP LOCKED (no split-brain)
 * - Runs the campaign loop (autoresearch pattern)
 * - Supports max concurrent campaigns (default: 2)
 *
 * The Campaigner is an Orchestrator-tier agent that reports to the board.
 */

import { createHash } from 'crypto';
import { query, withTransaction, setAgentContext, isCircuitOpen } from '../../lib/db.js';
import { subscribe } from '../../lib/runtime/event-bus.js';
import { loadMergedConfig } from '../../lib/runtime/config-loader.js';
import { runCampaignLoop } from './campaign-loop.js';

let config = null;
let modelsConfig = null;
let configHash = null;
let pollTimer = null;
let running = false;
let _lastHeartbeatAt = null;
let _lastPollError = null;
let _pollErrorCount = 0;
let _runnerId = 'unknown';
const activeCampaigns = new Map(); // campaignId → AbortController

function writeHeartbeat(status, force = false) {
  const now = Date.now();
  if (!force && _lastHeartbeatAt && now - _lastHeartbeatAt < 10_000) return;
  if (isCircuitOpen()) return; // Don't pile onto an unhealthy pool
  _lastHeartbeatAt = now;
  query(
    `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (agent_id) DO UPDATE
       SET heartbeat_at = now(), status = $2, pid = $3`,
    ['claw-campaigner', status, process.pid]
  ).catch(() => {});
}

async function loadConfig() {
  const raw = await loadMergedConfig();
  config = raw.agents['claw-campaigner'];
  modelsConfig = raw.models;
  // Compute config hash the same way AgentLoop does (sha256, first 16 hex chars)
  configHash = createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex')
    .slice(0, 16);
  return config;
}

/**
 * Claim the next approved campaign using SKIP LOCKED.
 * Returns the campaign row or null.
 */
async function claimNextCampaign() {
  return withTransaction(async (client) => {
    await setAgentContext(client, 'claw-campaigner');

    // Find an approved campaign not currently being run
    const result = await client.query(
      `SELECT c.id, c.work_item_id, c.goal_description, c.campaign_mode, c.workspace_path
       FROM agent_graph.campaigns c
       JOIN agent_graph.work_items w ON w.id = c.work_item_id
       WHERE c.campaign_status = 'approved'
         AND c.campaign_mode != 'workshop'
         AND w.status IN ('created', 'assigned')
       ORDER BY w.priority DESC, c.created_at
       FOR UPDATE OF c SKIP LOCKED
       LIMIT 1`
    );

    if (result.rows.length === 0) return null;

    const campaign = result.rows[0];

    // For stateful campaigns: provision workspace before transitioning to running
    // (CHECK constraint requires workspace_path when status != approved/pending_approval)
    if (campaign.campaign_mode === 'stateful' && !campaign.workspace_path) {
      try {
        const { createWorkspace } = await import('./campaign-workspace.js');
        const successCriteria = typeof campaign.success_criteria === 'string'
          ? JSON.parse(campaign.success_criteria) : campaign.success_criteria || {};
        const workspacePath = await createWorkspace(campaign.id, campaign.goal_description, successCriteria);
        campaign.workspace_path = workspacePath;
      } catch (err) {
        console.error(`[campaigner] Failed to provision workspace for ${campaign.id}: ${err.message}`);
        // Can't run stateful without workspace — skip this campaign
        return null;
      }
    }

    // For project campaigns: provision fresh GitHub repo + local clone
    if (campaign.campaign_mode === 'project' && !campaign.workspace_path) {
      try {
        const { createProjectWorkspace } = await import('./campaign-workspace.js');
        const workspacePath = await createProjectWorkspace(campaign.id, campaign.goal_description);
        campaign.workspace_path = workspacePath;
      } catch (err) {
        console.error(`[campaigner] Failed to create project workspace for ${campaign.id}: ${err.message}`);
        return null;
      }
    }

    // Transition campaign status to running (with heartbeat + runner claim)
    await client.query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'running', started_at = COALESCE(started_at, now()), last_heartbeat_at = now(), claimed_by_runner = $2, updated_at = now() WHERE id = $1`,
      [campaign.id, _runnerId]
    );

    // Transition work_item to in_progress
    await client.query(
      `UPDATE agent_graph.work_items SET status = 'in_progress', assigned_to = 'claw-campaigner', updated_at = now() WHERE id = $1`,
      [campaign.work_item_id]
    );

    return campaign;
  });
}

/**
 * Poll for approved campaigns and start running them.
 */
async function poll() {
  if (!config?.enabled) return;
  if (isCircuitOpen()) return; // DB unhealthy — skip this poll cycle

  writeHeartbeat(activeCampaigns.size > 0 ? 'processing' : 'idle');

  const maxConcurrent = config.campaign?.maxConcurrentCampaigns || 2;
  if (activeCampaigns.size >= maxConcurrent) return;

  try {
    // Log recovery if we were previously in an error state
    if (_lastPollError) {
      if (_pollErrorCount > 0) {
        console.log(`[campaigner] ✓ Recovered (${_pollErrorCount + 1} errors cleared)`);
      } else {
        console.log('[campaigner] ✓ Recovered — connection restored');
      }
      _lastPollError = null;
      _pollErrorCount = 0;
    }

    // Recovery scan: reset orphaned campaigns (stale heartbeat > 2 min)
    try {
      const recovered = await query(
        `UPDATE agent_graph.campaigns SET campaign_status = 'approved', last_heartbeat_at = NULL, claimed_by_runner = NULL, updated_at = now()
         WHERE campaign_status = 'running' AND last_heartbeat_at < now() - INTERVAL '2 minutes'
         RETURNING id`
      );
      for (const row of recovered.rows) {
        console.log(`[campaigner] Recovered orphaned campaign: ${row.id} (stale for >2 min)`);
      }
    } catch { /* non-critical */ }

    const campaign = await claimNextCampaign();
    if (!campaign) return;

    console.log(`[campaigner] Claimed campaign: ${campaign.id} — "${campaign.goal_description?.slice(0, 60)}..."`);

    // Create abort controller for this campaign
    const controller = new AbortController();
    activeCampaigns.set(campaign.id, controller);

    // Run campaign loop (non-blocking) — inject configHash so guardCheck matches DB
    runCampaignLoop(campaign.id, { ...config, configHash }, modelsConfig, controller.signal)
      .catch(err => {
        console.error(`[campaigner] Campaign ${campaign.id} fatal error:`, err.message);
      })
      .finally(() => {
        activeCampaigns.delete(campaign.id);
        console.log(`[campaigner] Campaign ${campaign.id} finished. Active: ${activeCampaigns.size}`);
      });

  } catch (err) {
    // Suppress repetitive identical errors — log first occurrence + count
    const errKey = err.code || err.message;
    if (errKey === _lastPollError) {
      _pollErrorCount++;
    } else {
      if (_pollErrorCount > 0) {
        console.error(`[campaigner] (previous error repeated ${_pollErrorCount}x)`);
      }
      console.error(`[campaigner] Poll error: ${err.message}`);
      _lastPollError = errKey;
      _pollErrorCount = 0;
    }
  }
}

/**
 * Campaign loop agent — compatible with runner.js pattern.
 */
export const campaignerLoop = {
  agentId: 'claw-campaigner',

  /** Expose active campaign count for runner status ticker */
  _getActiveCampaignCount() { return activeCampaigns.size; },

  async start(options) {
    if (running) return;
    running = true;
    _runnerId = options?.runnerId || 'unknown';

    await loadConfig();
    if (!config?.enabled) {
      console.log('[campaigner] Disabled in agents.json — skipping');
      running = false;
      return;
    }

    // Sync config hash to DB so guardCheck() doesn't mismatch (same pattern as AgentLoop)
    query(
      `UPDATE agent_graph.agent_configs SET config_hash = $1, updated_at = now() WHERE id = $2`,
      [configHash, 'claw-campaigner']
    ).catch(err => console.warn(`[campaigner] Config hash sync failed:`, err.message));

    // Startup recovery: reset campaigns orphaned by previous crashes
    try {
      const recovered = await query(
        `UPDATE agent_graph.campaigns SET campaign_status = 'approved', last_heartbeat_at = NULL, claimed_by_runner = NULL, updated_at = now()
         WHERE campaign_status = 'running' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - INTERVAL '2 minutes')
         RETURNING id`
      );
      if (recovered.rows.length > 0) {
        console.log(`[campaigner] Startup: recovered ${recovered.rows.length} orphaned campaign(s): ${recovered.rows.map(r => r.id).join(', ')}`);
      }
    } catch (err) {
      console.warn('[campaigner] Startup recovery scan failed:', err.message);
    }

    const pollInterval = config.campaign?.pollIntervalMs || 30_000;
    console.log(`[campaigner] Starting (${pollInterval / 1000}s poll, hash: ${configHash}, runner: ${_runnerId})`);

    // Subscribe to campaign approval events for instant wake-up
    subscribe('campaign_approved', () => {
      if (running) poll();
    });

    // Initial heartbeat + poll after 3s, then on interval
    writeHeartbeat('idle', true);
    setTimeout(() => {
      poll();
      pollTimer = setInterval(poll, pollInterval);
    }, 3000);

    return Promise.resolve();
  },

  async stop() {
    running = false;
    writeHeartbeat('stopped', true);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    // Abort all active campaigns
    for (const [id, controller] of activeCampaigns) {
      console.log(`[campaigner] Aborting campaign ${id}`);
      controller.abort();
    }

    // Graceful shutdown: release this runner's campaigns back to approved
    try {
      const released = await query(
        `UPDATE agent_graph.campaigns SET campaign_status = 'approved', last_heartbeat_at = NULL, claimed_by_runner = NULL, updated_at = now()
         WHERE campaign_status = 'running' AND claimed_by_runner = $1
         RETURNING id`,
        [_runnerId]
      );
      if (released.rows.length > 0) {
        console.log(`[campaigner] Graceful shutdown: released ${released.rows.length} campaign(s) back to approved`);
      }
    } catch { /* non-critical during shutdown */ }

    activeCampaigns.clear();

    console.log('[campaigner] Stopped');
  },
};

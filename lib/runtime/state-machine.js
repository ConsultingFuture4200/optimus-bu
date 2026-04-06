import { createHash, createHmac } from 'crypto';
import { withTransaction, setAgentContext } from '../db.js';
import { guardCheck } from './guard-check.js';
import { notify } from './event-bus.js';

/**
 * Compute SHA256 hash chain entry.
 * Format MUST match the SQL fallback in transition_state():
 *   sha256(prevHash|transitionId|workItemId|fromState|toState|agentId|configHash)
 */
function computeHashChain(transitionId, workItemId, fromState, toState, agentId, configHash, prevHash) {
  const payload = (prevHash || 'genesis') + '|' +
    transitionId + '|' + workItemId + '|' +
    fromState + '|' + toState + '|' +
    agentId + '|' + configHash;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * HMAC-sign agent identity claim for non-repudiation (ADR-015).
 * Returns hex signature or null if signing key not configured.
 */
function signAgentClaim(agentId, workItemId, toState) {
  const key = process.env.AGENT_SIGNING_KEY;
  if (!key) return null;
  const timestamp = Date.now().toString();
  const payload = `${agentId}|${workItemId}|${toState}|${timestamp}`;
  const signature = createHmac('sha256', key).update(payload).digest('hex');
  return { signature, timestamp, payload };
}

/**
 * Transition a work item through the state machine.
 * Hash chain computed in JS (PGlite doesn't have pgcrypto).
 * guardCheck() and transition_state() in the SAME transaction (spec §5).
 */
export async function transitionState({
  workItemId,
  toState,
  agentId,
  configHash,
  reason = null,
  guardrailChecks = {},
  costUsd = 0,
}) {
  return withTransaction(async (client) => {
    await setAgentContext(client, agentId);

    // Generate transition ID
    const tidResult = await client.query(`SELECT gen_random_uuid()::text as tid`);
    const transitionId = tidResult.rows[0].tid;

    // Get current state + prev hash BEFORE the transition so we can pre-compute the hash chain.
    // FOR UPDATE serializes concurrent transitions on the same work item,
    // preventing hash chain forks from two transactions reading the same prev_hash.
    const currentResult = await client.query(
      `SELECT status FROM agent_graph.work_items WHERE id = $1 FOR UPDATE`,
      [workItemId]
    );
    const fromState = currentResult.rows[0]?.status;
    if (!fromState) return false;

    const prevResult = await client.query(
      `SELECT encode(hash_chain_current, 'hex') as prev_hash
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workItemId]
    );
    const prevHash = prevResult.rows[0]?.prev_hash || '';

    // Pre-compute hash chain so INSERT has the final value (no UPDATE needed on append-only table)
    const hashHex = computeHashChain(
      transitionId, workItemId, fromState, toState, agentId, configHash, prevHash
    );

    // HMAC-sign agent identity (ADR-015: non-repudiable without full JWT)
    const hmacClaim = signAgentClaim(agentId, workItemId, toState);
    const finalChecks = hmacClaim
      ? { ...guardrailChecks, hmac_claim: hmacClaim }
      : guardrailChecks;

    // Call SQL function with the pre-computed hash
    const result = await client.query(
      `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [workItemId, toState, agentId, configHash, reason, JSON.stringify(finalChecks), costUsd, transitionId, hashHex]
    );

    const row = result.rows[0];
    return { success: !!row?.success, toState, workItemId };
  }).then(({ success, toState: st, workItemId: wid }) => {
    // Wake orchestrator AFTER transaction commits so it can claim the state_changed event
    if (success && (st === 'completed' || st === 'failed')) {
      notify({ eventType: 'state_changed', workItemId: wid, targetAgentId: 'orchestrator' })
        .catch(() => {}); // Non-critical — falls back to 3s polling
    }
    return success;
  });
}

/**
 * Claim the next available task for an agent.
 * Uses SKIP LOCKED to prevent contention.
 */
export async function claimNextTask(agentId) {
  return withTransaction(async (client) => {
    await setAgentContext(client, agentId);

    const result = await client.query(
      `SELECT * FROM agent_graph.claim_next_task($1)`,
      [agentId]
    );

    return result.rows[0] || null;
  });
}

/**
 * Atomic claim + guard + transition to in_progress.
 * Fix 4: All three operations in a single transaction.
 * Returns { task, preCheck } on success, null if no work or guard fails.
 */
export async function claimAndStart({ agentId, configHash, estimatedCostUsd = 0 }) {
  return withTransaction(async (client) => {
    await setAgentContext(client, agentId);

    // 1. Claim task (SKIP LOCKED)
    const claimResult = await client.query(
      `SELECT * FROM agent_graph.claim_next_task($1)`,
      [agentId]
    );
    const task = claimResult.rows[0] || null;
    if (!task) return null;

    // 2. Guard check — within the same transaction
    const preCheck = await guardCheck({
      action: task.event_type,
      agentId,
      configHash,
      taskId: task.work_item_id,
      estimatedCostUsd,
      client, // Fix 5: pass transaction client for atomic budget read
    });

    if (!preCheck.allowed) {
      console.warn(`[${agentId}] Guard check failed for ${task.work_item_id}: ${preCheck.reason}`);

      // Release budget reservation if one was made during guard check
      // (budget OK but another check failed → reservation leaks without this)
      if (preCheck._budgetReserved > 0) {
        if (preCheck._campaignId) {
          // ADR-021: Release from campaign budget envelope
          await client.query(`SELECT agent_graph.release_campaign_budget($1, $2)`, [preCheck._campaignId, preCheck._budgetReserved]);
        } else {
          await client.query(`SELECT agent_graph.release_budget($1, $2)`, [preCheck._budgetReserved, preCheck._budgetAccountId || null]);
        }
      }

      // Transition to blocked within the same TX (only for owned work items, not events)
      if (task.event_type !== 'state_changed') {
        const blockedClaim = signAgentClaim(agentId, task.work_item_id, 'blocked');
        const blockedChecks = blockedClaim
          ? { pre: preCheck, hmac_claim: blockedClaim }
          : { pre: preCheck };
        await client.query(
          `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [task.work_item_id, 'blocked', agentId, configHash,
           `Guard check failed: ${preCheck.reason}`, JSON.stringify(blockedChecks), 0, null, null]
        );
      }
      return null;
    }

    // 3. Transition to in_progress — same TX
    // Skip for state_changed events: work_item_id refers to the original task
    // (already completed), not a new work item for this agent. The event is
    // tracked via task_events.processed_at, not the work_items state machine.
    if (task.event_type !== 'state_changed') {
      const startClaim = signAgentClaim(agentId, task.work_item_id, 'in_progress');
      const startChecks = startClaim ? { hmac_claim: startClaim } : {};
      await client.query(
        `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [task.work_item_id, 'in_progress', agentId, configHash,
         'Task claimed, starting execution', JSON.stringify(startChecks), 0, null, null]
      );
    }

    return { task, preCheck };
  });
}

/**
 * Create a work item in the task graph.
 */
export async function createWorkItem({
  type,
  title,
  description = null,
  createdBy,
  parentId = null,
  assignedTo = null,
  priority = 0,
  deadline = null,
  budgetUsd = null,
  routingClass = null,
  metadata = {},
  accountId = null,
}) {
  const item = await withTransaction(async (client) => {
    await setAgentContext(client, createdBy, 'board');

    const result = await client.query(
      `INSERT INTO agent_graph.work_items
       (type, title, description, created_by, parent_id, assigned_to, priority, deadline, budget_usd, routing_class, metadata, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [type, title, description, createdBy, parentId, assignedTo, priority, deadline, budgetUsd, routingClass, JSON.stringify(metadata), accountId]
    );

    const row = result.rows[0];

    // Insert task_events row inside the transaction (atomic with work item creation)
    if (assignedTo) {
      await client.query(
        `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
         VALUES ('task_assigned', $1, $2, $3, $4)`,
        [row.id, assignedTo, priority, JSON.stringify({ title, type })]
      );
    }

    return row;
  });

  // Fire wake-up notification AFTER transaction commits (row already inserted above).
  // Falls back to polling if notify fails — non-critical.
  if (assignedTo && item) {
    notify({ eventType: 'task_assigned', workItemId: item.id, targetAgentId: assignedTo })
      .catch(() => {});
  }

  return item;
}

/**
 * Create an edge between two work items.
 * Cycle detection trigger will prevent cycles.
 */
export async function createEdge(fromId, toId, edgeType = 'depends_on') {
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO agent_graph.edges (from_id, to_id, edge_type) VALUES ($1, $2, $3) RETURNING *`,
      [fromId, toId, edgeType]
    );
    return result.rows[0];
  });
}

// graph/sync.js — Event-driven Postgres→Neo4j sync listener
import { runCypher, isGraphAvailable } from './client.js';
import { getPool } from '../db.js';

let syncClient = null;

export async function startGraphSync() {
  if (!isGraphAvailable()) {
    console.log('[graph-sync] Neo4j unavailable — sync disabled');
    return;
  }

  const pool = getPool();
  if (!pool) {
    console.log('[graph-sync] No database pool — sync disabled');
    return;
  }

  await connectSyncClient(pool);
}

async function connectSyncClient(pool) {
  try {
    syncClient = await pool.connect();

    // Reconnect on connection loss (Linus review: silent stale data without this)
    syncClient.on('error', (err) => {
      console.error('[graph-sync] LISTEN connection error — will attempt reconnect:', err.message);
      try { syncClient.release(); } catch { /* already released */ }
      syncClient = null;
      setTimeout(() => {
        if (isGraphAvailable()) {
          console.log('[graph-sync] Attempting reconnect...');
          connectSyncClient(pool).catch(e =>
            console.error('[graph-sync] Reconnect failed:', e.message)
          );
        }
      }, 5000);
    });

    syncClient.on('notification', async (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        // Validate payload shape before processing (Linus review)
        if (!payload || typeof payload !== 'object') {
          console.warn('[graph-sync] Invalid payload shape, skipping');
          return;
        }
        switch (msg.channel) {
          case 'task_completed':
            if (payload.work_item_id && payload.agent_id) {
              await handleTaskCompleted(payload);
            }
            break;
          case 'intent_decided':
            if (payload.intent_id && payload.agent_id) {
              await handleIntentDecided(payload);
            }
            break;
          case 'draft_reviewed':
            if (payload.proposal_id) {
              await handleDraftReviewed(payload);
            }
            break;
        }
      } catch (err) {
        console.error('[graph-sync] Error processing notification:', err.message);
      }
    });

    await syncClient.query('LISTEN task_completed');
    await syncClient.query('LISTEN intent_decided');
    await syncClient.query('LISTEN draft_reviewed');

    console.log('[graph-sync] Listening for task_completed, intent_decided, draft_reviewed');
  } catch (err) {
    console.error('[graph-sync] Failed to start sync listener:', err.message);
    if (syncClient) {
      try { syncClient.release(); } catch { /* already released */ }
      syncClient = null;
    }
  }
}

async function handleTaskCompleted(payload) {
  const { work_item_id, agent_id, duration_ms, tokens_used, task_type, success } = payload;

  await runCypher(
    `MATCH (a:Agent {id: $agentId})
     MERGE (t:TaskOutcome {id: $workItemId})
     SET t.task_type = $taskType, t.success = $success,
         t.duration_ms = $durationMs, t.tokens_used = $tokensUsed,
         t.created_at = datetime()
     MERGE (a)-[r:COMPLETED_TASK]->(t)
     SET r.role = $agentId, r.duration_ms = $durationMs`,
    { agentId: agent_id, workItemId: work_item_id, taskType: task_type || 'task',
      success: success !== false, durationMs: duration_ms || 0, tokensUsed: tokens_used || 0 }
  );
}

async function handleIntentDecided(payload) {
  const { intent_id, agent_id, decided_by, status, decision_tier } = payload;

  // Create/update Decision node and link proposing agent
  await runCypher(
    `MATCH (a:Agent {id: $agentId})
     MERGE (d:Decision {id: $intentId})
     SET d.type = $tier, d.board_verdict = $status, d.created_at = datetime()
     MERGE (a)-[:PROPOSED_DECISION]->(d)`,
    { agentId: agent_id, intentId: intent_id, tier: decision_tier || 'tactical', status }
  );

  // Link the deciding agent (board member) via DECIDED_ON edge
  // This enables multi-hop decision chain queries (ADR-019)
  if (decided_by) {
    await runCypher(
      `MERGE (decider:Agent {id: $deciderId})
       WITH decider
       MATCH (d:Decision {id: $intentId})
       MERGE (decider)-[:DECIDED_ON]->(d)`,
      { deciderId: decided_by, intentId: intent_id }
    );
  }
}

async function handleDraftReviewed(payload) {
  const { proposal_id, reviewer_verdict, tone_score } = payload;

  await runCypher(
    `MERGE (t:TaskOutcome {id: $proposalId})
     SET t.task_type = 'draft_review', t.success = $approved,
         t.tone_score = $toneScore, t.created_at = datetime()`,
    { proposalId: proposal_id, approved: reviewer_verdict === 'approved',
      toneScore: tone_score || 0 }
  );
}

export function stopGraphSync() {
  if (syncClient) {
    syncClient.release();
    syncClient = null;
  }
}

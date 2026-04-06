import { query } from '../db.js';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Infrastructure services wired to schema objects from 010-phase1-hardening.sql.
 * All functions are safe to call from setInterval — they catch their own errors.
 */

// ============================================================
// Public event log (autobot_public.event_log)
// ============================================================

/**
 * Publish a significant event to the public transparency log.
 * Non-critical: failures are swallowed (logs shouldn't break the pipeline).
 */
export async function publishEvent(eventType, summary, agentId = null, workItemId = null, metadata = {}) {
  try {
    await query(
      `SELECT autobot_public.publish_event($1, $2, $3, $4, $5)`,
      [eventType, summary, agentId, workItemId, JSON.stringify(metadata)]
    );
  } catch {
    // Non-critical: public log failures must not affect the pipeline
  }
}

// ============================================================
// Cross-schema reconciliation (spec §12)
// ============================================================

/**
 * Run cross-schema reconciliation and log any issues found.
 * Returns the number of issues detected.
 */
export async function runReconciliation() {
  const result = await query(`SELECT * FROM agent_graph.reconcile_schemas()`);
  const issues = result.rows;

  if (issues.length > 0) {
    console.warn(`[reconciliation] Found ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.warn(`  [${issue.issue_type}] ${issue.schema_name}.${issue.table_name} ${issue.record_id}: ${issue.details}`);
    }
    await publishEvent('config_changed', `Schema reconciliation: ${issues.length} issue(s) found`, null, null, { issues });
  }

  return issues.length;
}

// ============================================================
// Hash chain checkpointing (spec §12)
// ============================================================

/**
 * Create a hash chain checkpoint. Verifies integrity and stores
 * the latest hash for faster future verification.
 */
export async function createHashCheckpoint() {
  await query(`SELECT agent_graph.create_hash_checkpoint()`);
}

// ============================================================
// Tool registry verification (spec §6)
// ============================================================

/**
 * Verify tool integrity at startup.
 * Computes SHA-256 hashes of tool source files and compares against registry.
 * Returns { verified, mismatches }.
 */
export async function verifyToolRegistry() {
  const toolsDir = join(__dirname, '..', '..', 'tools');
  let toolFiles;
  try {
    toolFiles = readdirSync(toolsDir).filter(f => f.endsWith('.js'));
  } catch {
    return { verified: 0, mismatches: [] };
  }

  const mismatches = [];
  let verified = 0;

  for (const file of toolFiles) {
    const toolName = file.replace('.js', '').replace(/-/g, '_');
    try {
      const content = readFileSync(join(toolsDir, file), 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');

      const result = await query(
        `SELECT tool_hash FROM agent_graph.tool_registry WHERE tool_name = $1`,
        [toolName]
      );

      if (result.rows.length > 0) {
        if (result.rows[0].tool_hash === 'builtin') {
          // First real startup: seed the hash so future runs compare normally
          await query(
            `UPDATE agent_graph.tool_registry SET tool_hash = $1, updated_at = now() WHERE tool_name = $2`,
            [hash, toolName]
          );
          verified++;
        } else if (result.rows[0].tool_hash !== hash) {
          mismatches.push({ tool: toolName, expected: result.rows[0].tool_hash, actual: hash });
        } else {
          verified++;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (mismatches.length > 0) {
    console.warn(`[tool-registry] ${mismatches.length} tool hash mismatch(es)!`);
    for (const m of mismatches) {
      console.warn(`  ${m.tool}: expected ${m.expected}, got ${m.actual}`);
    }
    await publishEvent('config_changed', `Tool registry: ${mismatches.length} mismatch(es)`, null, null, { mismatches });
  }

  return { verified, mismatches };
}

// ============================================================
// Agent activity log (agent_graph.agent_activity_steps)
// ============================================================

/**
 * Start an activity step. Returns the step ID, which can be passed as
 * parentStepId to create child steps (e.g., LLM call nested under a task
 * execution, or a sub-agent's execution nested under the calling agent).
 *
 * Non-critical: failures are swallowed — logging must never break the pipeline.
 */
export async function startActivityStep(workItemId, description, {
  type = null,
  parentStepId = null,
  agentId = null,
  campaignId = null,
  iterationNumber = null,
  metadata = {},
} = {}) {
  try {
    const result = await query(
      `INSERT INTO agent_graph.agent_activity_steps
       (work_item_id, campaign_id, iteration_number, parent_step_id, depth,
        agent_id, step_type, description, metadata)
       VALUES ($1, $2, $3, $4,
         COALESCE((SELECT depth + 1 FROM agent_graph.agent_activity_steps WHERE id = $4), 0),
         $5, $6, $7, $8)
       RETURNING id`,
      [workItemId, campaignId, iterationNumber, parentStepId,
       agentId, type, description, JSON.stringify(metadata)]
    );
    return result.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark an activity step as completed or failed.
 * Optionally merges additional metadata into the step's metadata field.
 *
 * Non-critical: failures are swallowed.
 */
export async function completeActivityStep(stepId, { status = 'completed', metadata = null } = {}) {
  if (!stepId) return;
  try {
    if (metadata) {
      await query(
        `UPDATE agent_graph.agent_activity_steps
         SET status = $1, completed_at = NOW(),
             metadata = metadata || $3::jsonb
         WHERE id = $2`,
        [status, stepId, JSON.stringify(metadata)]
      );
    } else {
      await query(
        `UPDATE agent_graph.agent_activity_steps
         SET status = $1, completed_at = NOW()
         WHERE id = $2`,
        [status, stepId]
      );
    }
  } catch {
    // Non-critical
  }
}

// ============================================================
// Comms shadow logging (autobot_comms)
// ============================================================

/**
 * Log a communication intent to the shadow comms log.
 * In Phase 1, this records what the system WOULD send.
 */
export async function logCommsIntent({ channel = 'email', recipient, subject, body, intentType = 'draft', sourceAgent = null, sourceTask = null }) {
  try {
    await query(
      `INSERT INTO autobot_comms.outbound_intents
       (channel, recipient, subject, body, intent_type, source_agent, source_task)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [channel, recipient, subject, body, intentType, sourceAgent, sourceTask]
    );
  } catch {
    // Non-critical
  }
}

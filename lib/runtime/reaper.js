import { query } from '../db.js';
import { transitionState } from './state-machine.js';
import { emit } from './event-bus.js';
import { publishEvent } from './infrastructure.js';

/**
 * Reaper: detect and recover stuck tasks (spec §11).
 *
 * Runs periodically. Finds tasks that have been in_progress longer than
 * the timeout threshold and transitions them to timed_out.
 * The orchestrator can then retry (up to max_retries) or escalate.
 *
 * No framework. Just a setInterval and a SQL query.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 60 * 1000; // check every 60s

export class Reaper {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.timer = null;
    // Track re-queue latencies for Phase 1 metric 8 (crash recovery < 60s)
    this.recentRequeueLatenciesMs = [];
  }

  start() {
    console.log(`[reaper] Starting (timeout: ${this.timeoutMs}ms, interval: ${this.intervalMs}ms)`);
    this.timer = setInterval(() => this.sweep().catch(err => {
      console.error('[reaper] Sweep error:', err.message);
    }), this.intervalMs);
    // Run immediately on start
    this.sweep().catch(err => console.error('[reaper] Initial sweep error:', err.message));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[reaper] Stopped');
  }

  async sweep() {
    // Find tasks stuck in in_progress beyond the timeout threshold.
    // All agents use the same timeout — executor-redesign writes heartbeats to
    // updated_at every 20s, so a 5-min stale threshold safely detects dead agents.
    const stuckResult = await query(
      `SELECT id, title, assigned_to, retry_count, updated_at, status
       FROM agent_graph.work_items
       WHERE (status = 'in_progress'
         AND updated_at < now() - ($1 || ' milliseconds')::interval)
         OR (status = 'assigned' AND assigned_to IS NOT NULL
             AND updated_at < now() - interval '60 minutes')
       ORDER BY updated_at
       LIMIT 10`,
      [this.timeoutMs]
    );

    if (stuckResult.rows.length === 0) return;

    console.log(`[reaper] Found ${stuckResult.rows.length} stuck task(s)`);

    for (const task of stuckResult.rows) {
      const retryCount = task.retry_count || 0;
      const stuckSinceMs = Date.now() - new Date(task.updated_at).getTime();

      // Stale-assigned tasks: never started, transition directly to cancelled
      // (assigned → timed_out is not a valid state transition)
      if (task.status === 'assigned') {
        console.log(`[reaper] Task ${task.id} stuck in assigned for ${Math.round(stuckSinceMs / 1000)}s → cancelled`);
        const cancelled = await transitionState({
          workItemId: task.id,
          toState: 'cancelled',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Stuck in assigned for > 60 minutes (agent never claimed)`,
        });
        if (!cancelled) {
          console.error(`[reaper] FAILED: ${task.id} transition assigned → cancelled returned false`);
        }
        continue;
      }

      if (retryCount >= this.maxRetries) {
        // Max retries exhausted — go straight to cancelled (terminal state).
        // Previously this went to 'failed', but failed is non-terminal and tasks
        // would linger indefinitely. Direct in_progress → cancelled is a valid
        // transition and ensures exhausted tasks don't show as stuck.
        console.log(`[reaper] Task ${task.id} exceeded max retries (${retryCount}/${this.maxRetries}) → cancelled`);
        const cancelled = await transitionState({
          workItemId: task.id,
          toState: 'cancelled',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Auto-cancelled: timed out after ${retryCount} retries (max: ${this.maxRetries})`,
        });
        if (!cancelled) {
          console.error(`[reaper] FAILED: ${task.id} transition in_progress → cancelled returned false`);
        } else {
          await publishEvent(
            'task_auto_cancelled',
            `Task "${task.title}" auto-cancelled after ${retryCount} retries`,
            'reaper',
            task.id
          );
        }
      } else {
        // Timeout — transition in_progress → timed_out → assigned (two-step recovery)
        // claim_next_task() only picks up events for work items in 'assigned' or 'created' state,
        // so we must complete the full timed_out → assigned transition before emitting the event.
        console.log(`[reaper] Task ${task.id} timed out (${Math.round(stuckSinceMs / 1000)}s in in_progress, retry ${retryCount}/${this.maxRetries}) → timed_out`);
        const timedOut = await transitionState({
          workItemId: task.id,
          toState: 'timed_out',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Stuck in in_progress for ${Math.round(stuckSinceMs / 1000)}s`,
        });
        if (!timedOut) {
          console.error(`[reaper] FAILED: ${task.id} transition in_progress → timed_out returned false`);
          continue;
        }

        // Transition timed_out → assigned so claim_next_task() can pick it up
        const reassigned = await transitionState({
          workItemId: task.id,
          toState: 'assigned',
          agentId: 'reaper',
          configHash: 'system',
          reason: `Reaper re-queue (retry ${retryCount + 1}/${this.maxRetries})`,
        });
        if (!reassigned) {
          console.error(`[reaper] FAILED: ${task.id} transition timed_out → assigned returned false`);
          continue;
        }

        // Both transitions succeeded — safe to increment retry count and emit event
        await query(
          `UPDATE agent_graph.work_items SET retry_count = retry_count + 1 WHERE id = $1`,
          [task.id]
        );

        // Emit re-queue event so the assigned agent picks it up again (spec §11)
        const targetAgent = task.assigned_to || 'orchestrator';
        await emit({
          eventType: 'task_assigned',
          workItemId: task.id,
          targetAgentId: targetAgent,
          priority: 0,
          eventData: { retry: retryCount + 1, reason: 'reaper_retry' },
        });

        // Track re-queue latency (Phase 1 metric 8: crash recovery < 60s)
        this.recentRequeueLatenciesMs.push(stuckSinceMs);
        console.log(`[reaper] Re-queued ${task.id}: timed_out → assigned (retry ${retryCount + 1}/${this.maxRetries}, latency ${(stuckSinceMs / 1000).toFixed(1)}s)`);
      }
    }

    // Keep only last 100 latencies to bound memory
    if (this.recentRequeueLatenciesMs.length > 100) {
      this.recentRequeueLatenciesMs = this.recentRequeueLatenciesMs.slice(-100);
    }

    // B5: Reclaim orphaned budget reservations for timed-out/failed tasks
    // Tasks that crashed after reserve_budget() but before commit/release leak reservations
    await this.reclaimOrphanedBudget();
  }

  /**
   * Get re-queue latency stats for Phase 1 metric 8 (crash recovery < 60s).
   * Returns { count, avg_ms, max_ms, p95_ms } or null if no data.
   */
  getRequeueLatencyStats() {
    const data = this.recentRequeueLatenciesMs;
    if (data.length === 0) return null;
    const sorted = [...data].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    return {
      count: data.length,
      avg_ms: Math.round(data.reduce((s, v) => s + v, 0) / data.length),
      max_ms: sorted[sorted.length - 1],
      p95_ms: sorted[p95Index],
    };
  }

  async reclaimOrphanedBudget() {
    // Find tasks that are no longer in_progress but may still have leaked reservations.
    // The budget reservation is tied to the daily budget row, not individual tasks.
    // Reset reserved_usd to match only currently in-progress estimated costs.
    const result = await query(
      `UPDATE agent_graph.budgets
       SET reserved_usd = GREATEST(0,
         (SELECT COALESCE(COUNT(*), 0) FROM agent_graph.work_items WHERE status = 'in_progress')
         * 0.01),
         updated_at = now()
       WHERE scope = 'daily' AND period_start = CURRENT_DATE
         AND reserved_usd > 0
       RETURNING reserved_usd`
    );
    if (result.rows.length > 0 && parseFloat(result.rows[0].reserved_usd) === 0) {
      console.log('[reaper] Reclaimed orphaned budget reservations');
    }
  }
}

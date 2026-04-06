import { runTier1Audit } from '../audit/tier1-deterministic.js';
import { runTier2Audit } from '../audit/tier2-ai-auditor.js';
import { runTier3Audit } from '../audit/tier3-cross-model.js';
import { query } from '../db.js';

/**
 * Audit API routes.
 *
 * GET /api/audit/tier1    — trigger a fresh tier-1 deterministic audit
 * GET /api/audit/tier2    — trigger a fresh tier-2 AI audit
 * GET /api/audit/tier3    — trigger a fresh tier-3 cross-model audit
 * GET /api/audit/findings — query recent audit findings from DB
 * GET /api/audit/summary  — query audit stats
 * GET /api/audit/runs     — query recent audit runs
 */
export function registerAuditRoutes(routes) {
  // GET /api/audit/tier1 — trigger fresh tier-1 deterministic audit
  routes.set('GET /api/audit/tier1', async () => {
    const result = await runTier1Audit();
    return { result };
  });

  // GET /api/audit/tier2 — trigger fresh tier-2 AI audit
  routes.set('GET /api/audit/tier2', async () => {
    const result = await runTier2Audit();
    return { result };
  });

  // GET /api/audit/tier3 — trigger fresh tier-3 cross-model audit
  routes.set('GET /api/audit/tier3', async () => {
    const result = await runTier3Audit();
    return { result };
  });

  // GET /api/audit/findings — query recent audit findings from DB
  routes.set('GET /api/audit/findings', async () => {
    try {
      const result = await query(
        `SELECT * FROM agent_graph.audit_findings
         ORDER BY created_at DESC
         LIMIT 50`
      );
      return { findings: result.rows };
    } catch (err) {
      if (err.message?.includes('does not exist')) return { findings: [], note: 'Table not yet created' };
      throw err;
    }
  });

  // GET /api/audit/summary — query audit stats
  routes.set('GET /api/audit/summary', async () => {
    try {
      const total = await query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
                COUNT(*) FILTER (WHERE severity = 'warning') AS warnings,
                COUNT(*) FILTER (WHERE severity = 'info') AS info,
                COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
                COUNT(*) FILTER (WHERE resolved_at IS NULL AND status != 'dismissed') AS unresolved
         FROM agent_graph.audit_findings`
      );
      return { summary: total.rows[0] || null };
    } catch (err) {
      if (err.message?.includes('does not exist')) return { summary: null, note: 'Table not yet created' };
      throw err;
    }
  });

  // GET /api/audit/runs — query recent audit runs (last 10)
  routes.set('GET /api/audit/runs', async () => {
    try {
      const result = await query(
        `SELECT id, audit_tier, model_used, status, findings_count, started_at, completed_at
         FROM agent_graph.audit_runs
         ORDER BY started_at DESC
         LIMIT 10`
      );
      return { runs: result.rows };
    } catch (err) {
      if (err.message?.includes('does not exist')) return { runs: [], note: 'Table not yet created' };
      throw err;
    }
  });
}

/**
 * Claw Learning — Neo4j integration for Explorer + Campaigner (ADR-021, Phase G)
 *
 * Records outcomes to the knowledge graph so both Claws learn from experience:
 *
 * 1. Exploration outcomes → (:ExplorationCycle)-[:FOUND]->(:Finding)-[:IN_DOMAIN]->(:Domain)
 * 2. Campaign outcomes → (:Campaign)-[:USED_STRATEGY]->(:Strategy), (:Campaign)-[:ACHIEVED]->(:Outcome)
 * 3. Strategy effectiveness → query which strategies work for which campaign types
 * 4. Domain yield → query which domains produce the most actionable findings
 *
 * Graceful degradation: if Neo4j is unavailable, all functions return silently.
 */

import { runCypher, isGraphAvailable } from './client.js';

/**
 * Record an exploration cycle and its findings to the knowledge graph.
 *
 * @param {string} cycleId
 * @param {string} domain
 * @param {Array<{title: string, severity: string, pattern?: string}>} findings
 * @param {number} durationMs
 */
export async function recordExplorationCycle(cycleId, domain, findings, durationMs) {
  if (!isGraphAvailable()) return;

  try {
    // Create/merge domain node and cycle node
    await runCypher(`
      MERGE (d:Domain {name: $domain})
      CREATE (c:ExplorationCycle {
        id: $cycleId,
        domain: $domain,
        findings_count: $findingsCount,
        duration_ms: $durationMs,
        created_at: datetime()
      })
      MERGE (c)-[:IN_DOMAIN]->(d)
    `, {
      cycleId,
      domain,
      findingsCount: findings.length,
      durationMs,
    });

    // Create finding nodes
    for (const finding of findings) {
      await runCypher(`
        MATCH (c:ExplorationCycle {id: $cycleId})
        CREATE (f:Finding {
          title: $title,
          severity: $severity,
          pattern: $pattern,
          created_at: datetime()
        })
        MERGE (c)-[:FOUND]->(f)
      `, {
        cycleId,
        title: finding.title,
        severity: finding.severity,
        pattern: finding.pattern || 'unknown',
      });
    }
  } catch (err) {
    console.warn(`[claw-learning] Failed to record exploration cycle: ${err.message}`);
  }
}

/**
 * Record a campaign iteration outcome to the knowledge graph.
 *
 * @param {string} campaignId
 * @param {number} iterationNumber
 * @param {Object} strategy - Strategy used (from LLM planner)
 * @param {string} decision - keep/discard/stop_success/etc.
 * @param {number|null} qualityScore
 * @param {string|null} failureAnalysis
 */
export async function recordCampaignIteration(campaignId, iterationNumber, strategy, decision, qualityScore, failureAnalysis) {
  if (!isGraphAvailable()) return;

  try {
    const strategyName = strategy?.approach || strategy?.name || 'unnamed';

    // Ensure campaign node exists
    await runCypher(`
      MERGE (camp:Campaign {id: $campaignId})
      ON CREATE SET camp.created_at = datetime()
    `, { campaignId });

    // Create iteration and link to strategy
    await runCypher(`
      MATCH (camp:Campaign {id: $campaignId})
      MERGE (s:Strategy {name: $strategyName})
      CREATE (it:Iteration {
        campaign_id: $campaignId,
        number: $iterationNumber,
        decision: $decision,
        quality_score: $qualityScore,
        created_at: datetime()
      })
      MERGE (it)-[:USED_STRATEGY]->(s)
      MERGE (camp)-[:HAS_ITERATION]->(it)
    `, {
      campaignId,
      strategyName,
      iterationNumber,
      decision,
      qualityScore: qualityScore ?? 0,
    });

    // If strategy was discarded, record the failure reason
    if (decision === 'discard' && failureAnalysis) {
      await runCypher(`
        MATCH (s:Strategy {name: $strategyName})
        MERGE (s)-[r:FAILED_IN]->(camp:Campaign {id: $campaignId})
        SET r.reason = $reason, r.iteration = $iterationNumber, r.updated_at = datetime()
      `, {
        strategyName,
        campaignId,
        reason: failureAnalysis.slice(0, 500),
        iterationNumber,
      });
    }
  } catch (err) {
    console.warn(`[claw-learning] Failed to record campaign iteration: ${err.message}`);
  }
}

/**
 * Record campaign completion outcome.
 *
 * @param {string} campaignId
 * @param {string} status - succeeded/failed/cancelled
 * @param {number} totalIterations
 * @param {number} totalSpent
 * @param {number|null} bestScore
 */
export async function recordCampaignOutcome(campaignId, status, totalIterations, totalSpent, bestScore) {
  if (!isGraphAvailable()) return;

  try {
    await runCypher(`
      MERGE (camp:Campaign {id: $campaignId})
      SET camp.status = $status,
          camp.total_iterations = $totalIterations,
          camp.total_spent = $totalSpent,
          camp.best_score = $bestScore,
          camp.completed_at = datetime()
    `, {
      campaignId,
      status,
      totalIterations,
      totalSpent,
      bestScore: bestScore ?? 0,
    });
  } catch (err) {
    console.warn(`[claw-learning] Failed to record campaign outcome: ${err.message}`);
  }
}

/**
 * Query which strategies have been most effective for a given campaign goal pattern.
 * Used by strategy-planner.js to inform strategy selection.
 *
 * @param {string} goalKeyword - Keyword from the campaign goal
 * @param {number} [limit=5]
 * @returns {Promise<Array<{strategy: string, avg_score: number, success_rate: number, uses: number}>>}
 */
export async function queryEffectiveStrategies(goalKeyword, limit = 5) {
  if (!isGraphAvailable()) return [];

  try {
    const records = await runCypher(`
      MATCH (camp:Campaign)-[:HAS_ITERATION]->(it:Iteration)-[:USED_STRATEGY]->(s:Strategy)
      WHERE camp.status IS NOT NULL
      WITH s,
           COUNT(it) AS uses,
           AVG(it.quality_score) AS avg_score,
           toFloat(COUNT(CASE WHEN it.decision = 'keep' THEN 1 END)) / COUNT(it) AS success_rate
      WHERE uses >= 3
      RETURN s.name AS strategy, avg_score, success_rate, uses
      ORDER BY avg_score * success_rate DESC
      LIMIT $limit
    `, { limit }, { readOnly: true });

    return (records || []).map(r => ({
      strategy: r.get('strategy'),
      avg_score: r.get('avg_score'),
      success_rate: r.get('success_rate'),
      uses: r.get('uses').toInt(),
    }));
  } catch (err) {
    console.warn(`[claw-learning] Strategy query failed: ${err.message}`);
    return [];
  }
}

/**
 * Query domain yield stats for the Explorer's domain selector.
 *
 * @param {number} [days=30]
 * @returns {Promise<Array<{domain: string, total_findings: number, cycles: number, avg_findings: number}>>}
 */
export async function queryDomainYield(days = 30) {
  if (!isGraphAvailable()) return [];

  try {
    const records = await runCypher(`
      MATCH (c:ExplorationCycle)-[:IN_DOMAIN]->(d:Domain)
      WHERE c.created_at > datetime() - duration('P' + toString($days) + 'D')
      WITH d.name AS domain,
           SUM(c.findings_count) AS total_findings,
           COUNT(c) AS cycles
      RETURN domain, total_findings, cycles,
             toFloat(total_findings) / cycles AS avg_findings
      ORDER BY avg_findings DESC
    `, { days }, { readOnly: true });

    return (records || []).map(r => ({
      domain: r.get('domain'),
      total_findings: r.get('total_findings').toInt(),
      cycles: r.get('cycles').toInt(),
      avg_findings: r.get('avg_findings'),
    }));
  } catch (err) {
    console.warn(`[claw-learning] Domain yield query failed: ${err.message}`);
    return [];
  }
}

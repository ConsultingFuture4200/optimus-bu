/**
 * Strategy Planner (ADR-021)
 *
 * LLM-driven strategy selection for campaign iterations.
 * Reads campaign_iterations history (what's been tried, what worked/failed)
 * and determines the next strategy to try.
 *
 * Self-correction is structural:
 * 1. campaign_iterations query gives full history of attempts + quality scores
 * 2. failure_analysis from discarded iterations tells what NOT to repeat
 * 3. strategy_adjustment proposes what to try differently
 */

import { query } from '../../lib/db.js';
import { queryEffectiveStrategies } from '../../lib/graph/claw-learning.js';
import { queryRAG } from '../../lib/rag/client.js';

/**
 * Get iteration history for strategy context.
 * Returns the last N iterations with their outcomes.
 */
export async function getIterationHistory(campaignId, limit = 20) {
  const result = await query(
    `SELECT iteration_number, strategy_used, action_taken,
            quality_score, decision, failure_analysis, strategy_adjustment,
            cost_usd, duration_ms
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1
     ORDER BY iteration_number DESC
     LIMIT $2`,
    [campaignId, limit]
  );
  return result.rows.reverse(); // chronological order
}

/**
 * Get campaign context for strategy planning.
 */
export async function getCampaignContext(campaignId) {
  const result = await query(
    `SELECT c.goal_description, c.success_criteria, c.constraints,
            c.budget_envelope_usd, c.spent_usd, c.completed_iterations,
            c.max_iterations, c.campaign_mode,
            c.budget_envelope_usd - c.spent_usd - c.reserved_usd AS remaining_usd
     FROM agent_graph.campaigns c
     WHERE c.id = $1`,
    [campaignId]
  );
  return result.rows[0] || null;
}

/**
 * Build the strategy planning prompt for the LLM.
 * Includes goal, history, failures, and remaining budget.
 */
export async function buildStrategyPrompt(campaignContext, iterationHistory) {
  const { goal_description, success_criteria, remaining_usd, completed_iterations, max_iterations } = campaignContext;

  const historyBlock = iterationHistory.length > 0
    ? iterationHistory.map(it => {
        const decision = it.decision === 'keep' ? '✓ KEPT' : it.decision === 'discard' ? '✗ DISCARDED' : it.decision;
        return `  #${it.iteration_number}: ${decision} | score=${it.quality_score ?? 'N/A'} | strategy=${JSON.stringify(it.strategy_used)}${it.failure_analysis ? `\n    Failure: ${it.failure_analysis}` : ''}${it.strategy_adjustment ? `\n    Adjustment: ${it.strategy_adjustment}` : ''}`;
      }).join('\n')
    : '  (no iterations yet — this is the first attempt)';

  // Extract what has been tried and failed
  const failedStrategies = iterationHistory
    .filter(it => it.decision === 'discard')
    .map(it => it.strategy_used);

  const bestScore = iterationHistory
    .filter(it => it.quality_score != null)
    .reduce((best, it) => Math.max(best, parseFloat(it.quality_score)), 0);

  // Load RAG knowledge base context relevant to the campaign goal
  const ragContext = await getCampaignRAGContext(campaignContext);

  return `You are planning the next iteration strategy for a campaign.

GOAL:
${goal_description}

SUCCESS CRITERIA:
${JSON.stringify(success_criteria, null, 2)}

${ragContext ? `${ragContext}\n` : ''}ITERATION HISTORY (${completed_iterations}/${max_iterations} completed, $${parseFloat(remaining_usd).toFixed(2)} remaining):
${historyBlock}

BEST SCORE SO FAR: ${bestScore}

${failedStrategies.length > 0 ? `STRATEGIES THAT FAILED (do NOT repeat these):
${failedStrategies.map(s => `  - ${JSON.stringify(s)}`).join('\n')}` : ''}

${await getGraphHints()}

Respond with a JSON object describing your next strategy:
{
  "strategy": { "approach": "...", "parameters": {...} },
  "rationale": "Why this strategy, given history",
  "expected_improvement": "What specific improvement you expect"
}

Be specific. Vary your approach based on what has and hasn't worked.`;
}

/**
 * Parse the LLM's strategy response.
 * Returns structured strategy or a fallback.
 */
export function parseStrategyResponse(llmResponse) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        strategy: parsed.strategy || { approach: 'default' },
        rationale: parsed.rationale || '',
        expectedImprovement: parsed.expected_improvement || '',
      };
    }
  } catch {
    // JSON parse failed
  }

  // Fallback: use the raw response as the strategy description
  return {
    strategy: { approach: 'llm_directed', description: llmResponse.slice(0, 500) },
    rationale: 'Parsed from unstructured LLM response',
    expectedImprovement: 'unknown',
  };
}

/**
 * Query RAG knowledge base for context relevant to the campaign goal.
 * Extracts key topics from the goal and retrieves knowledge base docs.
 * Returns a formatted context block or empty string if unavailable.
 */
async function getCampaignRAGContext(campaignContext) {
  try {
    const goal = campaignContext.goal_description || '';
    if (!goal) return '';

    // Query the knowledge base with the campaign goal as context
    const result = await queryRAG(
      `Provide all relevant context about: ${goal.slice(0, 500)}`,
      { scope: 'campaign', kbOnly: true }
    );

    if (!result?.answer) return '';

    console.log(`[campaigner] RAG context loaded (${result.citations?.length || 0} citations)`);

    const block = [`KNOWLEDGE BASE CONTEXT (from documents, transcripts, and internal knowledge):\n${result.answer}`];
    if (result.citations?.length > 0) {
      block.push(`\nSources: ${result.citations.map(c => c.title || c.source || 'doc').join(', ')}`);
    }
    block.push('\nUse this context to inform your strategy. Do NOT invent details beyond what is provided.');
    return block.join('\n');
  } catch (err) {
    console.log(`[campaigner] RAG context unavailable: ${err.message}`);
    return '';
  }
}

/**
 * Get strategy hints from Neo4j knowledge graph.
 * Returns a prompt block with effective strategies from past campaigns,
 * or empty string if Neo4j is unavailable.
 */
async function getGraphHints() {
  try {
    const effective = await queryEffectiveStrategies('', 5);
    if (effective.length === 0) return '';

    const lines = effective.map(s =>
      `  - "${s.strategy}" (avg score: ${s.avg_score?.toFixed(3) || 'N/A'}, success rate: ${(s.success_rate * 100).toFixed(0)}%, used ${s.uses}x)`
    ).join('\n');

    return `STRATEGIES THAT WORKED IN PAST CAMPAIGNS (consider these):
${lines}`;
  } catch {
    return '';
  }
}

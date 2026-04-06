/**
 * Campaign Iteration Loop (ADR-021)
 *
 * Core autoresearch-inspired loop for stateless AND stateful campaigns:
 *   1. Pre-checks (halt, budget, deadline, plateau)
 *   2. Create iteration work_item (for guardCheck + audit chain)
 *   3. Plan strategy (LLM reads history of attempts)
 *   4. Execute strategy
 *   5. Measure against success_criteria + content_policy
 *   6. Decide: keep/discard/stop
 *   7. Log to campaign_iterations (append-only)
 *   8. Commit/release budget
 *
 * The board approves the envelope. The loop runs autonomously inside it.
 */

import { execFile } from 'child_process';
import { query } from '../../lib/db.js';
import { spawnCLI } from '../../lib/runtime/spawn-cli.js';
import { createWorkItem, transitionState } from '../../lib/runtime/state-machine.js';
import { guardCheck } from '../../lib/runtime/guard-check.js';
import { publishEvent, startActivityStep, completeActivityStep } from '../../lib/runtime/infrastructure.js';
import { reserveBudget, releaseBudget, commitSpend, estimateIterationCost } from './campaign-budget.js';
import { evaluateSuccessCriteria, evaluateBuildOutput, evaluateContentPolicy } from './campaign-scorer.js';
import { preIterationChecks } from './circuit-breaker.js';
import { getIterationHistory, getCampaignContext, buildStrategyPrompt, parseStrategyResponse } from './strategy-planner.js';
import { createWorkspace, commitImprovement, resetRegression, getCumulativeDiff, readGoal, cleanupWorkspace, pushBranch, createProjectWorkspace, cleanupProjectWorkspace } from './campaign-workspace.js';
import { deployProject } from './project-deploy.js';
import { recordCampaignIteration, recordCampaignOutcome } from '../../lib/graph/claw-learning.js';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';
import { createCliEventLogger } from '../../lib/runtime/cli-event-logger.js';
import { awaitHumanInput } from '../../lib/hitl/index.js';
import { notifyBoard, notifyCreator } from '../../autobot-inbox/src/telegram/sender.js';

// ============================================================
// Error classification + retry helpers
// ============================================================

const TRANSIENT_PATTERNS = [
  { pattern: /rate.?limit|429|too many requests/i, category: 'rate_limit' },
  { pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError/i, category: 'timeout' },
  { pattern: /ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENOTFOUND/i, category: 'network' },
  { pattern: /JSON|Unexpected token|Unexpected end/i, category: 'json_parse' },
  { pattern: /service.?busy|overloaded|503|502|504/i, category: 'service_busy' },
  { pattern: /stall.?detect|watchdog/i, category: 'stall' },
];

const FATAL_PATTERNS = [
  { pattern: /guard.?check.?fail/i, category: 'guard_check' },
  { pattern: /budget.?exceed|budget_exceeded|stop_budget/i, category: 'budget' },
  { pattern: /campaign.?cancel/i, category: 'cancelled' },
  { pattern: /max.?iteration/i, category: 'max_iterations' },
];

/**
 * Classify an error as transient (retryable) or fatal (stop campaign).
 * Returns { transient: boolean, category: string }
 */
function classifyError(err) {
  const msg = err?.message || String(err);

  for (const { pattern, category } of FATAL_PATTERNS) {
    if (pattern.test(msg)) return { transient: false, category };
  }
  for (const { pattern, category } of TRANSIENT_PATTERNS) {
    if (pattern.test(msg)) return { transient: true, category };
  }

  // AbortError from iteration timeout is transient (already handled upstream, but classify for completeness)
  if (err?.name === 'AbortError') return { transient: true, category: 'timeout' };

  return { transient: false, category: 'unknown' };
}

/** Exponential backoff with jitter: 30s, 60s, 120s base + up to 25% jitter */
function retryDelayMs(attempt) {
  const base = 30_000 * Math.pow(2, attempt); // 30s, 60s, 120s
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

const MAX_RETRIES = 3;

/**
 * Run the full campaign loop until completion or stop condition.
 *
 * @param {string} campaignId
 * @param {Object} agentConfig - Agent config from agents.json
 * @param {Object} modelsConfig - Model pricing from agents.json
 * @param {AbortSignal} [signal] - External abort signal (e.g., from runner shutdown)
 */
export async function runCampaignLoop(campaignId, agentConfig, modelsConfig, signal = null) {
  const configHash = agentConfig.configHash || 'claw-campaigner-v1';
  const agentId = 'claw-campaigner';

  // Load campaign
  const campaign = await getCampaignContext(campaignId);
  if (!campaign) {
    console.error(`[campaigner] Campaign ${campaignId} not found`);
    return;
  }

  // Get the campaign's work_item_id for parent linkage
  const campaignRow = await query(
    `SELECT work_item_id, iteration_time_budget, constraints, campaign_mode, workspace_path, metadata
     FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const campaignWorkItemId = campaignRow.rows[0]?.work_item_id;
  const iterationTimeBudgetMs = parseIntervalToMs(campaignRow.rows[0]?.iteration_time_budget || '5 minutes');
  const constraints = typeof campaignRow.rows[0]?.constraints === 'string'
    ? JSON.parse(campaignRow.rows[0].constraints)
    : campaignRow.rows[0]?.constraints || {};
  const campaignMode = campaignRow.rows[0]?.campaign_mode;
  const isStateful = campaignMode === 'stateful';
  const isProject = campaignMode === 'project';
  let workspacePath = campaignRow.rows[0]?.workspace_path;
  const campaignMeta = typeof campaignRow.rows[0]?.metadata === 'string'
    ? JSON.parse(campaignRow.rows[0].metadata)
    : campaignRow.rows[0]?.metadata || {};

  // Stateless build campaigns produce output as text (no repo writes).
  // Stateful and project campaigns get file tools. Only pure stateless get text-only.
  const isBuildCampaign = !isStateful && !isProject && (
    campaignMeta.campaign_type === 'build' ||
    /\b(build|create|generate|design|site|app|page|landing|website|dashboard|api)\b/i.test(campaign.goal_description || '')
  );

  console.log(`[campaigner] Starting campaign loop: ${campaignId}`);
  console.log(`[campaigner]   Mode: ${isProject ? 'project (fresh repo + deploy)' : isStateful ? 'stateful (git worktree)' : isBuildCampaign ? 'build (text output, no tools)' : 'stateless'}`);
  console.log(`[campaigner]   Goal: ${campaign.goal_description?.slice(0, 100)}...`);
  console.log(`[campaigner]   Budget: $${parseFloat(campaign.remaining_usd).toFixed(2)} remaining`);
  console.log(`[campaigner]   Iterations: ${campaign.completed_iterations}/${campaign.max_iterations}`);

  // Phase C: Initialize git worktree for stateful campaigns
  if (isStateful && !workspacePath) {
    const successCriteria = typeof campaign.success_criteria === 'string'
      ? JSON.parse(campaign.success_criteria) : campaign.success_criteria;
    workspacePath = await createWorkspace(campaignId, campaign.goal_description, successCriteria);
    console.log(`[campaigner]   Workspace: ${workspacePath}`);
  }

  // Project mode: fresh GitHub repo + local clone (not a worktree)
  if (isProject && !workspacePath) {
    workspacePath = await createProjectWorkspace(campaignId, campaign.goal_description);
    console.log(`[campaigner]   Project workspace: ${workspacePath}`);
  }

  // Update campaign status to running
  await query(
    `UPDATE agent_graph.campaigns SET campaign_status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
    [campaignId]
  );

  await publishEvent('campaign_started', `Campaign started: ${campaign.goal_description?.slice(0, 80)}`, agentId, campaignWorkItemId, { campaign_id: campaignId }).catch(() => {});
  notifyBoard(`🚀 Campaign started: "${campaign.goal_description?.slice(0, 80)}"\nID: ${campaignId}`).catch(() => {});

  let iterationNumber = campaign.completed_iterations;
  let consecutiveFailures = 0;

  while (true) {
    // External abort (runner shutdown)
    if (signal?.aborted) {
      console.log(`[campaigner] Campaign ${campaignId} — external abort`);
      await pauseCampaign(campaignId, 'external_abort');
      return;
    }

    // Write heartbeat (fire-and-forget — 1ms, non-critical)
    query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

    iterationNumber++;
    console.log(`[campaigner] ── Iteration #${iterationNumber} starting ──`);

    // --- STEP 1: Pre-iteration checks ---
    const checks = await preIterationChecks(campaignId);
    if (!checks.canContinue) {
      await stopCampaign(campaignId, checks.stopReason, campaignWorkItemId, agentId, configHash);
      return;
    }

    // --- STEP 2: Reserve budget ---
    const estimatedCost = estimateIterationCost(
      agentConfig.model, 8000, 2000, modelsConfig
    );
    const budgetOk = await reserveBudget(campaignId, estimatedCost);
    if (!budgetOk) {
      await stopCampaign(campaignId, 'stop_budget', campaignWorkItemId, agentId, configHash);
      return;
    }

    let iterationWorkItemId = null;
    let iterationCost = 0;
    const iterationStart = Date.now();
    let iterationStepId = null; // root activity step for this iteration

    try {
      // --- STEP 3: Create iteration work_item (for guardCheck + audit) ---
      const iterationItem = await createWorkItem({
        type: 'subtask',
        title: `Campaign ${campaignId} iteration #${iterationNumber}`,
        description: `Autonomous campaign iteration`,
        createdBy: agentId,
        parentId: campaignWorkItemId,
        assignedTo: agentId,
        priority: 0,
        metadata: {
          campaign_id: campaignId,
          iteration_number: iterationNumber,
          source: 'campaign_loop',
        },
      });
      iterationWorkItemId = iterationItem.id;

      // Open the root activity step for this iteration
      iterationStepId = await startActivityStep(
        campaignWorkItemId,
        `Campaign iteration #${iterationNumber}`,
        { type: 'campaign_iteration', agentId, campaignId, iterationNumber }
      );

      // --- STEP 4: guardCheck on the iteration work_item ---
      const guard = await guardCheck({
        action: 'campaign_iteration',
        agentId,
        configHash,
        taskId: iterationWorkItemId,
        estimatedCostUsd: estimatedCost,
      });

      if (!guard.allowed) {
        console.warn(`[campaigner] Guard check failed for iteration #${iterationNumber}: ${guard.reason}`);
        await transitionState({ workItemId: iterationWorkItemId, toState: 'blocked', agentId, configHash, reason: guard.reason });
        await releaseBudget(campaignId, estimatedCost);
        await logIteration(campaignId, iterationWorkItemId, iterationNumber, {}, null, null, 'stop_error', 0, Date.now() - iterationStart, `Guard check failed: ${guard.reason}`);
        await completeActivityStep(iterationStepId, { status: 'failed', metadata: { reason: `Guard check failed: ${guard.reason}` } });
        await stopCampaign(campaignId, 'stop_error', campaignWorkItemId, agentId, configHash);
        return;
      }

      // Transition to in_progress
      await transitionState({ workItemId: iterationWorkItemId, toState: 'in_progress', agentId, configHash, reason: 'Starting campaign iteration' });

      // --- STEP 5: Set up iteration timeout (JS-enforced) ---
      const iterationController = new AbortController();
      const timeout = setTimeout(() => iterationController.abort(), iterationTimeBudgetMs);

      try {
        // --- STEP 6: Plan strategy ---
        const history = await getIterationHistory(campaignId);

        // Phase C: Add workspace context for stateful campaigns
        let workspaceContext = '';
        if ((isStateful || isProject) && workspacePath) {
          const goalMd = await readGoal(workspacePath);
          const diff = await getCumulativeDiff(workspacePath);
          workspaceContext = goalMd ? `\nWORKSPACE GOAL:\n${goalMd}\n` : '';
          workspaceContext += diff ? `\nCUMULATIVE CHANGES (git diff --stat):\n${diff}\n` : '';
        }

        const strategyPrompt = (await buildStrategyPrompt(campaign, history)) + workspaceContext;
        console.log(`[campaigner]   Planning strategy (${history.length} prior iterations)...`);

        // ADR-017: permission check for subprocess:claude_cli before spawning CLI
        await requirePermission(agentId, 'subprocess', 'claude_cli');

        const planStepId = await startActivityStep(
          campaignWorkItemId, 'Planning strategy',
          { type: 'planning', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );
        const cliConfig = agentConfig.claudeCode || {};
        const planEventLogger = createCliEventLogger({
          parentStepId: planStepId,
          workItemId: campaignWorkItemId,
          campaignId,
          iterationNumber,
          agentId,
        });
        const planResult = await spawnCLI({
          prompt: strategyPrompt,
          systemPrompt: 'You are a campaign strategy planner. Respond with JSON only.',
          model: cliConfig.model || 'sonnet',
          maxTurns: 3,
          maxBudgetUsd: 0.50,
          allowedTools: [],  // pure reasoning — no tools needed
          workDir: workspacePath || process.cwd(),
          label: `campaign-plan-${campaignId}-${iterationNumber}`,
          agentTag: 'claw-campaigner',
          timeoutMs: iterationTimeBudgetMs,
          streamEvents: true,
          onEvent: planEventLogger,
        });
        console.log(`[campaigner] Plan CLI completed (${planResult.numTurns} turns, $${(planResult.costUsd || 0).toFixed(4)}, ${Math.round((planResult.durationMs || 0) / 1000)}s)`);
        if (planResult.result) {
          console.log(`[campaigner] Plan output: ${planResult.result.slice(0, 500)}${planResult.result.length > 500 ? '...' : ''}`);
        }
        if (planResult.isError) {
          console.error(`[campaigner] Plan error: ${planResult.error}`);
          throw new Error(`Plan step failed: ${planResult.error}`);
        }
        const planCost = planResult.costUsd || 0;
        iterationCost += planCost;
        await completeActivityStep(planStepId, { metadata: {
          cost_usd: planCost,
          num_turns: planResult.numTurns || 0,
          duration_ms: planResult.durationMs || 0,
          model: cliConfig.model || 'sonnet',
          is_error: planResult.isError || false,
        } });

        // Heartbeat after plan step (fire-and-forget)
        query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

        const planText = planResult.result || '';
        const { strategy, rationale } = parseStrategyResponse(planText);

        // --- HITL: pause if strategy requests operator clarification ---
        let hitlContext = '';
        if (strategy.hitl_question) {
          console.log(`[campaigner] HITL requested: "${strategy.hitl_question}"`);
          notifyCreator(campaignId, `⏸️ Campaign needs your input!\n\nQ: "${strategy.hitl_question}"\n\nRespond at board.staqs.io/campaigns/${campaignId}`).catch(() => {});
          const hitlAnswer = await awaitHumanInput(campaignId, strategy.hitl_question, agentId);
          console.log(`[campaigner] HITL answered: "${hitlAnswer.slice(0, 100)}"`);
          hitlContext = `\n\nOPERATOR CLARIFICATION:\nQ: ${strategy.hitl_question}\nA: ${hitlAnswer}`;
          // Resume campaign (awaitHumanInput leaves status=running after respond API fires)
        }

        // --- STEP 7: Execute strategy ---
        // For stateless campaigns, execution IS the LLM call.
        // The strategy determines what the LLM does next.
        console.log(`[campaigner]   Executing strategy: ${rationale?.slice(0, 100) || 'no rationale'}...`);
        const executePrompt = buildExecutionPrompt(campaign, strategy, constraints, hitlContext);

        const execStepId = await startActivityStep(
          campaignWorkItemId, 'Executing strategy',
          { type: 'strategy_execution', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );
        const execEventLoggerBase = createCliEventLogger({
          parentStepId: execStepId,
          workItemId: campaignWorkItemId,
          campaignId,
          iterationNumber,
          agentId,
        });
        // Accumulate assistant text from stream events as fallback for empty execResult.result
        const streamedTextChunks = [];
        const execEventLogger = (event) => {
          // Capture assistant text content from stream events
          if (event.type === 'content_block_delta' && event.delta?.text) {
            streamedTextChunks.push(event.delta.text);
          } else if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) streamedTextChunks.push(block.text);
            }
          }
          return execEventLoggerBase(event);
        };
        // Build campaigns: no tools → LLM outputs code as text (downloadable).
        // Stateful/workshop campaigns: full tools → LLM edits files in worktree.
        const execTools = isBuildCampaign ? [] : (cliConfig.allowedTools || [
          'Read', 'Edit', 'Write', 'Glob', 'Grep',
          'Bash(git *)', 'Bash(npm *)', 'Bash(node *)',
          'Bash(ls *)', 'Bash(pwd)',
        ]);
        if (isBuildCampaign) {
          console.log(`[campaigner]   Build mode: tools disabled — output will be text-only`);
        }

        const execResult = await spawnCLI({
          prompt: executePrompt,
          model: cliConfig.model || 'sonnet',
          maxTurns: isBuildCampaign ? 3 : (cliConfig.maxTurns || 30),
          maxBudgetUsd: cliConfig.maxBudgetUsd || 2.00,
          allowedTools: execTools,
          workDir: workspacePath || process.cwd(),
          label: `campaign-exec-${campaignId}-${iterationNumber}`,
          agentTag: 'claw-campaigner',
          timeoutMs: iterationTimeBudgetMs,
          streamEvents: true,
          onEvent: execEventLogger,
        });
        console.log(`[campaigner] Exec CLI completed (${execResult.numTurns} turns, $${(execResult.costUsd || 0).toFixed(4)}, ${Math.round((execResult.durationMs || 0) / 1000)}s)`);
        if (execResult.result) {
          const preview = execResult.result.slice(0, 800);
          console.log(`[campaigner] Exec output:\n${preview}${execResult.result.length > 800 ? '\n  ... (truncated)' : ''}`);
        }
        if (execResult.isError) {
          console.error(`[campaigner] Exec error: ${execResult.error}`);
          throw new Error(`Execute step failed: ${execResult.error}`);
        }
        const execCost = execResult.costUsd || 0;
        iterationCost += execCost;
        await completeActivityStep(execStepId, { metadata: {
          cost_usd: execCost,
          num_turns: execResult.numTurns || 0,
          duration_ms: execResult.durationMs || 0,
          model: cliConfig.model || 'sonnet',
          is_error: execResult.isError || false,
        } });

        // Heartbeat after execute step (fire-and-forget)
        query(`UPDATE agent_graph.campaigns SET last_heartbeat_at = now() WHERE id = $1`, [campaignId]).catch(() => {});

        // Use parsed result, or fall back to accumulated stream text if result is empty
        // (stream-json summary line sometimes has empty result when content was streamed)
        const executeText = execResult.result || streamedTextChunks.join('') || '';

        // --- STEP 8: Measure against success criteria ---
        console.log(`[campaigner]   Measuring quality...`);
        const measureStepId = await startActivityStep(
          campaignWorkItemId, 'Measuring quality',
          { type: 'quality_check', agentId, campaignId, iterationNumber, parentStepId: iterationStepId }
        );
        const measureResult = await measureIteration(executeText, campaign, strategy, isBuildCampaign);
        const qualityScore = measureResult.score;
        await completeActivityStep(measureStepId, { metadata: { quality_score: qualityScore } });

        // --- STEP 9: Check content policy ---
        const contentPolicy = constraints.content_policy || {};
        const policyResult = evaluateContentPolicy(executeText, contentPolicy);

        if (!policyResult.compliant) {
          // Content policy violation → automatic discard
          console.log(`[campaigner] Iteration #${iterationNumber} — content policy violation: ${policyResult.violations.join(', ')}`);
          await logIteration(campaignId, iterationWorkItemId, iterationNumber, strategy, qualityScore, measureResult.details, 'discard', iterationCost, Date.now() - iterationStart, null, `Content policy: ${policyResult.violations.join(', ')}`, null, policyResult, executeText);
          await transitionState({ workItemId: iterationWorkItemId, toState: 'completed', agentId, configHash, reason: 'Discarded: content policy violation', costUsd: iterationCost });
          await commitSpend(campaignId, estimatedCost, iterationCost);
          await completeActivityStep(iterationStepId, { status: 'failed', metadata: { decision: 'discard', reason: 'content_policy', violations: policyResult.violations } });
          continue;
        }

        // --- STEP 10: Decide: keep / discard / stop_success ---
        // measureIteration now returns constraint-based pass/fail directly
        let decision;
        let failureAnalysis = null;
        let strategyAdjustment = null;
        let gitCommitHash = null;

        if (measureResult.passed) {
          decision = 'stop_success';
          if ((isStateful || isProject) && workspacePath) {
            gitCommitHash = await commitImprovement(workspacePath, iterationNumber, qualityScore);
          }
          console.log(`[campaigner] ✓ Campaign ${campaignId} succeeded at iteration #${iterationNumber} (score: ${qualityScore})`);
        } else if (qualityScore > (getLastBestScore(history) || 0)) {
          decision = 'keep';
          if ((isStateful || isProject) && workspacePath) {
            gitCommitHash = await commitImprovement(workspacePath, iterationNumber, qualityScore);
          }
          console.log(`[campaigner] ↑ Iteration #${iterationNumber} kept (score: ${qualityScore})${gitCommitHash ? ` [${gitCommitHash}]` : ''}`);
        } else {
          decision = 'discard';
          if ((isStateful || isProject) && workspacePath) {
            await resetRegression(workspacePath);
          }
          failureAnalysis = `Score ${qualityScore} did not improve over best ${getLastBestScore(history)}`;
          strategyAdjustment = rationale;
          console.log(`[campaigner] ↓ Iteration #${iterationNumber} discarded (score: ${qualityScore})`);
        }

        const decisionStepId = await startActivityStep(
          campaignWorkItemId, `Decision: ${decision}`,
          { type: 'decision', agentId, campaignId, iterationNumber, parentStepId: iterationStepId,
            metadata: { quality_score: qualityScore, decision } }
        );
        await completeActivityStep(decisionStepId, { metadata: { quality_score: qualityScore, git_commit: gitCommitHash } });

        // --- Project mode: push + deploy on kept/success iterations ---
        if (isProject && gitCommitHash && workspacePath) {
          try {
            // Push to the project's own GitHub repo
            await gitExecLocal(['push', 'origin', 'main'], workspacePath);
            console.log(`[campaigner] Pushed to project repo for campaign ${campaignId}`);

            // Trigger Railway deploy (non-blocking on failure)
            const repoFullName = campaignMeta.github_repo || (await refreshMeta(campaignId)).github_repo;
            if (repoFullName) {
              const url = await deployProject(campaignId, repoFullName);
              if (url) {
                notifyCreator(campaignId, `Preview live: ${url}\nCampaign: ${campaignId.slice(0, 8)}`).catch(() => {});
              }
            }
          } catch (deployErr) {
            console.warn(`[campaigner] Project deploy failed (non-blocking): ${deployErr.message}`);
          }
        }

        // --- STEP 11: Log iteration ---
        await logIteration(
          campaignId, iterationWorkItemId, iterationNumber,
          strategy, qualityScore, measureResult.details,
          decision, iterationCost, Date.now() - iterationStart,
          failureAnalysis, strategyAdjustment, gitCommitHash, policyResult, executeText
        );

        // --- STEP 12: Complete work item + commit budget ---
        await transitionState({ workItemId: iterationWorkItemId, toState: 'completed', agentId, configHash, reason: `Decision: ${decision}`, costUsd: iterationCost });
        await commitSpend(campaignId, estimatedCost, iterationCost);

        const iterStatus = decision === 'stop_success' || decision === 'keep' ? 'completed' : 'failed';
        await completeActivityStep(iterationStepId, {
          status: iterStatus,
          metadata: { decision, quality_score: qualityScore, cost_usd: iterationCost },
        });

        const elapsed = Math.round((Date.now() - iterationStart) / 1000);
        console.log(`[campaigner] ── Iteration #${iterationNumber} done: ${decision} | score=${qualityScore} | $${iterationCost.toFixed(3)} | ${elapsed}s ──`);

        // Successful iteration — reset consecutive failure counter
        consecutiveFailures = 0;

        // Publish event
        await publishEvent('campaign_iteration', `Campaign ${campaignId} iteration #${iterationNumber}: ${decision} (score: ${qualityScore})`, agentId, campaignWorkItemId, { campaign_id: campaignId, iteration: iterationNumber, decision, score: qualityScore }).catch(() => {});

        // Record to Neo4j knowledge graph (non-blocking)
        recordCampaignIteration(campaignId, iterationNumber, strategy, decision, qualityScore, failureAnalysis).catch(() => {});

        // Stop on success
        if (decision === 'stop_success') {
          await stopCampaign(campaignId, 'stop_success', campaignWorkItemId, agentId, configHash);
          return;
        }

      } finally {
        clearTimeout(timeout);
      }

    } catch (err) {
      const { transient, category } = classifyError(err);
      console.error(`[campaigner] Iteration #${iterationNumber} error (${category}, ${transient ? 'transient' : 'fatal'}):`, err.message);

      // Log the error iteration
      await logIteration(campaignId, iterationWorkItemId, iterationNumber, {}, null, null, 'stop_error', iterationCost, Date.now() - iterationStart, `[${category}] ${err.message}`);

      // Transition work item to failed (if it exists)
      if (iterationWorkItemId) {
        await transitionState({ workItemId: iterationWorkItemId, toState: 'failed', agentId, configHash, reason: `Error [${category}]: ${err.message}`, costUsd: iterationCost }).catch(() => {});
      }

      await completeActivityStep(iterationStepId, { status: 'failed', metadata: { error: err.message, error_category: category, transient } });

      // Release budget reservation
      await releaseBudget(campaignId, estimatedCost);

      // Increment consecutive failure counter
      consecutiveFailures++;

      // Error budget: 3 consecutive failures → pause campaign
      if (consecutiveFailures >= 3) {
        console.error(`[campaigner] Campaign ${campaignId} — 3 consecutive failures, pausing`);
        await pauseCampaign(campaignId, `3 consecutive failures (last: ${category})`);
        await publishEvent('campaign_paused', `Campaign ${campaignId} paused: 3 consecutive failures`, agentId, campaignWorkItemId, { campaign_id: campaignId, reason: '3_consecutive_failures', last_error_category: category }).catch(() => {});
        notifyCreator(campaignId, `⚠️ Campaign paused — 3 consecutive failures (${category})\nID: ${campaignId}\nCheck: board.staqs.io/campaigns/${campaignId}`).catch(() => {});
        return;
      }

      // Transient errors: retry with exponential backoff
      if (transient) {
        const retryAttempt = consecutiveFailures; // 1-based since we just incremented
        if (retryAttempt <= MAX_RETRIES) {
          const delayMs = retryDelayMs(retryAttempt - 1);
          const delaySec = Math.round(delayMs / 1000);
          console.log(`[campaigner] Transient error (${category}), retrying in ${delaySec}s (attempt ${retryAttempt}/${MAX_RETRIES})`);

          // Wait with abort support
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            if (signal) {
              const onAbort = () => { clearTimeout(timer); resolve(); };
              signal.addEventListener('abort', onAbort, { once: true });
            }
          });

          continue; // retry the iteration
        }
        // Exceeded max retries for transient errors — fall through to fatal handling
        console.error(`[campaigner] Transient error (${category}) exceeded ${MAX_RETRIES} retries`);
      }

      // AbortError (iteration timeout) — continue to next iteration (legacy behavior preserved)
      if (err.name === 'AbortError') {
        console.log(`[campaigner] Iteration #${iterationNumber} timed out — trying next`);
        continue;
      }

      // Fatal error — stop the campaign
      await stopCampaign(campaignId, 'stop_error', campaignWorkItemId, agentId, configHash);
      return;
    }
  }
}

// ============================================================
// Helper functions
// ============================================================

async function logIteration(campaignId, workItemId, iterationNumber, strategy, qualityScore, qualityDetails, decision, costUsd, durationMs, failureAnalysis = null, strategyAdjustment = null, gitCommitHash = null, contentPolicyResult = null, actionTaken = null) {
  await query(
    `INSERT INTO agent_graph.campaign_iterations
     (campaign_id, work_item_id, iteration_number, strategy_used, quality_score, quality_details,
      decision, cost_usd, duration_ms, failure_analysis, strategy_adjustment, git_commit_hash, content_policy_result, action_taken)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [campaignId, workItemId, iterationNumber, JSON.stringify(strategy), qualityScore, JSON.stringify(qualityDetails || {}),
     decision, costUsd, durationMs, failureAnalysis, strategyAdjustment, gitCommitHash, JSON.stringify(contentPolicyResult || {}), actionTaken]
  );
}

async function stopCampaign(campaignId, reason, workItemId, agentId, configHash) {
  const statusMap = {
    stop_success: 'succeeded',
    stop_budget: 'failed',
    stop_deadline: 'failed',
    stop_plateau: 'plateau_paused',
    stop_halt: 'paused',
    stop_error: 'failed',
  };
  const status = statusMap[reason] || 'failed';

  await query(
    `UPDATE agent_graph.campaigns SET campaign_status = $1, completed_at = now(), updated_at = now() WHERE id = $2`,
    [status, campaignId]
  );

  // Clean up workspace for terminal stateful campaigns
  // Skip cleanup when promotion.type='pr' on success — PR needs the branch
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    const wsResult = await query(
      `SELECT workspace_path, metadata, campaign_mode FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    const wsRow = wsResult.rows[0];

    // Project mode: set 7-day cleanup timer instead of immediate cleanup
    if (wsRow?.campaign_mode === 'project') {
      await query(
        `UPDATE agent_graph.campaigns SET cleanup_at = now() + INTERVAL '7 days', updated_at = now() WHERE id = $1`,
        [campaignId]
      );
      console.log(`[campaigner] Project campaign ${campaignId} — cleanup scheduled in 7 days`);
    } else if (wsRow?.workspace_path) {
      const meta = typeof wsRow.metadata === 'string' ? JSON.parse(wsRow.metadata) : wsRow.metadata || {};
      const skipCleanup = status === 'succeeded' && meta.promotion?.type === 'pr';
      if (skipCleanup) {
        console.log(`[campaigner] Skipping workspace cleanup for ${campaignId} — PR promotion pending`);
      } else {
        try {
          await cleanupWorkspace(campaignId);
          console.log(`[campaigner] Cleaned up workspace for campaign ${campaignId}`);
        } catch (err) {
          console.warn(`[campaigner] Workspace cleanup failed for ${campaignId}: ${err.message}`);
        }
      }
    }
  }

  // Transition the campaign work_item
  const toState = status === 'succeeded' ? 'completed' : status.includes('paused') ? 'blocked' : 'failed';
  await transitionState({ workItemId, toState, agentId, configHash, reason: `Campaign ${reason}` }).catch(() => {});

  const eventType = status === 'succeeded' ? 'campaign_completed' : status.includes('paused') ? 'campaign_paused' : 'campaign_failed';

  // Enrich failure events with last iteration context for board notifications
  const eventMeta = { campaign_id: campaignId, reason, status };
  if (status === 'failed' || status.includes('paused')) {
    try {
      const lastIter = await query(
        `SELECT iteration_number, quality_score, decision, failure_analysis, strategy_adjustment, duration_ms
         FROM agent_graph.campaign_iterations
         WHERE campaign_id = $1 ORDER BY iteration_number DESC LIMIT 1`,
        [campaignId]
      );
      const campaignInfo = await query(
        `SELECT goal_description, completed_iterations, max_iterations, spent_usd
         FROM agent_graph.campaigns WHERE id = $1`,
        [campaignId]
      );
      if (lastIter.rows[0]) {
        eventMeta.last_iteration = lastIter.rows[0];
      }
      if (campaignInfo.rows[0]) {
        eventMeta.goal = campaignInfo.rows[0].goal_description?.slice(0, 200);
        eventMeta.iterations = `${campaignInfo.rows[0].completed_iterations}/${campaignInfo.rows[0].max_iterations}`;
        eventMeta.spent = campaignInfo.rows[0].spent_usd;
      }
    } catch { /* non-critical enrichment */ }
  }
  await publishEvent(eventType, `Campaign ${campaignId}: ${reason}`, agentId, workItemId, eventMeta).catch(() => {});

  // Record outcome to Neo4j (non-blocking)
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    try {
      const stats = await query(
        `SELECT completed_iterations, spent_usd,
                (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = $1 AND ci.decision = 'keep') AS best_score
         FROM agent_graph.campaigns WHERE id = $1`,
        [campaignId]
      );
      const row = stats.rows[0];
      if (row) {
        recordCampaignOutcome(campaignId, status, row.completed_iterations, parseFloat(row.spent_usd), row.best_score ? parseFloat(row.best_score) : null).catch(() => {});
      }
    } catch { /* non-critical */ }
  }

  // Campaign promotion (P1: only if configured)
  if (status === 'succeeded') {
    try {
      const { promote } = await import('../../lib/runtime/campaign-promoter.js');
      await promote(campaignId, agentId);
    } catch (err) {
      console.error(`[campaigner] Promotion failed for ${campaignId}:`, err.message);
      await publishEvent('campaign_promotion_failed', err.message, agentId, workItemId, { campaign_id: campaignId }).catch(() => {});
    }
  }

  // Push stateful campaign branch to GitHub so board can access artifacts
  if (wsRow?.workspace_path && (status === 'succeeded' || status === 'plateau_paused')) {
    try {
      const branch = await pushBranch(campaignId);
      console.log(`[campaigner] Pushed branch ${branch} to origin for campaign ${campaignId}`);
    } catch (err) {
      console.warn(`[campaigner] Branch push failed for ${campaignId}: ${err.message}`);
    }
  }

  console.log(`[campaigner] Campaign ${campaignId} stopped: ${reason} → ${status}`);

  // Log preview URL so operators can see the output
  const apiBase = process.env.API_BASE_URL || 'http://localhost:3001';
  console.log(`[campaigner] Preview: ${apiBase}/api/campaigns/${campaignId}/preview`);

  // Notify creator of terminal campaign status
  const emoji = status === 'succeeded' ? '✅' : status.includes('paused') ? '⏸️' : '❌';
  notifyCreator(campaignId, `${emoji} Campaign ${status}: "${reason}"\nID: ${campaignId}\nPreview: board.staqs.io/campaigns/${campaignId}`).catch(() => {});
}

// awaitHumanInput is imported from lib/hitl/index.js (line 30)

async function pauseCampaign(campaignId, reason) {
  await query(
    `UPDATE agent_graph.campaigns SET campaign_status = 'paused', updated_at = now() WHERE id = $1`,
    [campaignId]
  );
  console.log(`[campaigner] Campaign ${campaignId} paused: ${reason}`);
}

function buildExecutionPrompt(campaign, strategy, constraints, hitlContext = '') {
  // Detect if the goal involves building something with files (code, site, app)
  const goal = campaign.goal_description || '';
  const isCodeProject = /\b(build|create|generate|implement|develop|design|code|site|app|page|landing|website|dashboard|api|component)\b/i.test(goal);

  const fileInstructions = isCodeProject ? `

OUTPUT FORMAT: You MUST output all files using fenced code blocks with explicit filenames.
Use this exact format for EVERY file:

\`\`\`tsx filename="app/page.tsx"
// file contents here
\`\`\`

\`\`\`css filename="app/globals.css"
/* file contents here */
\`\`\`

Rules:
- Every code block MUST have a filename attribute
- Use realistic file paths (e.g., app/page.tsx, src/index.ts, styles/main.css)
- For HTML sites, output at minimum an index.html with all CSS/JS inline
- Include a package.json if the project needs dependencies
- Include a README.md with setup instructions
- Do NOT put code outside of fenced blocks` : '';

  return `Execute the following campaign strategy.

GOAL: ${goal}

STRATEGY: ${JSON.stringify(strategy)}

CONSTRAINTS: ${JSON.stringify(constraints)}
${fileInstructions}${hitlContext}

Produce a result that can be measured against these success criteria:
${JSON.stringify(campaign.success_criteria, null, 2)}

CRITICAL OUTPUT RULES:
- Do NOT include quality scores, confidence ratings, self-assessments, or task completion summaries.
- Do NOT wrap deliverables in execution reports or meta-commentary.
- Output ONLY the deliverable content (code, copy, design, etc.).

Respond with your execution output. Include measurable results.`;
}

async function measureIteration(output, campaign, strategy, isBuildCampaign = false) {
  // Constraint-based measurement — no self-reported metrics
  const successCriteria = typeof campaign.success_criteria === 'string'
    ? JSON.parse(campaign.success_criteria)
    : campaign.success_criteria || [];

  // Build campaigns use a specialized scorer that evaluates code blocks directly,
  // skipping self-assessment and envelope checks that penalize narrative wrapping.
  const scored = isBuildCampaign
    ? evaluateBuildOutput(output, successCriteria, { expectedFormat: strategy?.output_format })
    : evaluateSuccessCriteria(output, successCriteria, { expectedFormat: strategy?.output_format });

  return { score: scored.score, passed: scored.passed, details: scored.details, raw: scored.raw };
}

function getLastBestScore(history) {
  if (!history || history.length === 0) return 0;
  return history
    .filter(h => h.quality_score != null && h.decision === 'keep')
    .reduce((best, h) => Math.max(best, parseFloat(h.quality_score)), 0);
}

/** Simple git exec for project workspaces (not using campaign-workspace.js's REPO_ROOT default). */
function gitExecLocal(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Re-read campaign metadata from DB (for when metadata was updated by another function). */
async function refreshMeta(campaignId) {
  const result = await query(
    `SELECT metadata FROM agent_graph.campaigns WHERE id = $1`,
    [campaignId]
  );
  const raw = result.rows[0]?.metadata;
  return typeof raw === 'string' ? JSON.parse(raw) : raw || {};
}

function parseIntervalToMs(interval) {
  if (typeof interval === 'number') return interval;
  const str = String(interval);
  const match = str.match(/(\d+)\s*(minute|min|second|sec|hour|hr|ms)/i);
  if (!match) return 300_000; // 5 min default
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('ms')) return value;
  if (unit.startsWith('sec')) return value * 1000;
  if (unit.startsWith('min')) return value * 60_000;
  if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 3_600_000;
  return 300_000;
}

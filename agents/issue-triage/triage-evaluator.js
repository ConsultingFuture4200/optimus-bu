/**
 * Triage Evaluator — LLM-based issue assessment.
 *
 * Single Haiku call per issue (~$0.005). Evaluates:
 * - Clarity (1-5): Is the ask specific enough to implement?
 * - Feasibility: Can Optimus agents handle this?
 * - Scope: S/M/L estimate
 * - Classification: bug_fix, feature, research, documentation, config
 * - Target repo + playbook
 *
 * Extends the pattern from src/linear/issue-classifier.js.
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const VALID_PLAYBOOKS = [
  'implement-feature',
  'fix-bug',
  'investigate',
  'design-implement',
  'scaffold-repo',
  'report',
];

const REPO_DESCRIPTIONS = {
  'staqsIO/optimus': 'Optimus governed agent organization — Node.js monorepo with agents, board UI, RAG pipeline',
  'f8ai/formul8-platform': 'Formul8 cannabis AI platform — Express + Next.js + tRPC + Prisma polyrepo',
  'staqsIO/staqs-splash': 'Staqs Inc marketing website',
};

/**
 * Evaluate a single issue for triage.
 *
 * @param {Object} issue - Unified issue from issue-fetcher
 * @param {Object} context - { runnerCapacity: { workshopSlots, campaignerSlots } }
 * @returns {Promise<{ clarity_score, feasibility, scope_estimate, classification, target_repo, playbook_id, campaign_mode, reasoning }>}
 */
export async function evaluateIssue(issue, context = {}) {
  const repoList = Object.entries(REPO_DESCRIPTIONS)
    .map(([repo, desc]) => `- ${repo}: ${desc}`)
    .join('\n');

  const issueContext = [
    `Source: ${issue.source}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description || '(no description)'}`,
    issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : null,
    issue.priority ? `Priority: ${issue.priority} (1=urgent, 4=low)` : null,
    issue.team ? `Team: ${issue.team}` : null,
    issue.repo ? `Repo: ${issue.repo}` : null,
  ].filter(Boolean).join('\n');

  const capacityHint = context.runnerCapacity
    ? `Workshop slots available: ${context.runnerCapacity.workshopSlots}, Campaigner slots available: ${context.runnerCapacity.campaignerSlots}`
    : '';

  const prompt = `You are an issue triage agent for a software organization called Optimus. Evaluate this issue and decide how to handle it.

## Issue
${issueContext}

## Available Repositories
${repoList}

## Available Playbooks
- implement-feature: Build or add functionality
- fix-bug: Something is broken, fix it
- investigate: Research question or analysis
- design-implement: Design + build (UI/UX work)
- scaffold-repo: Create a new repository
- report: Generate a written report or analysis

${capacityHint}

## Respond with JSON only:
{
  "clarity_score": <1-5, where 5 = perfectly clear, actionable issue; 1 = vague wish>,
  "feasibility": "<auto_assign | needs_clarification | board_review | skip>",
  "scope_estimate": "<S | M | L>",
  "classification": "<bug_fix | feature | research | documentation | config | design>",
  "target_repo": "<owner/repo or null>",
  "playbook_id": "<playbook name or null>",
  "campaign_mode": "<workshop | stateless>",
  "reasoning": "<1-2 sentence explanation>",
  "clarification_questions": ["<question 1>", "<question 2>"] // only if needs_clarification
}

Rules:
- clarity >= 4 AND scope S or M → auto_assign (agents can handle this)
- clarity <= 2 → needs_clarification (ask questions)
- scope L or unclear feasibility → board_review
- Issues about infrastructure, security, or governance → board_review
- Issues already labeled "in-progress" or assigned → skip
- workshop mode for code changes (PRs), stateless for research/docs`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';
    // Extract JSON from response (may have markdown fencing)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[issue-triage] No JSON in LLM response for "${issue.title}"`);
      return defaultEvaluation(issue, 'LLM returned no JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and clamp values
    return {
      clarity_score: Math.max(1, Math.min(5, parseInt(parsed.clarity_score) || 3)),
      feasibility: ['auto_assign', 'needs_clarification', 'board_review', 'skip'].includes(parsed.feasibility)
        ? parsed.feasibility : 'board_review',
      scope_estimate: ['S', 'M', 'L'].includes(parsed.scope_estimate) ? parsed.scope_estimate : 'M',
      classification: parsed.classification || 'feature',
      target_repo: parsed.target_repo || null,
      playbook_id: VALID_PLAYBOOKS.includes(parsed.playbook_id) ? parsed.playbook_id : null,
      campaign_mode: parsed.campaign_mode === 'stateless' ? 'stateless' : 'workshop',
      reasoning: (parsed.reasoning || '').slice(0, 500),
      clarification_questions: parsed.clarification_questions || [],
    };
  } catch (err) {
    console.error(`[issue-triage] Evaluation failed for "${issue.title}": ${err.message}`);
    return defaultEvaluation(issue, err.message);
  }
}

function defaultEvaluation(issue, reason) {
  return {
    clarity_score: 3,
    feasibility: 'board_review',
    scope_estimate: 'M',
    classification: 'feature',
    target_repo: null,
    playbook_id: null,
    campaign_mode: 'workshop',
    reasoning: `Default: board_review (${reason})`,
    clarification_questions: [],
  };
}

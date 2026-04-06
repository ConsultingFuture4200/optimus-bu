/**
 * Linear webhook → executor-coder pipeline.
 *
 * Triggers when a Linear issue is assigned to Jamie Bot OR labeled "auto-fix":
 * 1. Fetches the full issue (webhook payloads are sparse)
 * 2. Creates an action_proposal with the structured ticket body
 * 3. Creates a work_item assigned directly to executor-coder (skip triage)
 * 4. Updates the Linear issue to "In Development"
 *
 * P1: deny by default — only processes issues matching configured triggers.
 * P4: boring infrastructure — raw SQL, no ORM.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getIssue, updateIssueState, updateIssueStateByName, addComment, addBotComment } from './client.js';
import { query } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';
import { ingestAsSignal } from '../webhooks/signal-ingester.js';
import { classifyIssue } from './issue-classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'config', 'linear-bot.json'), 'utf-8')
);

// Dedup: prevent duplicate webhook processing for the same issue within a short window.
// Linear sometimes delivers the same event multiple times (retries, label batch ops).
const DEDUP_TTL_MS = 30_000; // 30 seconds
const recentWebhooks = new Map(); // key: `${issueId}:${action}` → timestamp

/** Clear the in-memory dedup cache. Exported for test isolation. */
export function clearDedupCache() {
  recentWebhooks.clear();
}

function isDuplicateWebhook(issueId, action) {
  const key = `${issueId}:${action}`;
  const now = Date.now();
  const lastSeen = recentWebhooks.get(key);

  // Prune stale entries periodically (every 100 checks)
  if (recentWebhooks.size > 100) {
    for (const [k, ts] of recentWebhooks) {
      if (now - ts > DEDUP_TTL_MS) recentWebhooks.delete(k);
    }
  }

  if (lastSeen && now - lastSeen < DEDUP_TTL_MS) {
    return true;
  }

  recentWebhooks.set(key, now);
  return false;
}

/**
 * Handle a Linear webhook payload. Called from api.js after auth verification.
 * Triggers on: issue assigned to Jamie Bot, OR issue with auto-fix label.
 *
 * @param {Object} payload - Raw Linear webhook body
 * @param {Function} createWorkItem - state-machine.js createWorkItem
 * @returns {Object} Result with issueId, workItemId, proposalId or skipped reason
 */
export async function handleLinearWebhook(payload, createWorkItem) {
  const { action, data, updatedFrom } = payload;

  // Only process issue creates and updates (not removes)
  if (!data?.id || (action !== 'create' && action !== 'update')) {
    return { skipped: true, reason: `Unsupported action: ${action}` };
  }

  // Dedup: reject duplicate webhooks for the same issue within 30s window
  if (isDuplicateWebhook(data.id, action)) {
    console.log(`[linear-ingest] Dedup: skipping duplicate ${action} for ${data.id}`);
    return { skipped: true, reason: 'Duplicate webhook (within 30s dedup window)' };
  }

  // Pre-filter: skip payloads with no trigger signals to avoid unnecessary API calls (P4)
  // For creates: check if assignee/delegate/labels are present
  // For updates: check if the CHANGE was to assignee/delegate/labels (not just state changes
  // on issues that happen to have a delegate set — those cause re-trigger loops)
  if (action === 'update' && updatedFrom) {
    const triggerFieldChanged = updatedFrom.assigneeId !== undefined
      || updatedFrom.delegateId !== undefined
      || updatedFrom.labelIds !== undefined;
    if (!triggerFieldChanged) {
      return { skipped: true, reason: 'Update did not change assignee/delegate/labels' };
    }
  } else if (action !== 'create') {
    if (!data.assigneeId && !data.delegateId && (!data.labelIds || data.labelIds.length === 0)) {
      return { skipped: true, reason: 'No assignee/delegate or labels in payload' };
    }
  }

  // Fetch full issue details (webhook payload is sparse — no description, no assignee name)
  let issue;
  try {
    issue = await getIssue(data.id);
  } catch (err) {
    console.error(`[linear-ingest] Failed to fetch issue ${data.id}: ${err.message}`);
    return { skipped: true, reason: `Failed to fetch issue: ${err.message}` };
  }

  if (!issue) {
    return { skipped: true, reason: `Issue ${data.id} not found via API` };
  }

  // Skip issues already in terminal states — prevents re-processing completed/canceled work
  const stateType = issue.state?.type;
  if (stateType === 'completed' || stateType === 'canceled') {
    console.log(`[linear-ingest] Skipping ${issue.identifier}: already in terminal state '${issue.state.name}'`);
    return { skipped: true, reason: `Issue ${issue.identifier} is already ${issue.state.name}` };
  }

  // P1: deny by default — check triggers on the fetched issue (not webhook payload)
  const labels = issue.labels?.nodes || [];
  const hasAutoFixLabel = labels.some(l => l.name === config.triggerLabel);
  const isAssignedToBot = config.triggerAssigneeNames?.includes(issue.assignee?.name);
  const isDelegatedToBot = config.triggerAssigneeNames?.includes(issue.delegate?.name);
  const hasWorkshopLabel = labels.some(l => l.name === config.workshopLabel);

  // --- TIER 1a: Workshop label → claw-workshop agent (checked FIRST) ---
  if (hasWorkshopLabel) {
    console.log(`[linear-ingest] Tier 1 triggered by: workshop label`);
    return handleWorkshopTrigger(issue, createWorkItem);
  }

  // --- TIER 1b: Direct work_item (board pre-authorized) ---
  // Auto-fix label or Jamie Bot assignment → existing executor-coder flow
  // BUT skip if playbook:* labels are present — those are workshop-only signals
  const hasPlaybookLabel = labels.some(l => l.name.startsWith(config.playbookLabelPrefix || 'playbook:'));
  if (hasPlaybookLabel) {
    console.log(`[linear-ingest] Skipping executor-coder: playbook label present without workshop label — likely mid-label-toggle`);
    return { skipped: true, reason: 'Playbook label without workshop label — awaiting workshop trigger' };
  }
  if (hasAutoFixLabel || isAssignedToBot || isDelegatedToBot) {
    const triggerReason = isDelegatedToBot ? `delegated to ${issue.delegate.name}` : isAssignedToBot ? `assigned to ${issue.assignee.name}` : 'auto-fix label';
    console.log(`[linear-ingest] Tier 1 triggered by: ${triggerReason}`);
    // Fall through to existing work_item creation below
  } else {
    // --- Not a direct trigger — check if issue is in watched scope ---
    const inWatchedScope = isInWatchedScope(issue);
    if (!inWatchedScope) {
      return { skipped: true, reason: `Not triggered and outside watched scope: team=${issue.team?.name || 'none'}, project=${issue.project?.name || 'none'}` };
    }

    // --- TIER 2: Intent (urgent/high priority in watched scope → board review) ---
    const intentPriorities = config.intentPriorities || [1, 2];
    if (intentPriorities.includes(issue.priority)) {
      return handleLinearIntent(issue);
    }

    // Check for intent-triggering labels
    const matchedIntentLabel = labels.find(l => config.intentLabels?.[l.name]);
    if (matchedIntentLabel) {
      return handleLinearIntentLabel(issue, matchedIntentLabel.name);
    }

    // --- TIER 3: Signal-only (normal/low/none priority in watched scope → briefing) ---
    return handleLinearSignal(issue);
  }

  // Deduplicate: check if we already have a work item for this issue
  // Checks both active AND recently completed items to prevent re-trigger loops
  // (e.g., workshop completes → state change webhook → new work_item → workshop runs again)
  const existing = await query(
    `SELECT id, status FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND (status NOT IN ('completed', 'cancelled', 'failed')
            OR (status = 'completed' AND updated_at > NOW() - INTERVAL '1 hour'))
     LIMIT 1`,
    [data.id]
  );
  if (existing.rows.length > 0) {
    const status = existing.rows[0].status;
    const reason = status === 'completed'
      ? 'Work item recently completed (cooldown — prevents re-trigger loop)'
      : 'Work item already exists';
    console.log(`[linear-ingest] Skipping: ${reason} (${existing.rows[0].id}, status=${status}) for ${data.id}`);
    return { skipped: true, reason, existingWorkItemId: existing.rows[0].id };
  }

  console.log(`[linear-ingest] Processing ${issue.identifier}: ${issue.title}`);

  // Determine target repo from labels, project, or team
  let targetRepo = resolveTargetRepo(issue);

  // If no repo from labels, try LLM classifier
  if (!targetRepo && config.repoDescriptions) {
    try {
      console.log(`[linear-ingest] Classifying repo for executor-coder: ${issue.identifier}`);
      const classification = await classifyIssue(issue, config.repoDescriptions);
      if (classification.target_repo && classification.target_repo !== 'new-repo' && classification.confidence >= 0.8) {
        targetRepo = classification.target_repo;
        console.log(`[linear-ingest] Classifier assigned repo: ${targetRepo} (confidence: ${classification.confidence})`);
      }
    } catch (err) {
      console.warn(`[linear-ingest] Classification failed for executor-coder: ${err.message}`);
    }
  }

  // Fail-fast: no repo resolved — ask user to add a repo label
  if (!targetRepo) {
    console.log(`[linear-ingest] No repo resolved for ${issue.identifier} — requesting label`);
    try {
      const repoOptions = Object.keys(config.repoMapping).map(k => `\`${k}\``).join(', ');
      await addBotComment(issue.id,
        `Could not determine target repository.\n\n` +
        `Please add one of: ${repoOptions}\n\n` +
        `I'll auto-retry when the label is added.`
      );
    } catch (err) {
      console.warn(`[linear-ingest] Failed to post repo-request comment: ${err.message}`);
    }
    return { skipped: true, reason: `No target repo for ${issue.identifier}` };
  }

  // Build structured ticket body (same shape executor-ticket produces)
  const { body: ticketBody, priority: issuePriority } = buildTicketBody(issue);

  // Create action_proposal (ticket_create — same type executor-ticket uses)
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, linear_issue_id, linear_issue_url, target_repo)
     VALUES ('ticket_create', $1, $2, $3, $4)
     RETURNING id`,
    [ticketBody, issue.id, issue.url, targetRepo]
  );
  const proposalId = proposalResult.rows[0].id;

  // Create work item → assigned directly to executor-coder (skip triage)
  const workItem = await createWorkItem({
    type: 'task',
    title: `Auto-fix: ${issue.identifier} — ${issue.title}`,
    description: issue.description?.slice(0, 500) || '',
    createdBy: 'orchestrator',
    assignedTo: 'executor-coder',
    priority: mapLinearPriority(issuePriority),
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issuePriority,
      source: 'linear-webhook',
    },
  });

  console.log(`[linear-ingest] Created work item ${workItem?.id} for ${issue.identifier} → ${targetRepo}`);

  // Update Linear issue to "In Development" (best-effort)
  try {
    await updateIssueStateByName(issue.id, 'In Development');
    console.log(`[linear-ingest] Updated ${issue.identifier} to "In Development"`);
  } catch (err) {
    console.warn(`[linear-ingest] Failed to update issue state: ${err.message}`);
  }

  return { issueId: issue.id, workItemId: workItem?.id, proposalId };
}

/**
 * Determine the target GitHub repo from issue labels, project, and team.
 * Priority: repo: label > project mapping > team mapping > null (fail-fast)
 */
function resolveTargetRepo(issue) {
  const labels = issue.labels?.nodes || [];

  // Tier 1: explicit repo label (e.g. "repo:formul8" or just "formul8")
  for (const label of labels) {
    const mapped = config.repoMapping[label.name]
      || config.repoMapping[`repo:${label.name}`];
    if (mapped) return mapped;

    // Tier 1b: fuzzy match — if label is "repo:X", try matching X against known repo names
    // e.g. "repo:autocsr" matches "staqsIO/AutoCSR" without needing an explicit mapping entry
    if (label.name.startsWith('repo:')) {
      const repoHint = label.name.slice(5).toLowerCase();
      const allRepos = Object.values(config.repoMapping)
        .concat(Object.values(config.projectMapping || {}))
        .concat(Object.values(config.teamMapping || {}));
      const fuzzyMatch = [...new Set(allRepos)].find(r =>
        r.toLowerCase().endsWith(`/${repoHint}`) || r.toLowerCase().includes(repoHint)
      );
      if (fuzzyMatch) {
        console.log(`[linear-ingest] Fuzzy repo match: ${label.name} → ${fuzzyMatch}`);
        return fuzzyMatch;
      }
    }
  }

  // Tier 2: project name mapping
  if (issue.project?.name) {
    const mapped = config.projectMapping[issue.project.name];
    if (mapped) return mapped;
  }

  // Tier 3: team name mapping
  if (issue.team?.name) {
    const mapped = config.teamMapping?.[issue.team.name];
    if (mapped) return mapped;
  }

  return config.defaultTargetRepo || null;
}

/**
 * Resolve a workflow state ID for the issue's team.
 * Currently uses config defaults (Staqs Internal Projects state IDs).
 * Non-default teams will need team-specific state mappings added to linear-bot.json.
 */
function resolveStateId(issue, stateName) {
  return config.states[stateName] || null;
}

/**
 * Map Linear priority (0=none, 1=urgent, 2=high, 3=medium, 4=low) to work_item priority.
 * Work items use 0=normal, higher=more urgent.
 */
function mapLinearPriority(linearPriority) {
  switch (linearPriority) {
    case 1: return 3; // urgent
    case 2: return 2; // high
    case 3: return 1; // medium
    case 4: return 0; // low
    default: return 0; // none
  }
}

/**
 * Check if an issue is in the watched scope (P1: deny by default for everything outside).
 */
function isInWatchedScope(issue) {
  const watchedTeams = config.watchedTeams || [];
  const watchedProjects = config.watchedProjects || [];

  const teamMatch = issue.team?.name && watchedTeams.includes(issue.team.name);
  const projectMatch = issue.project?.name && watchedProjects.includes(issue.project.name);

  return teamMatch || projectMatch;
}

/**
 * Tier 2: Create intent for urgent/high priority Linear issues.
 * Zero LLM cost — DB insert only.
 */
async function handleLinearIntent(issue) {
  const priorityName = ['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None';
  const tier = issue.priority === 1 ? 'strategic' : 'tactical';

  const intent = await createIntent({
    agentId: 'orchestrator',
    intentType: 'task',
    decisionTier: tier,
    title: `Linear ${issue.identifier}: ${issue.title} [${priorityName}]`,
    reasoning: `${priorityName}-priority issue in ${issue.team?.name || 'unknown team'}. ${issue.description?.slice(0, 300) || 'No description.'}`,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `Linear ${issue.identifier}: ${issue.title}`,
        description: issue.description?.slice(0, 500) || '',
        assigned_to: 'executor-coder',
        priority: mapLinearPriority(issue.priority),
        metadata: {
          linear_issue_id: issue.id,
          linear_issue_url: issue.url,
          linear_identifier: issue.identifier,
          source: 'linear-webhook-intent',
        },
      },
    },
    triggerContext: {
      pattern: `linear_issue_${issue.id}`,
      source: 'linear-webhook',
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      priority: issue.priority,
    },
    budgetPerFire: tier === 'strategic' ? 0.50 : 0.25,
  });

  if (!intent) {
    console.log(`[linear-ingest] Tier 2 dedup: intent already exists for ${issue.identifier}`);
    return { skipped: true, reason: `Intent already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 2: created intent ${intent.id.slice(0, 8)}... for ${issue.identifier} [${priorityName}]`);
  return { issueId: issue.id, intentId: intent.id, tier: 2 };
}

/**
 * Tier 2: Create intent for Linear issues with special labels (e.g. board-review).
 */
async function handleLinearIntentLabel(issue, labelName) {
  const routing = config.intentLabels[labelName];
  const agent = routing.agent || 'executor-coder';
  const tier = routing.tier || 'tactical';

  const intent = await createIntent({
    agentId: agent,
    intentType: 'task',
    decisionTier: tier,
    title: `Linear ${issue.identifier}: ${issue.title} [${labelName}]`,
    reasoning: `Issue labeled "${labelName}" in ${issue.team?.name || 'unknown team'}. ${issue.description?.slice(0, 300) || 'No description.'}`,
    proposedAction: {
      type: 'create_work_item',
      payload: {
        type: 'task',
        title: `Linear ${issue.identifier}: ${issue.title}`,
        description: issue.description?.slice(0, 500) || '',
        assigned_to: agent,
        priority: mapLinearPriority(issue.priority),
        metadata: {
          linear_issue_id: issue.id,
          linear_issue_url: issue.url,
          linear_identifier: issue.identifier,
          linear_label: labelName,
          source: 'linear-webhook-intent',
        },
      },
    },
    triggerContext: {
      pattern: `linear_issue_${issue.id}`,
      source: 'linear-webhook',
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_label: labelName,
    },
    budgetPerFire: tier === 'strategic' ? 0.50 : 0.25,
  });

  if (!intent) {
    return { skipped: true, reason: `Intent already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 2: created intent for ${issue.identifier} [label=${labelName}]`);
  return { issueId: issue.id, intentId: intent.id, label: labelName, tier: 2 };
}

/**
 * Tier 3: Signal-only for normal/low priority Linear issues.
 * Zero LLM cost — DB insert only, surfaces in briefing.
 */
async function handleLinearSignal(issue) {
  const priorityName = ['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None';
  const labelNames = (issue.labels?.nodes || []).map(l => l.name);

  const result = await ingestAsSignal({
    source: 'linear',
    title: `${issue.identifier}: ${issue.title}`,
    snippet: issue.description?.slice(0, 2000) || `[${priorityName} priority Linear issue]`,
    from: issue.assignee?.name || issue.creator?.name || 'Linear',
    signals: [{
      signal_type: 'request',
      content: `${issue.identifier}: ${issue.title} [${priorityName}] — ${issue.team?.name || 'unknown team'}`,
      confidence: 0.8,
      direction: 'inbound',
      domain: issue.team?.name?.toLowerCase() || null,
    }],
    metadata: {
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issue.priority,
      linear_team: issue.team?.name,
      linear_project: issue.project?.name,
      linear_assignee: issue.assignee?.name,
      linear_labels: labelNames,
    },
    labels: [`priority:${priorityName.toLowerCase()}`, ...labelNames.map(l => `linear:${l}`)],
    providerMsgId: `linear_${issue.id}`,
  });

  if (!result) {
    return { skipped: true, reason: `Signal already exists for ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Tier 3: signal created for ${issue.identifier} (msgId=${result.messageId})`);
  return { issueId: issue.id, messageId: result.messageId, tier: 3 };
}

/**
 * Tier 1a: Workshop label → create work_item + campaign for claw-workshop.
 * Auto-approved (board reviews at PR stage, not work creation).
 */
async function handleWorkshopTrigger(issue, createWorkItem) {
  const labels = issue.labels?.nodes || [];

  // Deduplicate — only match workshop-assigned work items (not executor-coder ones
  // that may have been created during a label toggle race)
  const existing = await query(
    `SELECT id FROM agent_graph.work_items
     WHERE metadata->>'linear_issue_id' = $1
       AND assigned_to = 'claw-workshop'
       AND status NOT IN ('completed', 'cancelled', 'failed')
     LIMIT 1`,
    [issue.id]
  );
  if (existing.rows.length > 0) {
    console.log(`[linear-ingest] Skipping duplicate workshop: work item ${existing.rows[0].id} already exists for ${issue.id}`);
    return { skipped: true, reason: 'Work item already exists', existingWorkItemId: existing.rows[0].id };
  }

  // Derive playbook from labels FIRST (some playbooks don't need a target repo)
  const playbookLabelPrefix = config.playbookLabelPrefix || 'playbook:';
  const playbookLabel = labels.find(l => l.name.startsWith(playbookLabelPrefix));
  let playbookId = playbookLabel
    ? playbookLabel.name.slice(playbookLabelPrefix.length)
    : null; // null = needs classification or default

  // Resolve target repo from labels/project/team
  let targetRepo = resolveTargetRepo(issue);

  // If either playbook or repo is missing, use LLM classifier to fill the gaps
  if (!playbookId || !targetRepo) {
    const needsClassification = !playbookId || !targetRepo;
    if (needsClassification && config.repoDescriptions) {
      try {
        console.log(`[linear-ingest] Classifying ${issue.identifier} (missing: ${!playbookId ? 'playbook' : ''} ${!targetRepo ? 'repo' : ''})`);
        const classification = await classifyIssue(issue, config.repoDescriptions);
        console.log(`[linear-ingest] Classification: playbook=${classification.playbook_id}, repo=${classification.target_repo}, confidence=${classification.confidence} — ${classification.reasoning}`);

        // Apply playbook from classifier if not set by label
        if (!playbookId) {
          playbookId = classification.playbook_id;
        }

        // Apply repo from classifier if not set by label/project/team
        if (!targetRepo && classification.target_repo) {
          if (classification.target_repo === 'new-repo') {
            playbookId = 'scaffold-repo';
            targetRepo = 'staqsIO/optimus'; // execution context for scaffold
            console.log(`[linear-ingest] Classifier detected new-repo → scaffold-repo playbook`);
          } else if (classification.confidence >= 0.8) {
            targetRepo = classification.target_repo;
            console.log(`[linear-ingest] Classifier assigned repo: ${targetRepo} (confidence: ${classification.confidence})`);
          } else {
            // Low confidence — ask for confirmation
            console.log(`[linear-ingest] Classifier low confidence (${classification.confidence}) — asking for label`);
            try {
              await addBotComment(issue.id,
                `I think this belongs in **${classification.target_repo}** (${classification.reasoning}).\n\n` +
                `Add \`repo:${classification.target_repo.split('/')[1]}\` to confirm, or apply a different \`repo:\` label.`
              );
            } catch (err) {
              console.warn(`[linear-ingest] Failed to post classifier comment: ${err.message}`);
            }
            return { skipped: true, reason: `Low confidence repo classification for ${issue.identifier} — awaiting label` };
          }
        }
      } catch (err) {
        console.warn(`[linear-ingest] Classification failed: ${err.message} — using defaults`);
      }
    }
  }

  // Final fallback for playbook
  if (!playbookId) {
    playbookId = 'implement-feature';
  }

  // Playbooks that create new repos only need an execution context, not a real target
  const REPO_CREATING_PLAYBOOKS = ['scaffold-repo'];
  const isRepoCreating = REPO_CREATING_PLAYBOOKS.includes(playbookId);

  if (!targetRepo && isRepoCreating) {
    // scaffold-repo ignores the cloned repo — use optimus as execution context
    targetRepo = 'staqsIO/optimus';
    console.log(`[linear-ingest] Playbook ${playbookId} creates a new repo — using ${targetRepo} as execution context`);
  }
  if (!targetRepo) {
    console.log(`[linear-ingest] No repo resolved for workshop ${issue.identifier} — requesting label`);
    try {
      const repoOptions = Object.keys(config.repoMapping).map(k => `\`${k}\``).join(', ');
      await addBotComment(issue.id,
        `Workshop triggered but no target repo found.\n\nPlease add one of: ${repoOptions}`
      );
    } catch (err) {
      console.warn(`[linear-ingest] Failed to post repo-request comment: ${err.message}`);
    }
    return { skipped: true, reason: `No target repo for workshop ${issue.identifier}` };
  }

  console.log(`[linear-ingest] Workshop: ${issue.identifier} → playbook=${playbookId}, repo=${targetRepo}`);

  // Build ticket body
  const { body: ticketBody, priority: issuePriority } = buildTicketBody(issue);

  // Create action_proposal
  const proposalResult = await query(
    `INSERT INTO agent_graph.action_proposals
     (action_type, body, linear_issue_id, linear_issue_url, target_repo)
     VALUES ('ticket_create', $1, $2, $3, $4)
     RETURNING id`,
    [ticketBody, issue.id, issue.url, targetRepo]
  );
  const proposalId = proposalResult.rows[0].id;

  // Create work_item → assigned to claw-workshop
  const workItem = await createWorkItem({
    type: 'task',
    title: `Workshop: ${issue.identifier} — ${issue.title}`,
    description: issue.description?.slice(0, 500) || '',
    createdBy: 'orchestrator',
    assignedTo: 'claw-workshop',
    priority: mapLinearPriority(issuePriority),
    metadata: {
      ticket_proposal_id: proposalId,
      target_repo: targetRepo,
      linear_issue_id: issue.id,
      linear_issue_url: issue.url,
      linear_identifier: issue.identifier,
      linear_priority: issuePriority,
      playbook_id: playbookId,
      source: 'linear-webhook',
    },
  });

  // Create campaign row — auto-approved
  // Budget from playbook defaults (loaded at execution time; use $15 as safe default)
  const budgetUsd = 15.00;
  await query(
    `INSERT INTO agent_graph.campaigns
     (work_item_id, campaign_mode, campaign_status, goal_description,
      budget_envelope_usd, max_cost_per_iteration, metadata, created_by)
     VALUES ($1, 'workshop', 'approved', $2, $3, $4, $5, 'orchestrator')`,
    [
      workItem?.id,
      `${issue.identifier}: ${issue.title}`,
      budgetUsd,
      budgetUsd, // single-pass, so max_per_iteration = envelope
      JSON.stringify({
        playbook_id: playbookId,
        target_repo: targetRepo,
        linear_issue_id: issue.id,
        linear_issue_url: issue.url,
        linear_identifier: issue.identifier,
      }),
    ]
  );

  console.log(`[linear-ingest] Created workshop campaign for ${issue.identifier} → claw-workshop (playbook=${playbookId})`);

  // Update Linear issue to "In Development" (best-effort)
  try {
    await updateIssueStateByName(issue.id, 'In Development');
    console.log(`[linear-ingest] Updated ${issue.identifier} to "In Development"`);
  } catch (err) {
    console.warn(`[linear-ingest] Failed to update issue state: ${err.message}`);
  }

  return { issueId: issue.id, workItemId: workItem?.id, proposalId, campaignMode: 'workshop', playbookId };
}

/**
 * Build structured ticket body for executor-coder consumption.
 * Same shape that executor-ticket produces so executor-coder can process it uniformly.
 */
function buildTicketBody(issue) {
  const labels = (issue.labels?.nodes || []).map(l => l.name).join(', ');
  const assignee = issue.assignee?.name || 'Unassigned';
  const team = issue.team ? `${issue.team.name} (${issue.team.key})` : 'Unknown team';
  const project = issue.project?.name || 'No project';

  const body = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `**Team:** ${team}`,
    `**Project:** ${project}`,
    `**Assignee:** ${assignee}`,
    `**Priority:** ${['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None'}`,
    labels ? `**Labels:** ${labels}` : null,
    `**Linear:** ${issue.url}`,
    '',
    '## Description',
    '',
    issue.description || '_No description provided._',
  ].filter(line => line !== null).join('\n');

  return { body, priority: issue.priority };
}

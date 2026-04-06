/**
 * Pre-Assignment Capability Check (PR #82 — Spec Addendum, Item 3D)
 *
 * Lightweight keyword extraction from task description matched against
 * agent `capabilities` array in agents.json.
 *
 * Three outcomes:
 *   - full_match: all required capabilities found → assign
 *   - partial_match: some capabilities found → assign + verification_required flag
 *   - no_match: boundary conflict → reject + escalate
 *
 * Phase 1: LOG-ONLY (4 weeks), then enforced.
 * P2: Infrastructure enforces; prompts advise.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'agents.json');

let _agentsConfig = null;
function getAgentsConfig() {
  if (!_agentsConfig) {
    _agentsConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return _agentsConfig;
}

/**
 * Capability keyword map: maps task keywords to required agent capabilities.
 * Kept simple and deterministic — no LLM needed.
 */
const KEYWORD_CAPABILITY_MAP = {
  // Email operations
  'email': 'gmail-api',
  'gmail': 'gmail-api',
  'inbox': 'gmail-api',
  'draft': 'email-draft',
  'reply': 'email-draft',
  'respond': 'email-draft',

  // Classification
  'triage': 'email-classification',
  'classify': 'email-classification',
  'categorize': 'email-classification',

  // Voice
  'voice': 'voice-matching',
  'tone': 'voice-matching',

  // Signals
  'signal': 'signal-extraction',
  'extract': 'signal-extraction',

  // Ticketing
  'ticket': 'ticket-creation',
  'linear': 'linear-api',
  'issue': 'github-api',

  // Code
  'code': 'code-generation',
  'javascript': 'javascript',
  'sql': 'sql',
  'pr': 'git-trees',
  'pull request': 'git-trees',

  // Strategy
  'priority': 'priority-scoring',
  'strategy': 'strategy',
  'briefing': 'briefing-generation',

  // Gate checking
  'review': 'gate-checking',
  'gate': 'gate-checking',
  'commitment': 'gate-checking',

  // Research
  'research': 'research-synthesis',
  'search': 'web-search',

  // Slack
  'slack': 'slack-api',
};

/**
 * Extract required capabilities from a task description.
 *
 * @param {string} description - Task title + description
 * @returns {string[]} List of required capability identifiers
 */
export function extractRequiredCapabilities(description) {
  if (!description) return [];

  const text = description.toLowerCase();
  const capabilities = new Set();

  for (const [keyword, capability] of Object.entries(KEYWORD_CAPABILITY_MAP)) {
    if (text.includes(keyword)) {
      capabilities.add(capability);
    }
  }

  return [...capabilities];
}

/**
 * Check if an agent has the capabilities required for a task.
 *
 * @param {string} agentId - The agent to check
 * @param {string} taskDescription - Task title + description
 * @returns {{
 *   result: 'full_match' | 'partial_match' | 'no_match',
 *   matched: string[],
 *   missing: string[],
 *   required: string[],
 *   agentCapabilities: string[],
 *   verificationRequired: boolean
 * }}
 */
export function checkCapability(agentId, taskDescription) {
  const config = getAgentsConfig();
  const agentConfig = config.agents[agentId];

  if (!agentConfig) {
    return {
      result: 'no_match',
      matched: [],
      missing: [],
      required: [],
      agentCapabilities: [],
      verificationRequired: false,
    };
  }

  const agentCapabilities = agentConfig.capabilities || [];
  const required = extractRequiredCapabilities(taskDescription);

  // No specific capabilities detected → allow (don't block on ambiguity)
  if (required.length === 0) {
    return {
      result: 'full_match',
      matched: [],
      missing: [],
      required: [],
      agentCapabilities,
      verificationRequired: false,
    };
  }

  const matched = required.filter(cap => agentCapabilities.includes(cap));
  const missing = required.filter(cap => !agentCapabilities.includes(cap));

  let result;
  if (missing.length === 0) {
    result = 'full_match';
  } else if (matched.length > 0) {
    result = 'partial_match';
  } else {
    result = 'no_match';
  }

  return {
    result,
    matched,
    missing,
    required,
    agentCapabilities,
    verificationRequired: result === 'partial_match',
  };
}

/**
 * Log-only capability check wrapper.
 * Phase 1: logs mismatches but does NOT block assignment.
 * After 4 weeks of data, switch to enforced mode.
 *
 * @param {string} agentId
 * @param {string} taskDescription
 * @param {string} [workItemId] - For audit trail
 * @returns {{ allowed: boolean, check: object }}
 */
export function preAssignmentCheck(agentId, taskDescription, workItemId = null) {
  const check = checkCapability(agentId, taskDescription);

  // Phase 1: LOG ONLY — always allow, but log mismatches
  if (check.result !== 'full_match') {
    console.log(`[capability-check] ${check.result}: agent=${agentId} workItem=${workItemId || 'n/a'}`);
    console.log(`[capability-check]   required: [${check.required.join(', ')}]`);
    console.log(`[capability-check]   matched:  [${check.matched.join(', ')}]`);
    console.log(`[capability-check]   missing:  [${check.missing.join(', ')}]`);
    console.log(`[capability-check]   agent has: [${check.agentCapabilities.join(', ')}]`);
  }

  return {
    allowed: true, // Phase 1: always allow (log-only)
    check,
  };
}

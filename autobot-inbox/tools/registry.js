/**
 * MCP-compatible tool registry.
 * Tools are callable by agents via the tool allow-list in agent config.
 * P1: Deny by default — agents can only use tools in their tools_allowed list.
 * P2: Infrastructure enforces — DB permission check, timeouts, audit trail.
 */

import { createHash } from 'crypto';
import { query } from '../src/db.js';
import { fetchEmailBody, fetchEmailMetadata, createDraft } from '../src/gmail/client.js';
import { pollForNewMessages } from '../src/gmail/poller.js';
import { selectFewShots } from '../src/voice/few-shot-selector.js';
import { getProfile } from '../src/voice/profile-builder.js';
import { getUnresolvedSignals, getUpcomingDeadlines } from '../src/signal/extractor.js';
import { getContacts, getContactSummary } from '../src/signal/relationship-graph.js';
import { getDailyStats, getAgentActivity, getBudgetStatus } from '../src/signal/briefing-generator.js';

// Module-scope cache for DB tool_registry allowed_agents.
// Populated on first executeTool() call, refreshable via loadToolPermissions().
let _dbPermissions = null;

export async function loadToolPermissions() {
  try {
    const result = await query(
      `SELECT tool_name, allowed_agents FROM agent_graph.tool_registry WHERE is_active = true`
    );
    _dbPermissions = new Map(result.rows.map(r => [r.tool_name, r.allowed_agents]));
  } catch (err) {
    // P1: deny by default — in production, DB permission layer must not be bypassed.
    // Only skip in test/dev when NODE_ENV is explicitly set.
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      console.warn(`[tool-registry] Failed to load DB permissions: ${err.message}. Layer 2 check disabled (${process.env.NODE_ENV} mode).`);
      _dbPermissions = null;
    } else {
      throw new Error(`[tool-registry] FATAL: Cannot load DB permissions — Layer 2 enforcement unavailable. ${err.message}`);
    }
  }
  return _dbPermissions;
}

export const tools = {
  // Gmail tools
  gmail_poll: {
    name: 'gmail_poll',
    description: 'Poll Gmail for new messages',
    capabilities: { schemas: ['inbox'], network: true },
    timeout: 120000,
    handler: async () => pollForNewMessages(),
  },
  gmail_fetch: {
    name: 'gmail_fetch',
    description: 'Fetch email body by Gmail ID (D1: on-demand, never stored)',
    parameters: { provider_msg_id: 'string' },
    capabilities: { schemas: [], network: true },
    timeout: 30000,
    handler: async ({ provider_msg_id }) => fetchEmailBody(provider_msg_id),
  },

  // Task graph tools
  task_create: {
    name: 'task_create',
    description: 'Create a work item in the task graph',
    parameters: { type: 'string', title: 'string', description: 'string', assignedTo: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async (params) => {
      const { createWorkItem } = await import('../src/runtime/state-machine.js');
      return createWorkItem(params);
    },
  },
  task_assign: {
    name: 'task_assign',
    description: 'Assign a task to an agent',
    parameters: { workItemId: 'string', agentId: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId, agentId }) => {
      return query(
        `UPDATE agent_graph.work_items SET assigned_to = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [agentId, workItemId]
      );
    },
  },
  task_update: {
    name: 'task_update',
    description: 'Update a work item',
    parameters: { workItemId: 'string', updates: 'object' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId, updates }) => {
      const { transitionState } = await import('../src/runtime/state-machine.js');
      if (updates.status) {
        return transitionState({ workItemId, toState: updates.status, ...updates });
      }
    },
  },
  task_read: {
    name: 'task_read',
    description: 'Read a work item and its context',
    parameters: { workItemId: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId }) => {
      const result = await query(`SELECT * FROM agent_graph.work_items WHERE id = $1`, [workItemId]);
      return result.rows[0];
    },
  },

  // Voice tools
  voice_query: {
    name: 'voice_query',
    description: 'Query voice profile and few-shot examples',
    parameters: { recipientEmail: 'string', subject: 'string' },
    capabilities: { schemas: ['voice'], network: false },
    timeout: 15000,
    handler: async ({ recipientEmail, subject }) => ({
      profile: await getProfile(recipientEmail),
      fewShots: await selectFewShots({ recipientEmail, subject }),
    }),
  },

  // Signal tools
  signal_extract: {
    name: 'signal_extract',
    description: 'Extract and store signals from email content',
    parameters: { emailId: 'string', signals: 'array' },
    capabilities: { schemas: ['inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async ({ emailId, signals }) => {
      for (const s of signals) {
        await query(
          `INSERT INTO inbox.signals (email_id, signal_type, content, confidence, due_date)
           VALUES ($1, $2, $3, $4, $5)`,
          [emailId, s.type, s.content, s.confidence, s.dueDate || null]
        );
      }
    },
  },
  signal_query: {
    name: 'signal_query',
    description: 'Query signals, contacts, and deadlines',
    parameters: { type: 'string' },
    capabilities: { schemas: ['inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async ({ type }) => ({
      signals: await getUnresolvedSignals({ type }),
      deadlines: await getUpcomingDeadlines(7),
      vipContacts: await getContacts({ vipOnly: true }),
    }),
  },

  // Draft tools
  draft_create: {
    name: 'draft_create',
    description: 'Create a response draft (action proposal)',
    parameters: { emailId: 'string', body: 'string', subject: 'string', toAddresses: 'array' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ emailId, body, subject, toAddresses }) => {
      const result = await query(
        `INSERT INTO agent_graph.action_proposals (action_type, message_id, body, subject, to_addresses) VALUES ('email_draft', $1, $2, $3, $4) RETURNING *`,
        [emailId, body, subject, toAddresses]
      );
      return result.rows[0];
    },
  },
  draft_read: {
    name: 'draft_read',
    description: 'Read an action proposal by ID',
    parameters: { draftId: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ draftId }) => {
      const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
      return result.rows[0];
    },
  },

  // Gate tools
  gate_check: {
    name: 'gate_check',
    description: 'Run constitutional gate checks on an action proposal',
    parameters: { draftId: 'string' },
    capabilities: { schemas: ['agent_graph', 'voice'], network: false },
    timeout: 30000,
    handler: async ({ draftId }) => {
      const { checkDraftGates } = await import('../src/runtime/guard-check.js');
      const draft = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
      return checkDraftGates(draft.rows[0], null, null, null, draft.rows[0]?.action_type);
    },
  },

  // Stats tools
  stats_query: {
    name: 'stats_query',
    description: 'Query system stats and metrics',
    capabilities: { schemas: ['agent_graph', 'inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async () => ({
      daily: await getDailyStats(),
      agents: await getAgentActivity(),
      budget: await getBudgetStatus(),
    }),
  },

  // Briefing tools
  briefing_create: {
    name: 'briefing_create',
    description: 'Store a generated briefing',
    parameters: { briefing: 'object' },
    capabilities: { schemas: ['signal'], network: false },
    timeout: 10000,
    handler: async ({ briefing }) => {
      return query(
        `INSERT INTO signal.briefings (briefing_date, summary, action_items, signals, trending_topics, vip_activity, generated_by)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, 'architect')
         ON CONFLICT (briefing_date) DO UPDATE SET summary = EXCLUDED.summary`,
        [briefing.summary, JSON.stringify(briefing.actionItems), JSON.stringify(briefing.signals),
         JSON.stringify(briefing.trendingTopics), JSON.stringify(briefing.vipActivity)]
      );
    },
  },
};

/**
 * Execute a tool by name, with layered permission checks, timeout, and audit trail.
 *
 * Enforcement layers:
 *   1. Agent config allow-list (P1: deny by default)
 *   2. DB tool_registry.allowed_agents (P2: infrastructure enforces)
 *   3. Per-tool timeout via Promise.race
 *   4. Fire-and-forget audit INSERT to tool_invocations
 */
export async function executeTool(toolName, params, agentConfig) {
  const agentId = agentConfig?.id ?? 'unknown';

  // Layer 1: Check tool is in agent's config allow-list (P1: deny by default)
  // agents.json uses 'tools', DB agent_configs uses 'tools_allowed' — accept either
  const allowedTools = agentConfig?.tools || agentConfig?.tools_allowed;
  if (!allowedTools?.includes(toolName)) {
    throw new Error(`Agent ${agentId} not authorized for tool ${toolName}`);
  }

  const tool = tools[toolName];
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Layer 2: DB tool_registry permission check
  if (!_dbPermissions) await loadToolPermissions();
  if (_dbPermissions) {
    const allowedAgents = _dbPermissions.get(toolName);
    if (allowedAgents && !allowedAgents.includes(agentId)) {
      throw new Error(`Agent ${agentId} not in tool_registry.allowed_agents for ${toolName}`);
    }
  }

  // Layer 3: Execute with timeout
  const timeout = tool.timeout || 30000;
  const startTime = Date.now();
  let success = false;
  let errorMessage = null;
  let result;
  let timer;

  try {
    result = await Promise.race([
      tool.handler(params || {}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
    success = true;
    return result;
  } catch (err) {
    errorMessage = err.message;
    throw err;
  } finally {
    clearTimeout(timer);

    // Layer 4: Fire-and-forget audit trail
    const durationMs = Date.now() - startTime;
    const paramsHash = params
      ? createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16)
      : null;
    const summary = success
      ? (typeof result === 'object' ? 'ok' : String(result).slice(0, 200))
      : null;

    // Non-blocking — audit failures must not affect tool execution
    query(
      `INSERT INTO agent_graph.tool_invocations (agent_id, tool_name, params_hash, result_summary, duration_ms, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agentId, toolName, paramsHash, summary, durationMs, success, errorMessage]
    ).catch(() => {});
  }
}

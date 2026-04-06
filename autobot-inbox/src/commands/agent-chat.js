/**
 * Agent Chat — Messenger-style per-agent chat for board members.
 *
 * Separate lightweight path: chat does NOT go through the task graph.
 * If a user asks an agent to *do something*, that action creates a work_item
 * via the normal path.
 *
 * Security (Linus review):
 *  #1 chatTools separate from operational tools — read-only by default
 *  #2 Server-side session IDs (crypto.randomUUID)
 *  #3 G1 budget enforcement — per-session cost cap
 *  #4 Full audit trail via llm_invocations
 *  #5 Context/input separation — pipeline context in system prompt only
 *  #6 Model ID locked at invocation time, logged in response
 *  #7 Per-agent LLM client cache
 */

import { randomUUID } from 'crypto';
import { query } from '../db.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { loadMergedConfig } from '../../../lib/runtime/config-loader.js';

/**
 * Load agents config with DB overrides merged on top of disk defaults.
 * Cached for 30s in config-loader. Replaces direct readFileSync of agents.json.
 */
async function loadConfig() {
  return loadMergedConfig();
}

// Linus #7: per-agent LLM client cache, keyed by agentId:model
// Invalidated when model changes (key includes model ID).
const _llmClients = new Map();

function getLLMForAgent(agentId, config) {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const cacheKey = `${agentId}:${agent.model}`;
  if (!_llmClients.has(cacheKey)) {
    _llmClients.set(cacheKey, createLLMClient(agent.model, config.models));
  }
  return _llmClients.get(cacheKey);
}

/** Sanitize strings before injecting into system prompt (Linus: prevent injection via error messages). */
function sanitize(str, maxLen = 100) {
  return String(str).replace(/[^\x20-\x7E]/g, '').slice(0, maxLen);
}

/**
 * Build system prompt from agent config.
 * Linus #5: pipeline context goes here, NOT in user turn.
 * Liotta: agent metrics injected for self-awareness (under 200 tokens).
 */
function buildChatSystemPrompt(agentConfig, pipelineContext, agentMetrics) {
  const tier = agentConfig.type;
  const caps = (agentConfig.capabilities || []).join(', ');
  const hierarchy = agentConfig.hierarchy || {};
  const mode = agentConfig.mode || 'normal';

  let prompt = `You are ${agentConfig.id}, a ${tier}-tier agent in the Optimus organization.`;
  prompt += ` Your capabilities: ${caps || 'general'}.`;
  prompt += ` You report to: ${hierarchy.reportsTo || 'board'}.`;
  prompt += ` Your current model: ${agentConfig.model}, temperature: ${agentConfig.temperature ?? 'default'}.`;

  if (mode === 'suggest') {
    prompt += ` IMPORTANT: You operate in SUGGEST mode. You may propose actions but cannot execute them directly. Frame recommendations as suggestions for the board to approve.`;
  }

  if (tier === 'strategist') {
    prompt += ` You provide strategic analysis and priority recommendations. Be thoughtful and thorough.`;
  } else if (tier === 'orchestrator') {
    prompt += ` You coordinate pipeline operations. Be concise and action-oriented.`;
  } else if (tier === 'architect') {
    prompt += ` You analyze system patterns and suggest optimizations. Be analytical.`;
  } else if (tier === 'executor') {
    prompt += ` You handle specific execution tasks. Be precise and efficient.`;
  } else if (tier === 'reviewer') {
    prompt += ` You review quality and enforce constitutional gates. Be thorough and specific.`;
  }

  prompt += `\n\nYou are chatting with a board member. Be conversational but substantive. Answer questions about your domain, provide status updates, and offer recommendations. When asked about your performance or efficiency, use your metrics data to give grounded answers.

CRITICAL: You MUST use your tools to answer questions. NEVER describe what you would do — actually call the tool. NEVER say "I'll search the knowledge base" — call search_knowledge_base immediately. NEVER say "I'll create a campaign" — call create_campaign immediately.

Your tools:
- search_knowledge_base: ALWAYS call this when asked about decisions, architecture, people, projects, or anything that might be in the knowledge base. Call it FIRST, then answer using the results.
- create_campaign: Call when asked to build or create something.
- check_pipeline: Call when asked about status, budget, or what's happening.
- list_campaigns: Call when asked about recent campaigns.
- list_drafts: Call when asked about pending approvals.
- approve_proposal: Call when asked to approve something.

If you're unsure whether to use a tool, USE IT. Tools give you real data. Without tools you are guessing. Never narrate your intentions — execute them.`;

  prompt += `\n\nSPECIAL COMMANDS the board member may use:
- "review task <id>" or "task #<id>" — they want to discuss a specific work item. Use the task context provided below.
- "flag this" or "this was wrong" — they are flagging a decision for review. Acknowledge and confirm the feedback was logged.`;

  if (agentMetrics) {
    prompt += `\n\n${agentMetrics}`;
  }

  if (pipelineContext) {
    prompt += `\n\n${pipelineContext}`;
  }

  return prompt;
}

/**
 * Gather lightweight pipeline context for the system prompt.
 */
async function gatherPipelineContext() {
  const parts = ['<pipeline_context>'];

  try {
    const [budget, activity] = await Promise.all([
      query(`SELECT allocated_usd, spent_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'in_progress') AS active_tasks, COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= CURRENT_DATE) AS completed_today, COUNT(DISTINCT assigned_to) FILTER (WHERE status = 'in_progress') AS active_agents FROM agent_graph.work_items WHERE updated_at >= CURRENT_DATE - 1`),
    ]);

    const b = budget.rows[0];
    if (b) {
      parts.push(`Budget (today): $${parseFloat(b.spent_usd || 0).toFixed(2)} / $${parseFloat(b.allocated_usd || 0).toFixed(2)}`);
    }

    const a = activity.rows[0];
    if (a) {
      parts.push(`Agent activity: ${a.active_agents || 0} active agents, ${a.active_tasks || 0} in-progress, ${a.completed_today || 0} completed today`);
    }
  } catch (err) {
    // Linus: sanitize error strings before prompt injection
    parts.push(`(pipeline context unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</pipeline_context>');
  return parts.join('\n');
}

/**
 * Gather agent-specific performance metrics for self-awareness.
 * Liotta: single SQL query, under 200 tokens, O(log n) with existing indexes.
 */
async function gatherAgentMetrics(agentId) {
  const parts = ['<agent_metrics>'];

  try {
    // 7-day performance summary from llm_invocations
    const metricsResult = await query(
      `SELECT
         count(*) AS invocations,
         COALESCE(SUM(cost_usd), 0) AS total_cost,
         COALESCE(AVG(cost_usd), 0) AS avg_cost,
         COALESCE(AVG(input_tokens + output_tokens), 0) AS avg_tokens,
         COALESCE(SUM(input_tokens), 0) AS total_input,
         COALESCE(SUM(output_tokens), 0) AS total_output
       FROM agent_graph.llm_invocations
       WHERE agent_id = $1 AND created_at > now() - interval '7 days'`,
      [agentId]
    );

    const m = metricsResult.rows[0];
    if (m && parseInt(m.invocations) > 0) {
      parts.push(`Your performance (last 7 days):`);
      parts.push(`  Invocations: ${m.invocations}`);
      parts.push(`  Total cost: $${parseFloat(m.total_cost).toFixed(4)}`);
      parts.push(`  Avg cost/invocation: $${parseFloat(m.avg_cost).toFixed(4)}`);
      parts.push(`  Avg tokens/invocation: ${Math.round(parseFloat(m.avg_tokens))}`);
      parts.push(`  Total tokens: ${parseInt(m.total_input).toLocaleString()} in / ${parseInt(m.total_output).toLocaleString()} out`);
    } else {
      parts.push(`No invocations recorded in the last 7 days.`);
    }

    // Task completion stats (if this agent has work_items)
    const taskResult = await query(
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
         count(*) FILTER (WHERE status IN ('in_progress', 'assigned')) AS active
       FROM agent_graph.work_items
       WHERE assigned_to = $1 AND created_at > now() - interval '7 days'`,
      [agentId]
    );

    const t = taskResult.rows[0];
    if (t && parseInt(t.total) > 0) {
      const completionRate = parseInt(t.total) > 0
        ? ((parseInt(t.completed) / parseInt(t.total)) * 100).toFixed(0)
        : '0';
      parts.push(`  Tasks (7d): ${t.total} total, ${t.completed} completed, ${t.cancelled} cancelled, ${t.active} active (${completionRate}% completion rate)`);
    }
  } catch (err) {
    // Linus: sanitize error strings before prompt injection
    parts.push(`(metrics unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</agent_metrics>');
  return parts.join('\n');
}

/**
 * Create a new chat session. Linus #2: server-generated UUID.
 * @param {string} agentId
 * @param {string} boardUser
 * @returns {{ sessionId: string }}
 */
export async function createChatSession(agentId, boardUser) {
  const config = await loadConfig();
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (!agent.chat?.enabled) throw new Error(`Chat not enabled for agent: ${agentId}`);

  return { sessionId: randomUUID() };
}

/**
 * Handle a chat message from a board member.
 * @param {string} agentId
 * @param {string} message
 * @param {{ boardUser: string, sessionId: string }} options
 * @returns {Promise<{ text: string, costUsd: number, sessionId: string, model: string }>}
 */
export async function handleAgentChat(agentId, message, { boardUser, sessionId, mode, pageContext }) {
  const config = await loadConfig();
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (!agent.chat?.enabled) throw new Error(`Chat not enabled for agent: ${agentId}`);

  // Linus #6: lock model at invocation time (from fresh config)
  const model = agent.model;
  const maxCostPerSession = agent.chat.maxCostPerSession || 1.00;

  // Linus #3: budget check — session cost accumulator
  const sessionCostResult = await query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost FROM agent_graph.board_chat_messages WHERE session_id = $1`,
    [sessionId]
  );
  const sessionCost = parseFloat(sessionCostResult.rows[0]?.total_cost || 0);
  if (sessionCost >= maxCostPerSession) {
    throw new Error(`Session budget exceeded ($${sessionCost.toFixed(4)} / $${maxCostPerSession.toFixed(2)}). Start a new session.`);
  }

  // --- Flag decision detection (item 4: board feedback loop) ---
  const flagMatch = message.match(/\b(flag\s+(?:this|decision|that)|this\s+was\s+wrong|incorrect|bad\s+decision)\b/i);
  if (flagMatch) {
    await logBoardFeedback(agentId, sessionId, boardUser, message);
  }

  // --- Work item context loading (item 4: "review task 1234") ---
  const taskRefMatch = message.match(/(?:review\s+task|task\s*#?|work\s*item\s*#?)(\d+)/i);
  let taskContext = '';
  if (taskRefMatch) {
    taskContext = await loadWorkItemContext(parseInt(taskRefMatch[1], 10));
  }

  // Load conversation history (last 20 messages for this session)
  const historyResult = await query(
    `SELECT role, content FROM agent_graph.board_chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 20`,
    [sessionId]
  );
  const history = historyResult.rows.map(r => ({ role: r.role, content: r.content }));

  // Linus #5: pipeline context + agent metrics + RAG knowledge in system prompt only
  // Only query RAG when the message looks like a knowledge question (skip greetings,
  // simple commands, and short messages to save latency + embedding cost)
  let ragContext = null;
  const lowerMsg = message.toLowerCase().trim();
  const isKnowledgeQuery = lowerMsg.length > 15 && /\b(what|how|why|when|where|who|which|show|explain|tell|find|search|look up|status|history|decision|spec|architecture|campaign|pipeline|agent|draft|briefing|contact|meeting|budget)\b/.test(lowerMsg);
  if (isKnowledgeQuery) {
    try {
      const { retrieveContext } = await import('../../../lib/rag/retriever.js');
      const ragOpts = { maxClassification: 'INTERNAL', history };

      // Project-scoped RAG: try project documents first, fall back to global
      let projectDocIds = null;
      if (pageContext?.entityType === 'project' && pageContext?.entityId) {
        try {
          const projLookup = await query(
            `SELECT id FROM agent_graph.projects WHERE slug = $1`, [pageContext.entityId]
          );
          if (projLookup.rows[0]) {
            const docResult = await query(
              `SELECT entity_id FROM agent_graph.project_memberships WHERE project_id = $1 AND entity_type = 'document'`,
              [projLookup.rows[0].id]
            );
            if (docResult.rows.length > 0) {
              projectDocIds = docResult.rows.map(r => r.entity_id);
            }
          }
        } catch { /* non-critical — fall through to global RAG */ }
      }

      if (projectDocIds && projectDocIds.length > 0) {
        // Try project-scoped search first
        ragContext = await retrieveContext(message, { ...ragOpts, documentIds: projectDocIds });
        // Fall back to global if project-scoped returned nothing useful
        if (!ragContext?.answer) {
          ragContext = await retrieveContext(message, ragOpts);
        }
      } else {
        ragContext = await retrieveContext(message, ragOpts);
      }
    } catch { /* RAG unavailable — degrade gracefully */ }
  }

  const [pipelineContext, agentMetrics] = await Promise.all([
    gatherPipelineContext(),
    gatherAgentMetrics(agentId),
  ]);
  let systemPrompt = buildChatSystemPrompt(agent, pipelineContext, agentMetrics);

  // Inject RAG knowledge base context (Phase A: agents now use institutional knowledge)
  if (ragContext?.answer) {
    systemPrompt += `\n\n<knowledge_base>\nRelevant context from the Optimus knowledge base (${ragContext.citations?.length || 0} sources):\n\n${ragContext.answer}\n</knowledge_base>`;
  }

  // Inject page context if the board member is viewing a specific page
  if (pageContext?.route) {
    let contextBlock = `The user is currently viewing: ${pageContext.title || pageContext.route} (${pageContext.route}).`;
    if (pageContext.entityType) contextBlock += ` Entity type: ${pageContext.entityType}.`;
    if (pageContext.entityId) contextBlock += ` Entity ID: ${pageContext.entityId}.`;

    // Enrich with entity-specific data from the database
    if (pageContext.entityType === 'campaign' && pageContext.entityId) {
      try {
        const camp = await query(
          `SELECT goal_description, campaign_status, campaign_mode, completed_iterations, max_iterations, spent_usd, success_criteria
           FROM agent_graph.campaigns WHERE id = $1`, [pageContext.entityId]
        );
        if (camp.rows[0]) {
          const c = camp.rows[0];
          contextBlock += `\nCampaign: "${c.goal_description?.slice(0, 200)}"`;
          contextBlock += `\nStatus: ${c.campaign_status}, Mode: ${c.campaign_mode}, Iterations: ${c.completed_iterations}/${c.max_iterations}, Spent: $${parseFloat(c.spent_usd || 0).toFixed(2)}`;
          if (c.success_criteria) contextBlock += `\nSuccess criteria: ${JSON.stringify(c.success_criteria).slice(0, 300)}`;
        }
      } catch { /* non-critical */ }
    }

    if (pageContext.entityType === 'project' && pageContext.entityId) {
      try {
        const proj = await query(
          `SELECT id, name, description, instructions, classification_floor FROM agent_graph.projects WHERE slug = $1`,
          [pageContext.entityId]
        );
        if (proj.rows[0]) {
          const p = proj.rows[0];
          contextBlock += `\nProject: "${p.name}"${p.description ? ` — ${p.description}` : ''}`;
          contextBlock += `\nClassification: ${p.classification_floor}`;
          if (p.instructions) contextBlock += `\nProject instructions: ${p.instructions.slice(0, 500)}`;
          // Load active project memory
          const mem = await query(
            `SELECT key, value FROM agent_graph.project_memory WHERE project_id = $1 AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 10`,
            [p.id]
          );
          if (mem.rows.length > 0) {
            contextBlock += `\nProject memory:\n${mem.rows.map(m => `- ${m.key}: ${m.value.slice(0, 200)}`).join('\n')}`;
          }
        }
      } catch { /* non-critical */ }
    }

    // Pass through any additional metadata from the page
    if (pageContext.metadata && Object.keys(pageContext.metadata).length > 0) {
      contextBlock += `\nPage data: ${JSON.stringify(pageContext.metadata).slice(0, 500)}`;
    }

    systemPrompt += `\n\n<page_context>${contextBlock}\nUse this context when answering questions about the current page.</page_context>`;
  }

  // Append work item context if referenced
  if (taskContext) {
    systemPrompt += `\n\n<work_item_context>\n${taskContext}\n</work_item_context>`;
  }

  // Build messages: history + current user message (standalone, Linus #5)
  const llmMessages = [...history, { role: 'user', content: message }];

  // Linus #7: per-agent cached client (cache key includes model for invalidation)
  const llm = getLLMForAgent(agentId, config);

  // Plan/Build mode: in Plan mode, strip action tools and add instruction
  const isPlanMode = mode === 'plan' || !mode;
  const ACTION_TOOLS = new Set(['create_campaign', 'approve_proposal']);
  const activeTools = isPlanMode
    ? CHAT_TOOLS.filter(t => !ACTION_TOOLS.has(t.name))
    : CHAT_TOOLS;
  if (isPlanMode) {
    systemPrompt += '\n\n<mode>PLAN MODE: Discuss, analyze, and plan only. Do NOT create campaigns or execute actions. Help the user think through their request before they switch to Build mode.</mode>';
  }

  // Tool-use loop: agent can call tools, we execute and feed results back
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let responseText = '';
  const MAX_TOOL_ROUNDS = 3;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callProvider(llm, {
      system: systemPrompt,
      messages: llmMessages,
      maxTokens: agent.maxTokens || 2048,
      temperature: agent.temperature ?? 0.3,
      tools: activeTools,
    });

    totalInputTokens += response.inputTokens || 0;
    totalOutputTokens += response.outputTokens || 0;

    // If no tool calls, we're done — capture text response
    if (!response.toolCalls || response.toolCalls.length === 0 || response.stopReason !== 'tool_use') {
      responseText = response.text || 'No response generated.';
      break;
    }

    // Tool calls: execute each one and add results to messages
    // First, add the assistant's response (with tool_use blocks) to messages
    llmMessages.push({ role: 'assistant', content: response.raw?.content || [] });

    for (const toolCall of response.toolCalls) {
      const toolResult = await executeChatTool(toolCall.name, toolCall.input || {});
      llmMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: toolResult }],
      });
      console.log(`[agent-chat] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}) → ${toolResult.slice(0, 100)}`);
    }

    // Capture any text from tool-calling turn (agent may say something + call a tool)
    if (response.text) {
      responseText = response.text;
    }
  }

  // If we ended on a tool call, get final text response
  if (!responseText) {
    responseText = 'Action completed.';
  }

  const costUsd = computeCost(totalInputTokens, totalOutputTokens, llm.modelConfig);

  // Persist both turns to Postgres
  await query(
    `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content) VALUES ($1, $2, $3, 'user', $4)`,
    [sessionId, agentId, boardUser, message]
  );
  await query(
    `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content, cost_usd, model) VALUES ($1, $2, $3, 'assistant', $4, $5, $6)`,
    [sessionId, agentId, boardUser, responseText, costUsd, model]
  );

  // Linus #4: audit trail in llm_invocations
  try {
    await query(
      `INSERT INTO agent_graph.llm_invocations (agent_id, model, input_tokens, output_tokens, cost_usd, task_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [agentId, model, totalInputTokens, totalOutputTokens, costUsd, sessionId]
    );
  } catch (err) {
    console.warn(`[agent-chat] Failed to log invocation: ${err.message}`);
  }

  console.log(`[agent-chat] ${boardUser} → ${agentId} (${model}): ${totalInputTokens}+${totalOutputTokens} tokens, $${costUsd.toFixed(4)}`);

  return { text: responseText, costUsd, sessionId, model };
}

/**
 * Get chat history for a session.
 * @param {string} sessionId
 * @returns {Promise<{ messages: Array<{ role: string, content: string, cost_usd: number, model: string, created_at: string }> }>}
 */
export async function getChatHistory(sessionId) {
  const result = await query(
    `SELECT role, content, cost_usd, model, agent_id, created_at FROM agent_graph.board_chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId]
  );
  return { messages: result.rows };
}

/**
 * List all chat sessions for an agent, grouped by session.
 * @param {string} agentId
 * @param {number} [limit=20]
 * @returns {Promise<{ sessions: Array<{ sessionId: string, boardUser: string, messageCount: number, totalCost: number, firstMessage: string, lastActive: string }> }>}
 */
export async function listChatSessions(agentId, limit = 20) {
  const result = await query(
    `SELECT
       session_id,
       board_user,
       COUNT(*) AS message_count,
       COALESCE(SUM(cost_usd), 0) AS total_cost,
       MIN(created_at) AS first_message,
       MAX(created_at) AS last_active,
       (SELECT content FROM agent_graph.board_chat_messages m2
        WHERE m2.session_id = m.session_id AND m2.role = 'user'
        ORDER BY m2.created_at ASC LIMIT 1) AS first_user_message
     FROM agent_graph.board_chat_messages m
     WHERE agent_id = $1
     GROUP BY session_id, board_user
     ORDER BY MAX(created_at) DESC
     LIMIT $2`,
    [agentId, limit]
  );

  return {
    sessions: result.rows.map(r => ({
      sessionId: r.session_id,
      boardUser: r.board_user,
      messageCount: parseInt(r.message_count),
      totalCost: parseFloat(r.total_cost),
      firstMessage: r.first_user_message,
      lastActive: r.last_active,
    })),
  };
}

// ============================================================
// Chat Tools — actions agents can take during conversation
// ============================================================

const CHAT_TOOLS = [
  {
    name: 'create_campaign',
    description: 'Create a new campaign for the agent organization to execute. Use when the user wants to build something, create content, or run an iterative task.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What to build or do — be specific' },
        budget_usd: { type: 'number', description: 'Budget in USD (default 10)' },
        campaign_mode: { type: 'string', enum: ['stateless', 'stateful'], description: 'stateless for builds, stateful for system modifications' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'check_pipeline',
    description: 'Check the current pipeline status — active tasks, queue depth, agent activity, budget.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description: 'List recent campaigns with their status, score, and iteration count.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: running, succeeded, failed, pending_approval' },
      },
    },
  },
  {
    name: 'approve_proposal',
    description: 'Approve a pending draft, proposal, or action item.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Proposal/draft UUID' } },
      required: ['id'],
    },
  },
  {
    name: 'list_drafts',
    description: 'List pending drafts and action proposals awaiting board review.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_knowledge_base',
    description: 'Search the Optimus knowledge base (documents, meeting transcripts, vault notes) for specific information. Use when the board member asks about past decisions, project context, or institutional knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for — be specific' },
      },
      required: ['query'],
    },
  },
];

async function executeChatTool(toolName, toolInput) {
  switch (toolName) {
    case 'create_campaign': {
      // Match the proper campaigns API POST handler (campaigns.js) exactly
      const goal = toolInput.goal || 'Campaign from chat';
      const budgetUsd = toolInput.budget_usd || 10;
      const title = `Campaign: ${goal.slice(0, 60)}`;

      // Dedup: check if same goal was created in last 60s
      const existing = await query(
        `SELECT id FROM agent_graph.campaigns
         WHERE created_by = 'board-chat'
         AND created_at > now() - interval '60 seconds'
         AND goal_description = $1 LIMIT 1`,
        [goal]
      );
      if (existing.rows.length > 0) {
        return JSON.stringify({ ok: true, campaign_id: existing.rows[0].id, status: 'already_exists', message: 'Campaign already created.' });
      }

      // Work item (type 'campaign', not 'task') — required for campaign list queries
      const wi = await query(
        `INSERT INTO agent_graph.work_items (id, type, title, description, status, priority, assigned_to, created_by, delegation_depth)
         VALUES (gen_random_uuid(), 'campaign', $1, $2, 'assigned', 5, 'claw-campaigner', 'board-chat', 0)
         RETURNING id`,
        [title, goal]
      );
      const workItemId = wi.rows[0]?.id;
      if (!workItemId) return JSON.stringify({ ok: false, error: 'Failed to create work item' });

      const metadata = { campaign_type: 'build', source: 'board_chat' };
      const result = await query(
        `INSERT INTO agent_graph.campaigns (
          id, work_item_id, goal_description, budget_envelope_usd, campaign_mode,
          campaign_status, max_iterations, iteration_time_budget,
          success_criteria, constraints, created_by, metadata
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 'stateless',
          'approved', 20, '5 minutes'::interval,
          $4::jsonb, '{"tool_allowlist": ["llm_invoke"], "max_cost_per_iteration": 0.50}'::jsonb,
          'board-chat', $5::jsonb
        ) RETURNING id`,
        [
          workItemId, goal, budgetUsd,
          JSON.stringify([{ metric: 'quality_score', operator: '>=', threshold: 0.85 }]),
          JSON.stringify(metadata),
        ]
      );
      const campaignId = result.rows[0]?.id;

      // Publish event for SSE listeners + campaigner wake
      try {
        const { publishEvent } = await import('../runtime/infrastructure.js');
        await publishEvent('campaign_approved', `Campaign ${campaignId} created via board chat`, 'board-chat', null, { campaign_id: campaignId });
      } catch { /* non-fatal */ }

      return JSON.stringify({ ok: true, campaign_id: campaignId, work_item_id: workItemId, status: 'approved', message: `Campaign ${campaignId} created and approved.` });
    }
    case 'check_pipeline': {
      const [budget, activity, health] = await Promise.all([
        query(`SELECT allocated_usd, spent_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1`),
        query(`SELECT status, COUNT(*) AS count FROM agent_graph.work_items WHERE updated_at >= CURRENT_DATE - 1 GROUP BY status`),
        query(`SELECT assigned_to AS agent, COUNT(*) AS tasks FROM agent_graph.work_items WHERE status IN ('assigned', 'in_progress') GROUP BY assigned_to ORDER BY COUNT(*) DESC`),
      ]);
      return JSON.stringify({
        budget: budget.rows[0] || {},
        task_counts: Object.fromEntries(activity.rows.map(r => [r.status, parseInt(r.count)])),
        active_agents: health.rows.map(r => ({ agent: r.agent, tasks: parseInt(r.tasks) })),
      });
    }
    case 'list_campaigns': {
      const statusFilter = toolInput.status ? `WHERE campaign_status = $1` : '';
      const params = toolInput.status ? [toolInput.status] : [];
      const result = await query(
        `SELECT id, goal_description, campaign_status, best_score, completed_iterations, max_iterations, budget_envelope_usd, spent_usd, created_at
         FROM agent_graph.campaigns ${statusFilter} ORDER BY created_at DESC LIMIT 10`,
        params
      );
      return JSON.stringify({ campaigns: result.rows });
    }
    case 'approve_proposal': {
      await query(
        `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now() WHERE id = $1`,
        [toolInput.id]
      );
      return JSON.stringify({ ok: true, message: `Proposal ${toolInput.id} approved.` });
    }
    case 'list_drafts': {
      const result = await query(
        `SELECT id, action_type, LEFT(body, 200) AS summary, reviewer_verdict, created_at
         FROM agent_graph.action_proposals WHERE board_action IS NULL ORDER BY created_at DESC LIMIT 10`
      );
      return JSON.stringify({ drafts: result.rows });
    }
    case 'search_knowledge_base': {
      try {
        const { retrieveContext } = await import('../../../lib/rag/retriever.js');
        const result = await retrieveContext(toolInput.query, { maxClassification: 'INTERNAL' });
        if (!result) return JSON.stringify({ results: [], message: 'No relevant documents found.' });
        return JSON.stringify({
          results: result.citations.map(c => ({
            text: c.text,
            similarity: c.similarity.toFixed(3),
            source: c.metadata?.source || 'unknown',
          })),
          summary: result.answer.slice(0, 2000),
        });
      } catch (err) {
        return JSON.stringify({ error: `Knowledge base search failed: ${err.message}` });
      }
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

/**
 * Auto-route a board member's message to the best agent.
 * Uses keyword heuristics first (zero cost), falls back to the orchestrator
 * for ambiguous messages. Returns the selected agentId.
 */
export function autoRouteMessage(message) {
  const msg = message.toLowerCase();

  // Campaign/build requests → orchestrator
  if (/\b(build|campaign|create|launch|deploy|ship|implement)\b/.test(msg)) return 'orchestrator';

  // Strategy/priority questions → strategist
  if (/\b(priorit|strateg|recommend|what should|most important|focus)\b/.test(msg)) return 'strategist';

  // Code/PR/bug questions → architect or coder context
  if (/\b(code|bug|pr |pull request|refactor|fix|error|stack trace|test)\b/.test(msg)) return 'architect';

  // Review/quality/gate questions → reviewer
  if (/\b(review|approve|reject|gate|quality|tone|draft)\b/.test(msg)) return 'reviewer';

  // Status/pipeline/what's happening → orchestrator
  if (/\b(status|pipeline|what.s (going|happening)|active|running|stuck|queue)\b/.test(msg)) return 'orchestrator';

  // Research → claw-explorer
  if (/\b(research|explore|investigate|deep dive|analyze)\b/.test(msg)) return 'claw-explorer';

  // Default: orchestrator handles general queries
  return 'orchestrator';
}

/**
 * Load work item context for chat — allows board members to discuss specific tasks.
 * @param {number} workItemId
 * @returns {Promise<string>} Formatted context block
 */
async function loadWorkItemContext(workItemId) {
  try {
    const result = await query(
      `SELECT id, title, status, assigned_to, created_by, priority, routing_class,
              metadata, created_at, updated_at
       FROM agent_graph.work_items WHERE id = $1`,
      [workItemId]
    );

    if (result.rows.length === 0) return `Work item #${workItemId} not found.`;

    const wi = result.rows[0];
    const parts = [
      `Work Item #${wi.id}: ${wi.title}`,
      `Status: ${wi.status} | Assigned to: ${wi.assigned_to} | Created by: ${wi.created_by}`,
      `Priority: ${wi.priority} | Routing class: ${wi.routing_class || 'n/a'}`,
      `Created: ${wi.created_at} | Updated: ${wi.updated_at}`,
    ];

    // Include relevant metadata (sanitized)
    if (wi.metadata) {
      const meta = typeof wi.metadata === 'string' ? JSON.parse(wi.metadata) : wi.metadata;
      if (meta.triage_result) parts.push(`Triage: category=${meta.triage_result.category}, needs_strategist=${meta.triage_result.needs_strategist}`);
      if (meta.strategy_result) parts.push(`Strategy: urgency=${meta.strategy_result.urgency}, recommendation=${meta.strategy_result.recommendation}`);
      if (meta.draft_id) parts.push(`Draft ID: ${meta.draft_id}`);
      if (meta.ticket_result) parts.push(`Ticket: category=${meta.ticket_result.category}, severity=${meta.ticket_result.severity}`);
    }

    // Load state transitions for this work item
    const transitions = await query(
      `SELECT from_state, to_state, agent_id, reason, created_at
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [workItemId]
    );
    if (transitions.rows.length > 0) {
      parts.push('', 'State transitions:');
      for (const t of transitions.rows) {
        parts.push(`  ${t.from_state || 'n/a'} → ${t.to_state} by ${t.agent_id} (${t.reason || 'no reason'})`);
      }
    }

    // Load child work items
    const children = await query(
      `SELECT id, title, status, assigned_to FROM agent_graph.work_items
       WHERE parent_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [workItemId]
    );
    if (children.rows.length > 0) {
      parts.push('', 'Child tasks:');
      for (const c of children.rows) {
        parts.push(`  #${c.id}: ${c.title} (${c.status}, assigned to ${c.assigned_to})`);
      }
    }

    return parts.join('\n');
  } catch (err) {
    return `Error loading work item #${workItemId}: ${sanitize(err.message)}`;
  }
}

/**
 * Log board feedback as an audit entry when a board member flags a decision.
 * Creates a state_transition-like audit record for accountability (P3).
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @param {string} boardUser
 * @param {string} message
 */
async function logBoardFeedback(agentId, sessionId, boardUser, message) {
  try {
    // Find the most recent work item this agent completed (for context)
    const recentWork = await query(
      `SELECT id FROM agent_graph.work_items
       WHERE assigned_to = $1 AND status = 'completed'
       ORDER BY updated_at DESC LIMIT 1`,
      [agentId]
    );
    const workItemId = recentWork.rows[0]?.id || null;

    // Log to task events (P3: transparency by structure)
    await query(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, event_data)
       VALUES ('board_feedback', $1, $2, $3::jsonb)`,
      [
        workItemId,
        agentId,
        JSON.stringify({ board_user: boardUser, session_id: sessionId, feedback: message.slice(0, 500), flagged_at: new Date().toISOString() }),
      ]
    );

    console.log(`[agent-chat] Board feedback logged: ${boardUser} flagged ${agentId} (workItem: ${workItemId || 'n/a'})`);
  } catch (err) {
    console.warn(`[agent-chat] Failed to log board feedback: ${err.message}`);
  }
}

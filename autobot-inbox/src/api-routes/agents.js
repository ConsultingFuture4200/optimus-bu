/**
 * Agent Configuration API routes.
 *
 * GET  /api/agents/config — Read current agents.json (agents + models)
 * POST /api/agents/config — Update an agent's model/temperature/maxTokens or a model entry
 *
 * Config changes are written to disk and take effect on next agent restart.
 * The running agents reload config on startup (AgentLoop constructor reads agents.json).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createChatSession, handleAgentChat, getChatHistory, listChatSessions, autoRouteMessage } from '../commands/agent-chat.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { query } from '../db.js';
import { clearConfigCache } from '../../../lib/runtime/config-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'agents.json');
const CHANGELOG_PATH = join(__dirname, '..', '..', 'config', 'agents-changelog.jsonl');

// Track workstation LLM spend for rate limiting
const _workstationSpendLog = [];

function getWorkstationHourlySpend() {
  const oneHourAgo = Date.now() - 3600_000;
  // Prune old entries
  while (_workstationSpendLog.length > 0 && _workstationSpendLog[0].ts < oneHourAgo) {
    _workstationSpendLog.shift();
  }
  return Promise.resolve(_workstationSpendLog.reduce((sum, e) => sum + e.cost, 0));
}

function recordWorkstationSpend(costUsd) {
  _workstationSpendLog.push({ ts: Date.now(), cost: costUsd });
}

function loadConfigFromDisk() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Load config with DB overrides merged on top of disk defaults.
 * agents.json = git-committed defaults. DB overrides survive Railway deploys.
 */
async function loadConfig() {
  const config = loadConfigFromDisk();

  try {
    // Merge agent config overrides
    const overrides = await query(`SELECT agent_id, field, value FROM agent_graph.agent_config_overrides`);
    for (const row of overrides.rows) {
      if (config.agents[row.agent_id]) {
        try {
          config.agents[row.agent_id][row.field] = JSON.parse(row.value);
        } catch {
          config.agents[row.agent_id][row.field] = row.value;
        }
      }
    }

    // Merge model config overrides (added models)
    const modelOverrides = await query(`SELECT model_key, config FROM agent_graph.model_config_overrides`);
    for (const row of modelOverrides.rows) {
      const override = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
      config.models[row.model_key] = { ...(config.models[row.model_key] || {}), ...override };
    }
  } catch {
    // DB unavailable (PGlite/test) — use disk config only
  }

  return config;
}

async function saveConfig(config, changeContext) {
  if (changeContext) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      boardUser: changeContext.boardUser || 'unknown',
      agentId: changeContext.agentId || null,
      modelKey: changeContext.modelKey || null,
      changes: changeContext.changes || {},
    }) + '\n';
    appendFileSync(CHANGELOG_PATH, entry, 'utf-8');
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  // Notify runners of config change (pg_notify for live reload)
  try {
    const { publishEvent } = await import('../runtime/infrastructure.js');
    await publishEvent('agent_config_changed', 'Agent config updated via dashboard', null, null, changeContext || {});
  } catch {}
}

// Linus: board-role gate for config mutations
function requireBoard(req) {
  if (req.auth?.role && req.auth.role !== 'board') {
    const e = new Error('Board role required for config changes');
    e.statusCode = 403;
    throw e;
  }
}

export function registerAgentRoutes(routes) {
  // GET /api/agents/config — returns full agents + models config (with DB overrides)
  routes.set('GET /api/agents/config', async () => {
    const config = await loadConfig();
    return {
      agents: config.agents,
      models: config.models,
      workstation: config.workstation || {},
    };
  });

  // POST /api/agents/config — update agent or model settings
  // Body: { agentId, changes: { model?, temperature?, maxTokens?, enabled? } }
  //   OR: { modelKey, changes: { provider?, inputCostPer1M?, outputCostPer1M?, contextWindow?, maxOutput? } }
  routes.set('POST /api/agents/config', async (req, body) => {
    requireBoard(req);
    const config = await loadConfig();

    if (body.agentId) {
      const agent = config.agents[body.agentId];
      if (!agent) {
        const err = new Error(`Unknown agent: ${body.agentId}`);
        err.statusCode = 400;
        throw err;
      }

      const allowed = ['model', 'temperature', 'maxTokens', 'enabled', 'chat'];
      for (const [key, value] of Object.entries(body.changes || {})) {
        if (!allowed.includes(key)) continue;

        // Validate model exists in models config
        if (key === 'model') {
          if (!config.models[value]) {
            const err = new Error(`Unknown model: ${value}. Add it to models config first.`);
            err.statusCode = 400;
            throw err;
          }
        }

        // Validate temperature range
        if (key === 'temperature') {
          const temp = parseFloat(value);
          if (isNaN(temp) || temp < 0 || temp > 2) {
            const err = new Error(`Temperature must be 0-2, got ${value}`);
            err.statusCode = 400;
            throw err;
          }
          agent[key] = temp;
          continue;
        }

        // Validate maxTokens
        if (key === 'maxTokens') {
          const tokens = parseInt(value, 10);
          if (isNaN(tokens) || tokens < 1) {
            const err = new Error(`maxTokens must be positive, got ${value}`);
            err.statusCode = 400;
            throw err;
          }
          agent[key] = tokens;
          continue;
        }

        // enabled is boolean
        if (key === 'enabled') {
          agent[key] = Boolean(value);
          continue;
        }

        // chat config object
        if (key === 'chat') {
          if (typeof value !== 'object' || value === null) continue;
          const chatUpdate = {};
          if ('enabled' in value) chatUpdate.enabled = Boolean(value.enabled);
          if ('maxCostPerSession' in value) {
            const cost = parseFloat(value.maxCostPerSession);
            if (isNaN(cost) || cost < 0 || cost > 10) {
              const err = new Error('chat.maxCostPerSession must be 0-10');
              err.statusCode = 400;
              throw err;
            }
            chatUpdate.maxCostPerSession = cost;
          }
          agent.chat = { ...(agent.chat || {}), ...chatUpdate };
          continue;
        }

        agent[key] = value;
      }

      const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'system';

      // Persist overrides to DB (survives Railway deploys)
      const dbFields = ['model', 'temperature', 'maxTokens', 'enabled'];
      for (const [key, value] of Object.entries(body.changes || {})) {
        if (dbFields.includes(key)) {
          try {
            await query(
              `INSERT INTO agent_graph.agent_config_overrides (agent_id, field, value, changed_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (agent_id, field) DO UPDATE SET value = $3, changed_by = $4, changed_at = now()`,
              [body.agentId, key, JSON.stringify(value), boardUser]
            );
          } catch { /* DB unavailable — disk-only fallback */ }
        }
      }

      saveConfig(config, { boardUser, agentId: body.agentId, changes: body.changes });
      clearConfigCache(); // Invalidate shared config cache so runtime picks up changes
      return { ok: true, agent: config.agents[body.agentId] };
    }

    if (body.modelKey) {
      const changes = body.changes || {};
      const existing = config.models[body.modelKey] || {};

      const allowed = ['provider', 'inputCostPer1M', 'outputCostPer1M', 'contextWindow', 'maxOutput'];
      for (const [key, value] of Object.entries(changes)) {
        if (!allowed.includes(key)) continue;
        existing[key] = value;
      }

      config.models[body.modelKey] = existing;
      const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'system';
      saveConfig(config, { boardUser, modelKey: body.modelKey, changes: body.changes });
      clearConfigCache(); // Invalidate shared config cache so runtime picks up changes
      return { ok: true, model: config.models[body.modelKey] };
    }

    const err = new Error('Provide agentId or modelKey');
    err.statusCode = 400;
    throw err;
  });

  // POST /api/models/sync — Fetch OpenRouter catalog (Linus: board-only, timeout, validation)
  routes.set('POST /api/models/sync', async (req) => {
    requireBoard(req);
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = new Error(`OpenRouter API returned ${res.status}`);
      err.statusCode = 502;
      throw err;
    }
    const { data } = await res.json();

    // Transform + validate (Linus: NaN costs would break G1 budget enforcement)
    const models = (data || []).slice(0, 500).map(m => {
      const promptPrice = parseFloat(m.pricing?.prompt || '0');
      const completionPrice = parseFloat(m.pricing?.completion || '0');
      const inputCost = +(promptPrice * 1_000_000).toFixed(4);
      const outputCost = +(completionPrice * 1_000_000).toFixed(4);
      return {
        id: m.id,
        name: m.name || m.id,
        provider: m.id.split('/')[0] || 'unknown',
        contextWindow: m.context_length || 0,
        maxOutput: m.top_provider?.max_completion_tokens || 0,
        inputCostPer1M: Number.isFinite(inputCost) && inputCost >= 0 ? inputCost : 0,
        outputCostPer1M: Number.isFinite(outputCost) && outputCost >= 0 ? outputCost : 0,
        supportsTools: (m.supported_parameters || []).includes('tools'),
        description: (m.description || '').slice(0, 300),
      };
    });

    return { models, count: models.length };
  });

  // POST /api/models/add — Add a model to agents.json
  // Body: { modelId, provider, inputCostPer1M, outputCostPer1M, contextWindow, maxOutput }
  routes.set('POST /api/models/add', async (req, body) => {
    requireBoard(req);
    if (!body.modelId) {
      const err = new Error('modelId is required');
      err.statusCode = 400;
      throw err;
    }

    // Prevent prototype pollution — validate modelId format
    if (!/^[a-zA-Z0-9_\-\/:\.]+$/.test(body.modelId)) {
      const err = new Error('Invalid modelId format — only alphanumeric, dash, underscore, slash, colon, dot allowed');
      err.statusCode = 400;
      throw err;
    }

    const config = await loadConfig();

    config.models[body.modelId] = {
      provider: body.provider || 'openrouter',
      inputCostPer1M: parseFloat(body.inputCostPer1M) || 0,
      outputCostPer1M: parseFloat(body.outputCostPer1M) || 0,
      contextWindow: parseInt(body.contextWindow, 10) || 128000,
      maxOutput: parseInt(body.maxOutput, 10) || 4096,
    };

    const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'system';

    // Persist model to DB (survives Railway deploys)
    try {
      await query(
        `INSERT INTO agent_graph.model_config_overrides (model_key, config, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (model_key) DO UPDATE SET config = $2, added_by = $3, added_at = now()`,
        [body.modelId, JSON.stringify(config.models[body.modelId]), boardUser]
      );
    } catch { /* DB unavailable */ }

    saveConfig(config, { boardUser, modelKey: body.modelId, changes: { action: 'add', ...config.models[body.modelId] } });
    return { ok: true, model: config.models[body.modelId] };
  });

  // POST /api/agents/:id/toggle — convenience endpoint to flip enabled state
  // Matches URL pattern: POST /api/agents/toggle?agentId=<id>
  routes.set('POST /api/agents/toggle', async (req, body) => {
    requireBoard(req);
    const url = new URL(req.url, 'http://localhost');
    const agentId = body?.agentId || url.searchParams.get('agentId');
    if (!agentId) {
      const err = new Error('agentId is required');
      err.statusCode = 400;
      throw err;
    }

    const config = await loadConfig();
    const agent = config.agents[agentId];
    if (!agent) {
      const err = new Error(`Unknown agent: ${agentId}`);
      err.statusCode = 404;
      throw err;
    }

    const newEnabled = body?.enabled !== undefined ? Boolean(body.enabled) : !agent.enabled;
    agent.enabled = newEnabled;
    saveConfig(config, { boardUser: req.headers?.['x-board-user'] || 'system', agentId, changes: { enabled: newEnabled } });

    // Publish event for SSE listeners
    try {
      const { publishEvent } = await import('../runtime/infrastructure.js');
      await publishEvent('agent_toggled', `Agent ${agentId} ${newEnabled ? 'enabled' : 'disabled'}`, agentId, null, { agentId, enabled: newEnabled });
    } catch { /* non-fatal */ }

    return { ok: true, agentId, enabled: newEnabled };
  });

  // GET /api/agents/status — runtime heartbeat status for all agents
  // Enhanced: includes enabled state, tier, model, current task
  routes.set('GET /api/agents/status', async () => {
    const config = await loadConfig();
    const statuses = {};

    // Initialize all configured agents (so disabled ones show up too)
    for (const [id, agent] of Object.entries(config.agents)) {
      statuses[id] = {
        online: false,
        enabled: agent.enabled !== false,
        status: 'offline',
        tier: agent.tier || null,
        subTier: agent.subTier || null,
        model: agent.model || null,
        lastSeen: null,
        lastTaskAt: null,
        currentTask: null,
        pid: null,
      };
    }

    try {
      const { query } = await import('../db.js');

      // Heartbeat data
      const result = await query(`
        SELECT h.agent_id, h.heartbeat_at, h.status, h.pid,
               (SELECT MAX(st.created_at) FROM agent_graph.state_transitions st
                WHERE st.agent_id = h.agent_id AND st.created_at > now() - interval '2 minutes') AS last_task_at
        FROM agent_graph.agent_heartbeats h
      `);
      const now = new Date();
      for (const row of result.rows) {
        if (!statuses[row.agent_id]) continue;
        const ageMs = now - new Date(row.heartbeat_at);
        const recentlyActive = row.last_task_at && (now - new Date(row.last_task_at)) < 120_000;
        const isExternal = config.agents[row.agent_id]?.type === 'external';
        const onlineThresholdMs = isExternal ? 60_000 : 30_000;
        Object.assign(statuses[row.agent_id], {
          online: ageMs < onlineThresholdMs && row.status !== 'stopped',
          status: recentlyActive ? 'processing' : row.status,
          lastSeen: row.heartbeat_at,
          lastTaskAt: row.last_task_at || null,
          pid: row.pid,
        });
      }

      // Current tasks (in_progress work items per agent)
      const tasks = await query(`
        SELECT assigned_to, id, title, type
        FROM agent_graph.work_items
        WHERE status = 'in_progress'
        ORDER BY created_at DESC
      `);
      for (const task of tasks.rows) {
        if (statuses[task.assigned_to] && !statuses[task.assigned_to].currentTask) {
          statuses[task.assigned_to].currentTask = {
            id: task.id,
            title: task.title,
            type: task.type,
          };
        }
      }
    } catch (e) {
      console.warn('[api] Agent status query failed:', e.message);
    }
    return { statuses };
  });

  // GET /api/agents/skills — full tool/skill/capability registry
  routes.set('GET /api/agents/skills', async () => {
    const config = await loadConfig();

    // Chat tools (from agent-chat.js CHAT_TOOLS)
    const chatTools = [
      { name: 'create_campaign', category: 'chat', description: 'Create and auto-approve a campaign' },
      { name: 'check_pipeline', category: 'chat', description: 'Live budget, task counts, active agents' },
      { name: 'list_campaigns', category: 'chat', description: 'Recent campaigns with status/scores' },
      { name: 'list_drafts', category: 'chat', description: 'Pending proposals awaiting review' },
      { name: 'approve_proposal', category: 'chat', description: 'Approve a draft/proposal' },
      { name: 'search_knowledge_base', category: 'chat', description: 'Search RAG knowledge base (1258 docs, 10K+ chunks)' },
    ];

    // Operational tools (from agents.json)
    const operationalTools = new Set();
    const capabilities = new Set();
    for (const agent of Object.values(config.agents)) {
      for (const t of agent.tools || []) operationalTools.add(t);
      for (const c of agent.capabilities || []) capabilities.add(c);
    }

    // Per-agent tool/capability mapping
    const agentTools = {};
    for (const [id, agent] of Object.entries(config.agents)) {
      agentTools[id] = {
        tools: agent.tools || [],
        capabilities: agent.capabilities || [],
        chatEnabled: !!agent.chat?.enabled,
        chatTools: agent.chat?.enabled ? chatTools.map(t => t.name) : [],
      };
    }

    return {
      chatTools,
      operationalTools: [...operationalTools].sort(),
      capabilities: [...capabilities].sort(),
      agentTools,
    };
  });

  // GET /api/agents/detail — full agent detail (config + model + prompt)
  routes.set('GET /api/agents/detail', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agentId');
    if (!agentId) {
      const err = new Error('agentId query param is required');
      err.statusCode = 400;
      throw err;
    }

    const config = await loadConfig();
    const agent = config.agents[agentId];
    if (!agent) {
      const err = new Error(`Unknown agent: ${agentId}`);
      err.statusCode = 404;
      throw err;
    }

    const modelConfig = config.models[agent.model] || null;

    // Load prompt from agent-prompts.json
    let promptInfo = null;
    try {
      const promptsPath = join(__dirname, '..', '..', 'config', 'agent-prompts.json');
      const prompts = JSON.parse(readFileSync(promptsPath, 'utf-8'));
      promptInfo = prompts[agentId] || null;
    } catch { /* prompts file missing is ok */ }

    return {
      agent,
      model: modelConfig,
      prompt: promptInfo,
    };
  });

  // GET /api/agents/activity — recent task stats for an agent (7-day window)
  routes.set('GET /api/agents/activity', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agentId');
    if (!agentId) {
      const err = new Error('agentId query param is required');
      err.statusCode = 400;
      throw err;
    }

    // Try DB query, fall back to empty stats if DB unavailable
    let stats = { totalTasks: 0, completed: 0, failed: 0, avgCostUsd: 0, totalCostUsd: 0, lastActive: null };
    let recentTasks = [];

    try {
      const { query } = await import('../db.js');

      const statsResult = await query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE w.status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE w.status = 'cancelled') AS failed,
          COALESCE(SUM(li.cost_usd), 0) AS total_cost,
          COALESCE(AVG(li.cost_usd), 0) AS avg_cost,
          MAX(w.updated_at) AS last_active
        FROM agent_graph.work_items w
        LEFT JOIN agent_graph.llm_invocations li ON li.agent_id = $1 AND li.created_at > NOW() - INTERVAL '7 days'
        WHERE w.assigned_to = $1
          AND w.created_at > NOW() - INTERVAL '7 days'
      `, [agentId]);

      if (statsResult.rows[0]) {
        const r = statsResult.rows[0];
        stats = {
          totalTasks: parseInt(r.total, 10),
          completed: parseInt(r.completed, 10),
          failed: parseInt(r.failed, 10),
          avgCostUsd: parseFloat(r.avg_cost) || 0,
          totalCostUsd: parseFloat(r.total_cost) || 0,
          lastActive: r.last_active,
        };
      }

      const tasksResult = await query(`
        SELECT id, title, status, created_at, updated_at
        FROM agent_graph.work_items
        WHERE assigned_to = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [agentId]);
      recentTasks = tasksResult.rows;
    } catch (e) {
      // DB not available — return empty stats
      console.warn('[api] Agent activity query failed:', e.message);
    }

    return { stats, recentTasks };
  });

  // GET /api/agents/changelog — config change history (JSONL-backed)
  routes.set('GET /api/agents/changelog', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agentId'); // optional filter
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    let entries = [];
    try {
      if (existsSync(CHANGELOG_PATH)) {
        const lines = readFileSync(CHANGELOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
        entries = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
      }
    } catch { /* file missing is ok */ }

    // Filter by agentId if provided
    if (agentId) {
      entries = entries.filter(e => e.agentId === agentId);
    }

    // Return most recent first, limited
    return { entries: entries.reverse().slice(0, limit) };
  });

  // ============================================================
  // Agent Chat routes (Messenger-style per-agent chat)
  // ============================================================

  // POST /api/chat/session — create a new chat session (Linus #2: server-side UUID)
  routes.set('POST /api/chat/session', async (req, body) => {
    const { agentId } = body || {};
    if (!agentId) {
      const err = new Error('agentId is required');
      err.statusCode = 400;
      throw err;
    }
    const boardUser = req.headers['x-board-user'] || 'unknown';
    try {
      return await createChatSession(agentId, boardUser);
    } catch (e) {
      const err = new Error(e.message);
      err.statusCode = 400;
      throw err;
    }
  });

  // POST /api/chat/auto — auto-route a message to the best agent
  // No agent selection required. Returns { text, agentId, costUsd, model, sessionId }
  // Session is persistent across messages — frontend passes sessionId back.
  // Phase 3: creates board_chat_sessions record on new sessions, updates updated_at on every message.
  routes.set('POST /api/chat/auto', async (req, body) => {
    const { message, sessionId: existingSessionId, mode, pageContext } = body || {};
    if (!message) {
      const err = new Error('message is required');
      err.statusCode = 400;
      throw err;
    }
    const boardUser = req.headers['x-board-user'] || 'unknown';

    // Auto-route to best agent
    const agentId = autoRouteMessage(message);

    const { query: dbQuery } = await import('../db.js');
    let sessionId = existingSessionId;
    let isNewSession = false;

    if (!sessionId) {
      // Create new session record in board_chat_sessions
      const { randomUUID } = await import('crypto');
      sessionId = randomUUID();
      isNewSession = true;

      // Resolve project context: if on a project page, link session to project
      let projectId = null;
      if (pageContext?.entityId && pageContext?.route?.includes('/projects/')) {
        try {
          const projResult = await dbQuery(
            `SELECT id FROM agent_graph.projects WHERE slug = $1`,
            [pageContext.entityId]
          );
          if (projResult.rows[0]) projectId = projResult.rows[0].id;
        } catch { /* non-critical — fall back to global session */ }
      }

      try {
        await dbQuery(
          `INSERT INTO agent_graph.board_chat_sessions (id, board_user, agent_id, project_id) VALUES ($1, $2, $3, $4)`,
          [sessionId, boardUser, 'orchestrator', projectId]
        );
        // Also create project membership for cross-referencing
        if (projectId) {
          await dbQuery(
            `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
             VALUES ($1, 'chat_session', $2, $3)
             ON CONFLICT DO NOTHING`,
            [projectId, sessionId, boardUser]
          );
        }
      } catch (e) {
        console.warn('[api] Failed to create chat session record:', e.message);
      }
    } else {
      // Update existing session's updated_at timestamp
      try {
        await dbQuery(
          `UPDATE agent_graph.board_chat_sessions SET updated_at = now() WHERE id = $1`,
          [sessionId]
        );
      } catch { /* non-fatal */ }
    }

    // Use orchestrator as the chat-enabled agent for the LLM call,
    // but route context/persona based on the auto-selected agent
    const chatAgentId = 'orchestrator'; // always chat-enabled
    const result = await handleAgentChat(chatAgentId, message, { boardUser, sessionId, mode: mode || 'plan', pageContext });

    // Auto-generate title after first assistant response in a new session
    if (isNewSession) {
      try {
        const SKIP_WORDS = new Set(['what', 'how', 'can', 'the', 'a', 'an', 'is', 'are', 'do', 'does', 'i', 'you', 'me', 'my', 'we', 'our', 'it', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'but', 'with', 'about', 'please', 'hey', 'hi', 'hello']);
        const words = message.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 0);
        const meaningful = words.filter(w => !SKIP_WORDS.has(w.toLowerCase()));
        const titleWords = (meaningful.length >= 3 ? meaningful : words).slice(0, 5);
        const title = titleWords.join(' ').slice(0, 60) || 'New conversation';
        await dbQuery(
          `UPDATE agent_graph.board_chat_sessions SET title = $1 WHERE id = $2`,
          [title, sessionId]
        );
      } catch { /* non-fatal */ }
    }

    return { ...result, agentId: chatAgentId, sessionId };
  });

  // POST /api/chat/message — send a message to an agent
  routes.set('POST /api/chat/message', async (req, body) => {
    const { sessionId, agentId, message } = body || {};
    if (!sessionId || !agentId || !message) {
      const err = new Error('sessionId, agentId, and message are required');
      err.statusCode = 400;
      throw err;
    }
    const boardUser = req.headers['x-board-user'] || 'unknown';
    try {
      return handleAgentChat(agentId, message, { boardUser, sessionId });
    } catch (e) {
      const err = new Error(e.message);
      err.statusCode = e.statusCode || 500;
      throw err;
    }
  });

  // GET /api/chat/history — get chat history for a session
  routes.set('GET /api/chat/history', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      const err = new Error('sessionId query param is required');
      err.statusCode = 400;
      throw err;
    }
    return getChatHistory(sessionId);
  });

  // GET /api/chat/sessions — list board chat sessions (Phase 3: session management)
  // If agentId param provided, uses legacy per-agent listing.
  // Without agentId, returns sessions from board_chat_sessions table for the current user.
  routes.set('GET /api/chat/sessions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agentId');
    const limit = parseInt(url.searchParams.get('limit') || '30', 10);

    // Legacy path: per-agent session listing
    if (agentId) {
      return listChatSessions(agentId, Math.min(limit, 50));
    }

    // Phase 3: board-wide session listing from board_chat_sessions
    const boardUser = req.headers['x-board-user'] || 'unknown';
    const projectSlug = url.searchParams.get('projectSlug');
    const { query: dbQuery } = await import('../db.js');

    // Resolve project slug to ID if filtering by project
    let projectFilter = null;
    if (projectSlug) {
      try {
        const projResult = await dbQuery(
          `SELECT id FROM agent_graph.projects WHERE slug = $1`,
          [projectSlug]
        );
        if (projResult.rows[0]) projectFilter = projResult.rows[0].id;
      } catch { /* fall through to unfiltered */ }
    }

    const params = [boardUser, Math.min(limit, 50)];
    let whereClause = '(s.board_user = $1 OR s.is_shared = true)';
    if (projectFilter) {
      params.push(projectFilter);
      whereClause += ` AND s.project_id = $${params.length}`;
    }

    const result = await dbQuery(
      `SELECT
         s.id,
         s.board_user,
         s.title,
         s.agent_id,
         s.is_shared,
         s.pinned,
         s.project_id,
         s.created_at,
         s.updated_at,
         COALESCE(mc.message_count, 0) AS message_count,
         mc.last_preview,
         p.name AS project_name
       FROM agent_graph.board_chat_sessions s
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS message_count,
                (SELECT content FROM agent_graph.board_chat_messages
                 WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_preview
         FROM agent_graph.board_chat_messages WHERE session_id = s.id
       ) mc ON true
       LEFT JOIN agent_graph.projects p ON p.id = s.project_id
       WHERE ${whereClause}
       ORDER BY s.pinned DESC, s.updated_at DESC
       LIMIT $2`,
      params
    );
    return {
      sessions: result.rows.map(r => ({
        id: r.id,
        boardUser: r.board_user,
        title: r.title,
        agentId: r.agent_id,
        isShared: r.is_shared,
        pinned: r.pinned,
        projectId: r.project_id || null,
        projectName: r.project_name || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: parseInt(r.message_count),
        lastPreview: r.last_preview ? r.last_preview.slice(0, 100) : null,
      })),
    };
  });

  // POST /api/chat/sessions — create a new board chat session
  routes.set('POST /api/chat/sessions', async (req, body) => {
    const boardUser = req.headers['x-board-user'] || 'unknown';
    const title = body?.title || null;
    const agentId = body?.agentId || 'orchestrator';
    const { query: dbQuery } = await import('../db.js');
    const result = await dbQuery(
      `INSERT INTO agent_graph.board_chat_sessions (board_user, title, agent_id)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [boardUser, title, agentId]
    );
    const row = result.rows[0];
    return { sessionId: row.id, title, createdAt: row.created_at };
  });

  // PATCH /api/chat/sessions/:id — update session (rename, pin, share)
  routes.set('PATCH /api/chat/sessions', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('id') || body?.id;
    if (!sessionId) {
      const err = new Error('session id is required');
      err.statusCode = 400;
      throw err;
    }
    const { query: dbQuery } = await import('../db.js');
    const sets = [];
    const params = [sessionId];
    let idx = 2;
    if (body?.title !== undefined) { sets.push(`title = $${idx++}`); params.push(body.title); }
    if (body?.pinned !== undefined) { sets.push(`pinned = $${idx++}`); params.push(body.pinned); }
    if (body?.is_shared !== undefined) { sets.push(`is_shared = $${idx++}`); params.push(body.is_shared); }
    if (sets.length === 0) {
      const err = new Error('No fields to update');
      err.statusCode = 400;
      throw err;
    }
    sets.push('updated_at = now()');
    const result = await dbQuery(
      `UPDATE agent_graph.board_chat_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      const err = new Error('Session not found');
      err.statusCode = 404;
      throw err;
    }
    return { session: result.rows[0] };
  });

  // DELETE /api/chat/sessions — delete a session and its messages
  routes.set('DELETE /api/chat/sessions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('id');
    if (!sessionId) {
      const err = new Error('session id is required');
      err.statusCode = 400;
      throw err;
    }
    const { query: dbQuery } = await import('../db.js');
    await dbQuery(`DELETE FROM agent_graph.board_chat_messages WHERE session_id = $1`, [sessionId]);
    await dbQuery(`DELETE FROM agent_graph.board_chat_sessions WHERE id = $1`, [sessionId]);
    return { ok: true };
  });

  // POST /api/chat/sessions/title — auto-generate title from first user message
  routes.set('POST /api/chat/sessions/title', async (_req, body) => {
    const sessionId = body?.sessionId;
    if (!sessionId) {
      const err = new Error('sessionId is required');
      err.statusCode = 400;
      throw err;
    }
    const { query: dbQuery } = await import('../db.js');
    const msgResult = await dbQuery(
      `SELECT content FROM agent_graph.board_chat_messages WHERE session_id = $1 AND role = 'user' ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );
    if (msgResult.rows.length === 0) return { title: null };
    const firstMsg = msgResult.rows[0].content;

    // Generate title: take first 5 meaningful words, skip filler
    const SKIP_WORDS = new Set(['what', 'how', 'can', 'the', 'a', 'an', 'is', 'are', 'do', 'does', 'i', 'you', 'me', 'my', 'we', 'our', 'it', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'but', 'with', 'about', 'please', 'hey', 'hi', 'hello']);
    const words = firstMsg.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 0);
    const meaningful = words.filter(w => !SKIP_WORDS.has(w.toLowerCase()));
    const titleWords = (meaningful.length >= 3 ? meaningful : words).slice(0, 5);
    const title = titleWords.join(' ').slice(0, 60) || 'New conversation';

    await dbQuery(
      `UPDATE agent_graph.board_chat_sessions SET title = $1, updated_at = now() WHERE id = $2`,
      [title, sessionId]
    );
    return { title };
  });

  // POST /api/workstation/llm — LLM proxy for the Board Workstation dashboard
  // Uses provider.js abstraction so dashboard gets Anthropic + OpenRouter support
  // without needing provider SDKs or API keys client-side.
  routes.set('POST /api/workstation/llm', async (_req, body) => {
    const { model, system, messages, maxTokens, temperature } = body || {};
    if (!model || !messages) {
      const err = new Error('model and messages are required');
      err.statusCode = 400;
      throw err;
    }

    const config = await loadConfig();
    if (!config.models[model]) {
      const err = new Error(`Unknown model: ${model}. Add it to agents.json models config first.`);
      err.statusCode = 400;
      throw err;
    }

    // Spend cap: enforce per-hour budget (mirrors agent-chat maxCostPerSession)
    const WORKSTATION_HOURLY_CAP_USD = parseFloat(process.env.WORKSTATION_HOURLY_CAP || '2.00');
    try {
      const hourlySpend = await getWorkstationHourlySpend();
      if (hourlySpend >= WORKSTATION_HOURLY_CAP_USD) {
        const err = new Error(`Workstation hourly spend cap reached ($${hourlySpend.toFixed(2)}/$${WORKSTATION_HOURLY_CAP_USD.toFixed(2)}). Try again later.`);
        err.statusCode = 429;
        throw err;
      }
    } catch (e) {
      if (e.statusCode === 429) throw e;
      // If spend tracking fails, allow the request (fail-open for now)
      console.warn('[api] Workstation spend tracking unavailable:', e.message);
    }

    const llm = createLLMClient(model, config.models);
    const result = await callProvider(llm, {
      system: system || '',
      messages,
      maxTokens: Math.min(maxTokens || 4096, config.workstation?.maxTokens || 4096),
      temperature: temperature ?? 0.3,
    });

    const costUsd = computeCost(result.inputTokens, result.outputTokens, config.models[model]);
    recordWorkstationSpend(+costUsd.toFixed(6));

    return {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: +costUsd.toFixed(6),
      model,
      stopReason: result.stopReason,
    };
  });

  // POST /api/models/remove — Remove a model from agents.json (only if no agent uses it)
  routes.set('POST /api/models/remove', async (_req, body) => {
    if (!body.modelId) {
      const err = new Error('modelId is required');
      err.statusCode = 400;
      throw err;
    }

    if (!/^[a-zA-Z0-9_\-\/:\.]+$/.test(body.modelId)) {
      const err = new Error('Invalid modelId format');
      err.statusCode = 400;
      throw err;
    }

    const config = await loadConfig();

    // Check no agent is using this model
    const usedBy = Object.values(config.agents).filter(a => a.model === body.modelId);
    if (usedBy.length > 0) {
      const ids = usedBy.map(a => a.id).join(', ');
      const err = new Error(`Cannot remove: model in use by ${ids}`);
      err.statusCode = 400;
      throw err;
    }

    if (!config.models[body.modelId]) {
      const err = new Error(`Model not found: ${body.modelId}`);
      err.statusCode = 404;
      throw err;
    }

    delete config.models[body.modelId];
    saveConfig(config);
    return { ok: true };
  });
}

#!/usr/bin/env node
/**
 * NemoClaw MCP Server — Optimus Board API tools for Claude Code.
 *
 * Replaces the Colima/OpenShell/OpenClaw sandbox stack with a lightweight
 * MCP server that board members add to their Claude Code config. The Board
 * API Gateway (JWT auth, rate limiting, scope enforcement) IS the security
 * boundary. No sandbox needed.
 *
 * Env vars:
 *   OPTIMUS_TOKEN    — Board member JWT (issued via issue-token.js)
 *   OPTIMUS_API_URL  — Board API base URL (default: https://preview.staqs.io)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOKEN = process.env.OPTIMUS_TOKEN;
const API_URL = process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

if (!TOKEN) {
  console.error('OPTIMUS_TOKEN env var required. Run: node issue-token.js <github-username>');
  process.exit(1);
}

// ============================================================
// HTTP client (thin wrapper over Board API)
// ============================================================

async function api(method, path, body = null) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

// ============================================================
// MCP Server
// ============================================================

const server = new McpServer({
  name: 'nemoclaw',
  version: '1.0.0',
});

// --- Pipeline Health ---

server.tool(
  'optimus_health',
  'Check Optimus pipeline health: queue stats, stuck tasks, agent status',
  {},
  async () => {
    const [health, agents] = await Promise.all([
      api('GET', '/api/pipeline/health'),
      api('GET', '/api/agents/status'),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ health, agents }, null, 2) }] };
  }
);

// --- Inbox ---

server.tool(
  'optimus_inbox',
  'List recent emails in the Optimus inbox with triage results',
  {
    limit: z.number().optional().describe('Max emails to return (default 20)'),
    status: z.string().optional().describe('Filter by status: pending, triaged, archived'),
  },
  async ({ limit = 20, status }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    const data = await api('GET', `/api/runs?${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Drafts / Proposals ---

server.tool(
  'optimus_drafts',
  'List draft replies and action proposals awaiting board review',
  {
    status: z.string().optional().describe('Filter: pending, approved, rejected, sent'),
  },
  async ({ status }) => {
    const params = status ? `?status=${status}` : '';
    const data = await api('GET', `/api/drafts${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_approve_draft',
  'Approve a draft reply or action proposal',
  {
    id: z.string().describe('Draft/proposal UUID to approve'),
  },
  async ({ id }) => {
    const data = await api('POST', '/api/drafts/approve', { id });
    return { content: [{ type: 'text', text: `Approved: ${id}\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_reject_draft',
  'Reject a draft reply with feedback for the agent to try again',
  {
    id: z.string().describe('Draft/proposal UUID to reject'),
    feedback: z.string().describe('Why this draft was rejected — agents will use this to improve'),
  },
  async ({ id, feedback }) => {
    const data = await api('POST', '/api/drafts/reject', { id, feedback });
    return { content: [{ type: 'text', text: `Rejected: ${id}\n${JSON.stringify(data)}` }] };
  }
);

// --- Signals ---

server.tool(
  'optimus_signals',
  'List extracted signals (priorities, deadlines, commitments, opportunities)',
  {
    limit: z.number().optional().describe('Max signals to return (default 20)'),
  },
  async ({ limit = 20 }) => {
    const data = await api('GET', `/api/signals?limit=${limit}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Campaigns ---

server.tool(
  'optimus_campaigns',
  'List campaigns with status, scores, and iteration counts',
  {
    status: z.string().optional().describe('Filter: pending_approval, approved, running, completed, failed'),
  },
  async ({ status }) => {
    const params = status ? `?status=${status}` : '';
    const data = await api('GET', `/api/campaigns${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_campaign_detail',
  'Get detailed campaign info including iterations, output, and PR link',
  {
    id: z.string().describe('Campaign UUID'),
  },
  async ({ id }) => {
    const data = await api('GET', `/api/campaigns/${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_create_campaign',
  'Submit a new campaign for the agent organization to execute',
  {
    goal: z.string().describe('What should be built or done — be specific'),
    budget_usd: z.number().optional().describe('Budget envelope in USD (default $10)'),
    max_iterations: z.number().optional().describe('Max improvement iterations (default 20)'),
    success_criteria: z.string().optional().describe('What "done" looks like'),
    files: z.array(z.object({
      name: z.string(),
      content: z.string(),
    })).optional().describe('Context files to include with the campaign'),
  },
  async ({ goal, budget_usd, max_iterations, success_criteria, files }) => {
    const body = {
      goal_description: goal,
      budget_envelope_usd: budget_usd || 10,
      max_iterations: max_iterations || 20,
    };
    if (success_criteria) {
      body.success_criteria = [{ metric: 'quality_score', operator: '>=', threshold: 0.85, description: success_criteria }];
    }
    if (files?.length) {
      body.metadata = { uploaded_files: files };
    }
    const data = await api('POST', '/api/campaigns', body);
    return { content: [{ type: 'text', text: `Campaign created: ${data.campaign_id || JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_approve_campaign',
  'Approve a pending campaign to start execution',
  {
    id: z.string().describe('Campaign UUID to approve'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/campaigns/${id}/approve`);
    return { content: [{ type: 'text', text: `Campaign ${id} approved.\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_pause_campaign',
  'Pause a running campaign',
  {
    id: z.string().describe('Campaign UUID to pause'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/campaigns/${id}/pause`);
    return { content: [{ type: 'text', text: `Campaign ${id} paused.\n${JSON.stringify(data)}` }] };
  }
);

// --- Build (Orchestrator Tasks) ---

server.tool(
  'optimus_build',
  'Submit a task directly to the orchestrator pipeline (for quick operations)',
  {
    prompt: z.string().describe('What to do — routes to the best agent automatically'),
  },
  async ({ prompt }) => {
    const data = await api('POST', '/api/board/build', { prompt });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_build_status',
  'Check the status of an orchestrator build task',
  {
    id: z.string().describe('Work item UUID'),
  },
  async ({ id }) => {
    const data = await api('GET', `/api/board/build?id=${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Intents ---

server.tool(
  'optimus_intents',
  'List pending intents (proposed agent actions awaiting board approval)',
  {},
  async () => {
    const data = await api('GET', '/api/intents');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_approve_intent',
  'Approve a pending intent',
  {
    id: z.string().describe('Intent UUID'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/intents/${id}/approve`);
    return { content: [{ type: 'text', text: `Intent ${id} approved.\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_reject_intent',
  'Reject a pending intent with feedback',
  {
    id: z.string().describe('Intent UUID'),
    feedback: z.string().describe('Reason for rejection'),
  },
  async ({ id, feedback }) => {
    const data = await api('POST', `/api/intents/${id}/reject`, { feedback });
    return { content: [{ type: 'text', text: `Intent ${id} rejected.\n${JSON.stringify(data)}` }] };
  }
);

// --- Knowledge Base ---

server.tool(
  'optimus_search_kb',
  'Search the Optimus knowledge base (RAG) for relevant information',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (default 5)'),
  },
  async ({ query: q, limit = 5 }) => {
    const data = await api('POST', '/api/search', { query: q, limit });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Today Summary ---

server.tool(
  'optimus_today',
  'Get today\'s summary: emails, drafts pending, signals, active campaigns, cost',
  {},
  async () => {
    const [drafts, signals, campaigns, health] = await Promise.all([
      api('GET', '/api/drafts?status=pending').catch(() => ({ rows: [] })),
      api('GET', '/api/signals?limit=10').catch(() => ({ rows: [] })),
      api('GET', '/api/campaigns?status=running').catch(() => ({ rows: [] })),
      api('GET', '/api/pipeline/health').catch(() => ({})),
    ]);
    const summary = {
      pending_drafts: drafts.rows?.length ?? drafts.length ?? 0,
      recent_signals: signals.rows?.length ?? signals.length ?? 0,
      active_campaigns: campaigns.rows?.length ?? campaigns.length ?? 0,
      pipeline: health,
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

// --- Wiki Compilation ---

server.tool(
  'optimus_wiki_compile',
  'Trigger wiki compilation for a project — clusters pending vault docs and LLM-compiles them into structured wiki articles',
  { slug: z.string().describe('Project slug'), maxArticles: z.number().optional().describe('Max articles to compile (default 20)') },
  async ({ slug, maxArticles }) => {
    const result = await api('POST', '/api/projects/compile', { slug, maxArticles });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_list',
  'List compiled wiki articles for a project',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_health',
  'Get wiki health report (lint) for a project — checks links, orphans, staleness, thin content, contradictions',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki/health?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_status',
  'Get compilation status — how many docs are pending, compiled, or are wiki articles',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki/status?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_lint',
  'Run wiki lint and store the health report in project memory',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('POST', '/api/projects/wiki/lint', { slug });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ============================================================
// Start
// ============================================================

const transport = new StdioServerTransport();
await server.connect(transport);

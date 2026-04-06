/**
 * Agent Memory System (Claude Code Architecture Audit — Change 5).
 *
 * DB-backed persistent memory with Markdown export view.
 * Agents accumulate learnings across sessions — patterns, preferences,
 * context, and failures — that compound over time.
 *
 * Inspired by Claude Code's memdir system with typed memory files
 * (user/feedback/project/reference) and autoDream consolidation.
 *
 * Design decision (confirmed): DB-backed with Markdown export.
 * Postgres table (append-only, hash-chained) for P3 compliance.
 * Board Workstation renders as readable Markdown via API endpoint.
 *
 * Memory types:
 *   pattern    — "When X happens, do Y" (operational learning)
 *   preference — Account/user preferences learned from interactions
 *   context    — Background facts about the environment
 *   failure    — What went wrong and why (prevents repeat mistakes)
 */

import { createHash } from 'crypto';
import { query } from '../db.js';

const VALID_TYPES = ['pattern', 'preference', 'context', 'failure'];
const MAX_MEMORIES_PER_AGENT = 100;  // Prevent unbounded growth
const MAX_MEMORY_CONTENT_LENGTH = 2000;  // ~500 tokens per memory

/**
 * Save a memory for an agent.
 * Append-only: previous memories are never deleted, only superseded.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - Agent saving the memory
 * @param {string} opts.type - 'pattern' | 'preference' | 'context' | 'failure'
 * @param {string} opts.content - Memory content (will be truncated to MAX_MEMORY_CONTENT_LENGTH)
 * @param {string} [opts.workItemId] - Work item that triggered this memory
 * @param {Object} [opts.metadata] - Additional structured data
 * @returns {Promise<{id: string, hash: string} | null>}
 */
export async function saveMemory({ agentId, type, content, workItemId = null, metadata = {} }) {
  if (!VALID_TYPES.includes(type)) {
    console.warn(`[agent-memory] Invalid memory type '${type}' — must be one of: ${VALID_TYPES.join(', ')}`);
    return null;
  }

  const truncated = content.slice(0, MAX_MEMORY_CONTENT_LENGTH);
  const contentHash = createHash('sha256').update(`${agentId}:${type}:${truncated}`).digest('hex').slice(0, 16);

  try {
    // Dedup: don't save identical memories
    const existing = await query(
      `SELECT id FROM agent_graph.agent_memories
       WHERE agent_id = $1 AND content_hash = $2 AND superseded_by IS NULL`,
      [agentId, contentHash]
    );
    if (existing.rows[0]) {
      return { id: existing.rows[0].id, hash: contentHash, deduplicated: true };
    }

    const result = await query(
      `INSERT INTO agent_graph.agent_memories (agent_id, memory_type, content, content_hash, work_item_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [agentId, type, truncated, contentHash, workItemId, JSON.stringify(metadata)]
    );

    return { id: result.rows[0].id, hash: contentHash };
  } catch (err) {
    console.warn(`[agent-memory] Save failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Load active memories for an agent (not superseded).
 * Returns newest first, capped at MAX_MEMORIES_PER_AGENT.
 *
 * @param {string} agentId
 * @param {Object} [opts]
 * @param {string} [opts.type] - Filter by memory type
 * @param {number} [opts.limit] - Override default limit
 * @returns {Promise<Array<{id, type, content, created_at, metadata}>>}
 */
export async function loadMemory(agentId, opts = {}) {
  const limit = opts.limit || MAX_MEMORIES_PER_AGENT;

  try {
    const typeFilter = opts.type ? `AND memory_type = $2` : '';
    const params = opts.type ? [agentId, opts.type, limit] : [agentId, limit];
    const limitParam = opts.type ? '$3' : '$2';

    const result = await query(
      `SELECT id, memory_type, content, created_at, metadata
       FROM agent_graph.agent_memories
       WHERE agent_id = $1 AND superseded_by IS NULL
       ${typeFilter}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      params
    );

    return result.rows;
  } catch {
    // Table may not exist yet — graceful degradation
    return [];
  }
}

/**
 * Consolidate memories: merge similar memories into summaries.
 * Inspired by Claude Code's autoDream — runs during idle time.
 * Supersedes older memories with a consolidated version.
 *
 * @param {string} agentId
 * @param {Object} agent - AgentLoop instance (for callLLM with budget tracking)
 * @returns {Promise<{consolidated: number, remaining: number}>}
 */
export async function consolidateMemory(agentId, agent) {
  const memories = await loadMemory(agentId, { limit: 200 });
  if (memories.length < 10) {
    return { consolidated: 0, remaining: memories.length };
  }

  // Group by type
  const byType = {};
  for (const mem of memories) {
    const type = mem.memory_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(mem);
  }

  let totalConsolidated = 0;

  for (const [type, mems] of Object.entries(byType)) {
    if (mems.length < 5) continue; // Only consolidate when there's enough

    // Take the oldest N-2 and consolidate them
    const toConsolidate = mems.slice(2); // Keep 2 most recent verbatim
    if (toConsolidate.length < 3) continue;

    try {
      const response = await agent.callLLM(
        `You consolidate agent memories. Merge these ${type} memories into 2-3 concise, actionable memories. Remove contradictions. Convert vague observations into specific rules. Output each memory on a new line, prefixed with "- ".`,
        toConsolidate.map(m => `- ${m.content}`).join('\n'),
        {
          taskId: `consolidate-${agentId}-${type}`,
          maxTokens: 500,
          temperature: 0.1,
        }
      );

      // Parse consolidated memories
      const consolidated = response.text
        .split('\n')
        .map(line => line.replace(/^-\s*/, '').trim())
        .filter(line => line.length > 10);

      // Save consolidated memories
      for (const content of consolidated) {
        await saveMemory({ agentId, type, content, metadata: { consolidated: true, sources: toConsolidate.length } });
      }

      // Mark old memories as superseded
      const oldIds = toConsolidate.map(m => m.id);
      await query(
        `UPDATE agent_graph.agent_memories
         SET superseded_by = 'consolidated'
         WHERE id = ANY($1)`,
        [oldIds]
      );

      totalConsolidated += toConsolidate.length;
    } catch (err) {
      console.warn(`[agent-memory] Consolidation failed for ${type} (non-fatal): ${err.message}`);
    }
  }

  const remaining = await loadMemory(agentId);
  return { consolidated: totalConsolidated, remaining: remaining.length };
}

/**
 * Export memories as Markdown (for Board Workstation display).
 *
 * @param {string} agentId
 * @returns {Promise<string>} Markdown-formatted memory document
 */
export async function exportMemoryAsMarkdown(agentId) {
  const memories = await loadMemory(agentId);
  if (memories.length === 0) return `# Agent Memory: ${agentId}\n\nNo memories recorded yet.`;

  const byType = {};
  for (const mem of memories) {
    const type = mem.memory_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(mem);
  }

  const sections = [];
  sections.push(`# Agent Memory: ${agentId}`);
  sections.push(`\n*${memories.length} active memories*\n`);

  for (const type of VALID_TYPES) {
    const mems = byType[type];
    if (!mems || mems.length === 0) continue;

    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1) + 's';
    sections.push(`## ${typeLabel}\n`);
    for (const mem of mems) {
      const date = new Date(mem.created_at).toISOString().split('T')[0];
      sections.push(`- **[${date}]** ${mem.content}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

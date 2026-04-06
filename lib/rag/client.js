/**
 * RAG client — unified knowledge base access.
 *
 * Strategy: local retriever first (pgvector in Optimus DB), then
 * brain-rag API fallback (Carlos's external service, transition period).
 *
 * Graceful degradation: if both are unavailable, returns null (same
 * pattern as Neo4j). Agents proceed without RAG context.
 *
 * Env vars:
 *   BRAIN_RAG_API_URL — base URL for fallback (default: brain-rag Railway URL)
 *   BRAIN_RAG_API_KEY — Bearer token for fallback auth
 *   OPENAI_API_KEY    — Required for local embeddings
 */

import { retrieveContext } from './retriever.js';

const RAG_API_URL = process.env.BRAIN_RAG_API_URL || 'https://brain-rag-api-production.up.railway.app';
const RAG_API_KEY = process.env.BRAIN_RAG_API_KEY || '';
const RAG_TIMEOUT_MS = 10_000;

// Cache conversation IDs by scope (avoids creating one per query)
const conversationCache = new Map();

/**
 * Query the RAG knowledge base for context relevant to an email/task.
 *
 * @param {string} query - Natural language query (e.g., "What do we know about Eric Gang?")
 * @param {Object} [opts]
 * @param {boolean} [opts.kbOnly=true] - Only return answers from knowledge base (no hallucination)
 * @param {string} [opts.scope='optimus'] - Conversation scope for caching
 * @returns {Promise<{ answer: string, citations: Array } | null>} Answer with citations, or null if unavailable
 */
export async function queryRAG(queryText, opts = {}) {
  const { kbOnly = true, scope = 'optimus' } = opts;

  // Try local retriever first (pgvector in Optimus DB)
  try {
    const localResult = await retrieveContext(queryText, { scope });
    if (localResult) {
      console.log(`[rag] Local retriever hit: ${localResult.citations?.length || 0} citations`);
      return localResult;
    }
  } catch (err) {
    console.log(`[rag] Local retriever unavailable: ${err.message}`);
  }

  // Fallback to brain-rag API
  if (!RAG_API_KEY) return null;

  try {
    // Get or create conversation for this scope
    let conversationId = conversationCache.get(scope);
    if (!conversationId) {
      const createRes = await fetch(`${RAG_API_URL}/api/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RAG_API_KEY}`,
        },
        body: JSON.stringify({ title: `optimus-agent-${scope}` }),
        signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
      });
      if (!createRes.ok) return null;
      const conv = await createRes.json();
      conversationId = conv.id;
      conversationCache.set(scope, conversationId);
    }

    // Send query
    const msgRes = await fetch(`${RAG_API_URL}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAG_API_KEY}`,
      },
      body: JSON.stringify({
        content: queryText,
        options: { kb_only: kbOnly },
      }),
      signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
    });

    if (!msgRes.ok) return null;
    const message = await msgRes.json();

    return {
      answer: message.content || message.text || '',
      citations: message.citations || message.sources || [],
    };
  } catch {
    // RAG unavailable — graceful degradation (same as Neo4j pattern)
    return null;
  }
}

/**
 * Build a RAG context block for an agent prompt.
 * Queries the knowledge base about the email sender and topic.
 *
 * @param {Object} email - inbox.messages row
 * @returns {Promise<string|null>} Context block to inject into agent prompt, or null
 */
export async function getRAGContext(email) {
  if (!email?.from_address || !RAG_API_KEY) {
    if (!RAG_API_KEY) console.log('[rag] Skipped: BRAIN_RAG_API_KEY not set');
    return null;
  }
  console.log(`[rag] Querying knowledge base for ${email.from_address} / ${email.subject || '(no subject)'}`);

  const senderName = email.from_name || email.from_address.split('@')[0];
  const subject = email.subject || '';

  // Query for sender context + topic context in parallel
  const [senderCtx, topicCtx] = await Promise.all([
    queryRAG(`What do we know about ${senderName} (${email.from_address})? Recent interactions, projects, commitments.`, { scope: 'sender' }),
    subject ? queryRAG(`What context do we have about: ${subject}`, { scope: 'topic' }) : null,
  ]);

  if (!senderCtx && !topicCtx) {
    console.log('[rag] No context found from knowledge base');
    return null;
  }
  console.log(`[rag] Got context: sender=${!!senderCtx?.answer}, topic=${!!topicCtx?.answer}`);

  const parts = ['KNOWLEDGE BASE CONTEXT (from meeting transcripts and documents):'];
  if (senderCtx?.answer) {
    parts.push(`\nABOUT THE SENDER (${senderName}):\n${senderCtx.answer}`);
  }
  if (topicCtx?.answer) {
    parts.push(`\nRELATED CONTEXT:\n${topicCtx.answer}`);
  }
  parts.push('\nIMPORTANT: Use this context to inform your response. Do NOT invent details beyond what is provided here.');

  return parts.join('\n');
}

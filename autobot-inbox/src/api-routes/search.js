/**
 * RAG search API routes.
 *
 * Provides both raw chunk search and synthesized RAG completion.
 * The completion endpoint retrieves relevant chunks then passes them
 * to Haiku for answer synthesis with citations.
 */

import { query } from '../db.js';
import { searchChunks } from '../rag/retriever.js';
import { getEmbeddingInfo } from '../rag/embedder.js';

export function registerSearchRoutes(routes) {

  // POST /api/search — RAG completion (Liotta's 10x: synthesized answer with citations)
  // Retrieves top-k chunks, sends to Haiku for synthesis. ~$0.001/query.
  routes.set('POST /api/search', async (_req, body) => {
    const { query: queryText, matchCount, minSimilarity, ownerId, raw } = body || {};
    if (!queryText) return { error: 'query is required' };

    // Step 1: Vector retrieval
    const result = await searchChunks(queryText, { matchCount: matchCount || 10, minSimilarity, ownerId });
    if (!result || result.chunks.length === 0) {
      return { answer: null, chunks: [], message: 'No relevant documents found' };
    }

    // If raw mode requested, skip synthesis (for debug/admin)
    if (raw) {
      return { chunks: result.chunks, model: result.model };
    }

    // Step 2: Build context from top chunks
    const contextChunks = result.chunks.slice(0, 8); // Top 8 for synthesis
    const context = contextChunks.map((c, i) => {
      const source = c.metadata?.speakers?.length
        ? `[${c.metadata.speakers.join(', ')}]`
        : `[Source ${i + 1}]`;
      return `${source}\n${c.text}`;
    }).join('\n\n---\n\n');

    // Step 3: Synthesize via Haiku
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic();

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a knowledge assistant for the Optimus organization. Answer the user's question based ONLY on the provided context from meeting transcripts, emails, and documents. If the context doesn't contain enough information, say so clearly. Always cite which source(s) support your answer. Be concise and direct.`,
        messages: [{
          role: 'user',
          content: `CONTEXT FROM KNOWLEDGE BASE:\n\n${context}\n\n---\n\nQUESTION: ${queryText}`,
        }],
      });

      const answer = msg.content?.[0]?.type === 'text' ? msg.content[0].text : null;

      return {
        answer,
        citations: contextChunks.map(c => ({
          text: c.text.slice(0, 200),
          similarity: c.similarity,
          documentId: c.documentId,
          metadata: c.metadata,
        })),
        tokens: {
          input: msg.usage?.input_tokens,
          output: msg.usage?.output_tokens,
        },
      };
    } catch (err) {
      console.error(`[search] Synthesis failed: ${err.message}`);
      // Fallback: return raw chunks if synthesis fails
      return {
        answer: null,
        chunks: result.chunks,
        error: 'Synthesis unavailable — showing raw results',
      };
    }
  });

  // GET /api/search/stats — search system health
  routes.set('GET /api/search/stats', async () => {
    const info = getEmbeddingInfo();
    const docCount = await query('SELECT count(*) as c FROM content.documents WHERE deleted_at IS NULL');
    const chunkCount = await query('SELECT count(*) as c FROM content.chunks WHERE embedding IS NOT NULL');
    return {
      documents: parseInt(docCount.rows[0]?.c || 0),
      embeddedChunks: parseInt(chunkCount.rows[0]?.c || 0),
      embeddingProvider: info,
      ready: !!info && parseInt(chunkCount.rows[0]?.c || 0) > 0,
    };
  });
}

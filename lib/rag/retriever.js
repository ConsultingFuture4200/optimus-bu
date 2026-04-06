/**
 * Vector similarity retriever.
 *
 * Replaces brain-rag's conversation API with local pgvector search.
 * Uses content.match_chunks() SQL function (ported from brain-rag).
 *
 * Designed to be a drop-in replacement for the existing queryRAG() interface
 * in client.js — same return shape, same graceful degradation.
 */

import { query } from '../db.js';
import { embedOne, getEmbeddingInfo } from './embedder.js';
import { rerank } from './reranker.js';
import { rewriteQuery } from './query-rewriter.js';
import { searchGraph } from './graph-retriever.js';

const DEFAULT_MATCH_COUNT = parseInt(process.env.RAG_MATCH_COUNT || '30', 10);
const DEFAULT_MIN_SIMILARITY = parseFloat(process.env.RAG_MIN_SIMILARITY || '0.15');
const CONTEXT_MAX_TOKENS = parseInt(process.env.RAG_CONTEXT_MAX_TOKENS || '2200', 10);
const CHARS_PER_TOKEN = 4;

/**
 * Search the local knowledge base for relevant chunks.
 *
 * @param {string} queryText - Natural language query
 * @param {Object} [opts]
 * @param {number} [opts.matchCount] - Max chunks to return
 * @param {number} [opts.minSimilarity] - Minimum cosine similarity threshold
 * @param {string} [opts.ownerId] - Filter to specific board member's documents
 * @param {string} [opts.maxClassification='INTERNAL'] - Max classification level to return
 * @param {string[]} [opts.documentIds] - Filter to specific document IDs (for project-scoped search)
 * @returns {Promise<{ chunks: Array<{ text: string, similarity: number, metadata: Object, documentId: string }>, model: string } | null>}
 */
export async function searchChunks(queryText, opts = {}) {
  const info = getEmbeddingInfo();
  if (!info) {
    console.log('[retriever] No embedding provider configured — skipping local search');
    return null;
  }

  // Embed the query
  const queryEmbedding = await embedOne(queryText);
  if (!queryEmbedding) return null;

  const matchCount = opts.matchCount ?? DEFAULT_MATCH_COUNT;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const ownerId = opts.ownerId ?? null;
  const maxClassification = opts.maxClassification ?? 'INTERNAL';
  const documentIds = opts.documentIds ?? null;

  try {
    let result;
    if (documentIds && documentIds.length > 0) {
      // Project-scoped search: filter by document IDs post-match
      result = await query(
        `SELECT id, document_id, text, metadata, similarity
         FROM content.match_chunks($1::vector, $2, $3, $4, $5)
         WHERE document_id = ANY($6)`,
        [
          `[${queryEmbedding.join(',')}]`,
          matchCount,
          minSimilarity,
          ownerId,
          maxClassification,
          documentIds,
        ]
      );
    } else {
      result = await query(
        `SELECT id, document_id, text, metadata, similarity
         FROM content.match_chunks($1::vector, $2, $3, $4, $5)`,
        [
          `[${queryEmbedding.join(',')}]`,
          matchCount,
          minSimilarity,
          ownerId,
          maxClassification,
        ]
      );
    }

    return {
      chunks: result.rows.map(r => ({
        text: r.text,
        similarity: parseFloat(r.similarity),
        metadata: r.metadata,
        documentId: r.document_id,
      })),
      model: info.model,
    };
  } catch (err) {
    console.error(`[retriever] Search failed: ${err.message}`);
    return null;
  }
}

/**
 * Build a context block for agent prompts from local knowledge base.
 * Drop-in replacement for brain-rag's getRAGContext().
 *
 * Uses multi-query retrieval: rewrites the query into 2-3 search-optimized
 * variants, searches each, deduplicates, then reranks the combined results.
 *
 * @param {string} queryText - What to search for
 * @param {Object} [opts]
 * @param {string} [opts.scope] - Unused (kept for API compat with brain-rag client)
 * @param {string} [opts.ownerId] - Filter to specific board member's documents
 * @param {Array} [opts.history] - Recent conversation turns for coreference resolution
 * @param {string[]} [opts.documentIds] - Filter to specific document IDs (for project-scoped search)
 * @returns {Promise<{ answer: string, citations: Array } | null>}
 */
export async function retrieveContext(queryText, opts = {}) {
  try {
  // Step 1: Query rewriting — resolve coreferences, generate search variants
  let queries;
  try {
    queries = await rewriteQuery(queryText, opts.history || []);
  } catch {
    queries = [queryText]; // Rewriter failed — use original
  }

  // Step 2: Hybrid search — vector + graph in parallel
  const allChunks = new Map(); // keyed by chunk ID for dedup

  // Run vector searches for each query variant + graph search in parallel
  const searchPromises = queries.map(q => searchChunks(q, opts).catch(() => null));
  searchPromises.push(
    searchGraph(queryText).then(graphResults => ({
      chunks: graphResults.map(r => ({
        text: r.text,
        similarity: 0.5,
        metadata: { ...r.metadata, source: 'knowledge_graph' },
        documentId: 'graph',
      })),
    })).catch(() => ({ chunks: [] }))
  );

  const results = await Promise.all(searchPromises);
  for (const result of results) {
    if (result?.chunks) {
      for (const chunk of result.chunks) {
        const key = (chunk.documentId || 'graph') + ':' + chunk.text.slice(0, 50);
        if (!allChunks.has(key) || chunk.similarity > allChunks.get(key).similarity) {
          allChunks.set(key, chunk);
        }
      }
    }
  }

  const mergedChunks = [...allChunks.values()].sort((a, b) => b.similarity - a.similarity);
  if (mergedChunks.length === 0) return null;

  // Step 3: Rerank — cross-encoder re-scores for precision
  const reranked = await rerank(queryText, mergedChunks, 10);

  // Step 4: Build context from reranked chunks
  const maxChars = CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN;
  let answer = '';
  const citations = [];

  for (const chunk of reranked) {
    if (answer.length + chunk.text.length > maxChars) break;

    answer += chunk.text + '\n\n';
    citations.push({
      text: chunk.text.slice(0, 200),
      similarity: chunk.similarity,
      rerankScore: chunk.rerankScore,
      documentId: chunk.documentId,
      metadata: chunk.metadata,
    });
  }

  if (!answer.trim()) return null;

  return {
    answer: answer.trim(),
    citations,
  };
  } catch (err) {
    console.error('[retriever] retrieveContext failed:', err.message);
    return null;
  }
}

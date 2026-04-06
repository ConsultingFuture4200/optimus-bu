/**
 * Cross-encoder reranker for RAG retrieval.
 *
 * Takes top-N chunks from cosine similarity search and re-scores them
 * using a cross-encoder model (Cohere Rerank or Jina) for dramatically
 * better precision.
 *
 * Cosine similarity is a coarse filter (embedding space neighborhoods).
 * Cross-encoder reranking uses full query-document attention to find
 * the actually relevant chunks. Typically improves p@5 from ~0.45 to ~0.75.
 *
 * Falls back gracefully if no rerank API key is configured.
 */

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const JINA_API_KEY = process.env.JINA_API_KEY;

/**
 * Rerank chunks using the best available provider.
 *
 * @param {string} query - The user's question
 * @param {Array<{ text: string, similarity: number, metadata: Object, documentId: string }>} chunks
 * @param {number} [topK=5] - Number of top results to return after reranking
 * @returns {Promise<Array>} Reranked chunks (best first)
 */
export async function rerank(query, chunks, topK = 5) {
  if (!chunks || chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks; // Not enough to rerank

  // Try Cohere first, then Jina, then fall back to original order
  if (COHERE_API_KEY) {
    return rerankCohere(query, chunks, topK);
  }
  if (JINA_API_KEY) {
    return rerankJina(query, chunks, topK);
  }

  // No reranker configured — return top-K by original similarity
  console.log('[reranker] No API key configured, using original similarity order');
  return chunks.slice(0, topK);
}

async function rerankCohere(query, chunks, topK) {
  try {
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'rerank-v3.5',
        query,
        documents: chunks.map(c => c.text),
        top_n: topK,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[reranker] Cohere API error: ${res.status}`);
      return chunks.slice(0, topK);
    }

    const data = await res.json();
    return data.results.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  } catch (err) {
    console.warn(`[reranker] Cohere failed: ${err.message}, falling back`);
    return chunks.slice(0, topK);
  }
}

async function rerankJina(query, chunks, topK) {
  try {
    const res = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${JINA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jina-reranker-v2-base-multilingual',
        query,
        documents: chunks.map(c => ({ text: c.text })),
        top_n: topK,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[reranker] Jina API error: ${res.status}`);
      return chunks.slice(0, topK);
    }

    const data = await res.json();
    return data.results.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  } catch (err) {
    console.warn(`[reranker] Jina failed: ${err.message}, falling back`);
    return chunks.slice(0, topK);
  }
}

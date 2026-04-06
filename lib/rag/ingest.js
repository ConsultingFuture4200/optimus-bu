/**
 * Document ingestion pipeline.
 *
 * Orchestrates: dedup → G8 sanitize → normalize → chunk → embed → store.
 * Runs as a governed work item (executor-ingest) via the Postgres task graph.
 *
 * Every ingestion gets: budget tracking (G1), sanitization (G8),
 * audit trail (P3), dashboard visibility, retry on failure.
 */

import { query } from '../db.js';
import { normalize } from './normalizers/index.js';
import { chunkSegments, chunkByWindow, estimateTokens } from './chunker.js';
import { embedMany, getEmbeddingInfo } from './embedder.js';

// Lazy import to avoid circular deps
let sanitize, countInjectionAttempts, detectPII;
async function loadSanitizer() {
  if (!sanitize) {
    const mod = await import('../runtime/sanitizer.js');
    sanitize = mod.sanitize;
    countInjectionAttempts = mod.countInjectionAttempts;
    detectPII = mod.detectPII;
  }
}

/**
 * Ingest a document into the knowledge base.
 *
 * @param {Object} params
 * @param {string} params.source - Source type: 'drive', 'email', 'upload', 'transcript', 'webhook'
 * @param {string} params.sourceId - Dedup key (file ID, message ID, etc.)
 * @param {string} params.title - Document title
 * @param {string} params.rawText - Raw document text
 * @param {string} [params.format='plain'] - Document format: 'plain', 'tldv', 'markdown'
 * @param {Object} [params.metadata={}] - Source-specific metadata
 * @param {string} [params.ownerId] - Board member UUID
 * @returns {Promise<{ documentId: string, chunkCount: number, embedded: boolean } | null>}
 */
export async function ingestDocument({
  source,
  sourceId,
  title,
  rawText,
  format = 'plain',
  metadata = {},
  ownerId = null,
  skipEmbedding = false,
  classification = null, // Explicit override, otherwise auto-detected
  forceUpdate = false,   // Re-ingest even if sourceId exists (for vault sync)
}) {
  if (!rawText || rawText.trim().length === 0) {
    console.log(`[ingest] Skipped empty document: ${title}`);
    return null;
  }

  // 1. Dedup check (forceUpdate skips for vault re-sync)
  const existing = await query(
    `SELECT id FROM content.documents WHERE source = $1 AND source_id = $2 LIMIT 1`,
    [source, sourceId]
  );
  if (existing.rows.length > 0) {
    if (!forceUpdate) {
      return { documentId: existing.rows[0].id, chunkCount: 0, embedded: false };
    }
    // Force update: delete old chunks, re-ingest
    await query(`DELETE FROM content.chunks WHERE document_id = $1`, [existing.rows[0].id]);
    await query(`DELETE FROM content.documents WHERE id = $1`, [existing.rows[0].id]);
  }

  // 2. G8 Sanitize + PII Detection (Linus: detectPII was dead code — now wired in)
  await loadSanitizer();
  let sanitizedText = rawText;
  let threatCount = 0;
  let isSanitized = true;
  let autoClassification = classification || 'INTERNAL';

  if (sanitize && countInjectionAttempts) {
    threatCount = countInjectionAttempts(rawText);
    if (threatCount > 0) {
      console.warn(`[ingest] G8: ${threatCount} injection attempts detected in "${title}"`);
      sanitizedText = sanitize(rawText);
    }
  }

  // PII detection — auto-classify as CONFIDENTIAL if PII found
  if (detectPII && !classification) {
    const piiResult = detectPII(rawText);
    if (piiResult.hasPII) {
      autoClassification = 'CONFIDENTIAL';
      console.warn(`[ingest] PII detected in "${title}": ${piiResult.detections.map(d => d.type).join(', ')} → CONFIDENTIAL`);
    }
  }

  // 3. Normalize
  const segments = normalize(sanitizedText, format);
  if (segments.length === 0) {
    console.log(`[ingest] No segments after normalization: ${title}`);
    return null;
  }

  const totalTokens = estimateTokens(sanitizedText);
  const embeddingInfo = getEmbeddingInfo();

  // 4. Store document (with classification)
  const docResult = await query(
    `INSERT INTO content.documents
     (source, source_id, title, raw_text, format, metadata, owner_id,
      sanitized, threat_count, token_count, embedding_model, embedding_dimensions, classification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      source, sourceId, title, sanitizedText, format, JSON.stringify(metadata),
      ownerId, isSanitized, threatCount, totalTokens,
      embeddingInfo?.model || null, embeddingInfo?.dimensions || null, autoClassification,
    ]
  );
  const documentId = docResult.rows[0].id;

  // 5. Chunk
  let chunks;
  if (format === 'tldv' || segments.some(s => s.metadata?.speaker)) {
    chunks = chunkSegments(segments);
  } else {
    chunks = chunkByWindow(segments.map(s => s.content));
  }

  // Short documents below minimum chunk size: create a single chunk with full text
  if (chunks.length === 0 && sanitizedText.trim().length > 0) {
    chunks = [{
      content: sanitizedText.trim(),
      metadata: {},
      tokenCount: totalTokens,
    }];
  }

  if (chunks.length === 0) {
    console.log(`[ingest] No chunks produced for "${title}"`);
    return { documentId, chunkCount: 0, embedded: false };
  }

  // 6. Embed (skip during bulk ingestion for speed — embed later via reembed)
  const chunkTexts = chunks.map(c => c.content);
  const embeddings = skipEmbedding ? chunkTexts.map(() => null) : await embedMany(chunkTexts);
  const hasEmbeddings = embeddings.some(e => e !== null);

  // 7. Store chunks with embeddings
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    await query(
      `INSERT INTO content.chunks
       (document_id, chunk_index, text, token_count, embedding, metadata, classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        documentId,
        i,
        chunk.content,
        chunk.tokenCount,
        embedding ? `[${embedding.join(',')}]` : null,
        JSON.stringify(chunk.metadata || {}),
        autoClassification,
      ]
    );
  }

  // Set compile_status for wiki pipeline:
  // - vault docs → 'pending' (ready for compilation)
  // - wiki-compiled docs → 'skip' (anti-circular-ingestion)
  const compileStatus = source === 'wiki-compiled' ? 'skip' : source === 'vault' ? 'pending' : null;
  if (compileStatus) {
    await query(
      `UPDATE content.documents SET compile_status = $1 WHERE id = $2`,
      [compileStatus, documentId]
    );
  }

  console.log(`[ingest] Ingested "${title}": ${chunks.length} chunks, embedded=${hasEmbeddings}`);

  return { documentId, chunkCount: chunks.length, embedded: hasEmbeddings };
}

/**
 * Re-embed all chunks for a document (e.g., after model change).
 * @param {string} documentId
 */
export async function reembedDocument(documentId) {
  const chunks = await query(
    `SELECT id, text FROM content.chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId]
  );
  if (chunks.rows.length === 0) return;

  const texts = chunks.rows.map(c => c.text);
  const embeddings = await embedMany(texts);
  const info = getEmbeddingInfo();

  for (let i = 0; i < chunks.rows.length; i++) {
    const embedding = embeddings[i];
    if (embedding) {
      await query(
        `UPDATE content.chunks SET embedding = $1 WHERE id = $2`,
        [`[${embedding.join(',')}]`, chunks.rows[i].id]
      );
    }
  }

  // Update document's embedding metadata
  if (info) {
    await query(
      `UPDATE content.documents SET embedding_model = $1, embedding_dimensions = $2, updated_at = now() WHERE id = $3`,
      [info.model, info.dimensions, documentId]
    );
  }

  console.log(`[ingest] Re-embedded ${documentId}: ${chunks.rows.length} chunks`);
}

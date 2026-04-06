/**
 * Document ingestion API routes.
 *
 * Endpoints for uploading documents, listing knowledge base contents,
 * searching via vector similarity, and managing ingested documents.
 */

import { google } from 'googleapis';
import { query } from '../db.js';
import { getAuthForAccount } from '../gmail/auth.js';
import { ingestDocument, reembedDocument } from '../rag/ingest.js';
import { searchChunks } from '../rag/retriever.js';
import { getEmbeddingInfo } from '../rag/embedder.js';

const MAX_RAW_TEXT_BYTES = 512_000; // 500KB input limit
const activeEmailJobs = new Set();  // Concurrency guard for ingest-email

export function registerDocumentRoutes(routes, cachedQuery) {

  // POST /api/documents/ingest — ingest a document (paste/upload)
  routes.set('POST /api/documents/ingest', async (req, body) => {
    const { source, sourceId, title, rawText, format, metadata, ownerId } = body || {};
    if (!rawText || !title) {
      return { error: 'title and rawText are required' };
    }
    if (rawText.length > MAX_RAW_TEXT_BYTES) {
      throw Object.assign(new Error(`rawText exceeds ${MAX_RAW_TEXT_BYTES} byte limit`), { statusCode: 413 });
    }
    const result = await ingestDocument({
      source: source || 'upload',
      sourceId: sourceId || `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      rawText,
      format: format || 'plain',
      metadata: metadata || {},
      ownerId: ownerId || null,
    });
    return result || { error: 'Ingestion produced no result (empty document?)' };
  });

  // GET /api/documents — list ingested documents
  routes.set('GET /api/documents', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const source = url.searchParams.get('source');

    let sql = `
      SELECT d.id, d.source, d.source_id, d.title, d.format,
             d.sanitized, d.threat_count, d.token_count,
             d.embedding_model, d.created_at,
             (SELECT COUNT(*) FROM content.chunks c WHERE c.document_id = d.id) AS chunk_count
      FROM content.documents d
    `;
    const params = [];
    if (source) {
      params.push(source);
      sql += ` WHERE d.source = $${params.length}`;
    }
    sql += ` ORDER BY d.created_at DESC`;
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    params.push(offset);
    sql += ` OFFSET $${params.length}`;

    const result = await query(sql, params);

    const countResult = await query(
      `SELECT COUNT(*) AS total FROM content.documents${source ? ' WHERE source = $1' : ''}`,
      source ? [source] : []
    );

    return {
      documents: result.rows,
      total: parseInt(countResult.rows[0]?.total || 0),
      limit,
      offset,
    };
  });

  // GET /api/documents/:id — get document details with chunks
  routes.set('GET /api/documents/detail', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) return { error: 'id parameter required' };

    const docResult = await query(
      `SELECT * FROM content.documents WHERE id = $1`, [id]
    );
    if (docResult.rows.length === 0) return { error: 'Document not found' };

    const chunksResult = await query(
      `SELECT id, chunk_index, text, token_count, metadata,
              (embedding IS NOT NULL) AS has_embedding
       FROM content.chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [id]
    );

    return {
      document: docResult.rows[0],
      chunks: chunksResult.rows,
    };
  });

  // POST /api/documents/search — vector similarity search
  routes.set('POST /api/documents/search', async (_req, body) => {
    const { query: queryText, matchCount, minSimilarity, ownerId } = body || {};
    if (!queryText) return { error: 'query is required' };

    const result = await searchChunks(queryText, { matchCount, minSimilarity, ownerId });
    if (!result) return { chunks: [], message: 'No embedding provider configured' };
    return result;
  });

  // POST /api/documents/reembed — re-embed a document (after model change)
  routes.set('POST /api/documents/reembed', async (_req, body) => {
    const { documentId } = body || {};
    if (!documentId) return { error: 'documentId required' };
    await reembedDocument(documentId);
    return { success: true };
  });

  // DELETE /api/documents — soft-delete a document (P3: audit trail preserved)
  routes.set('DELETE /api/documents', async (req, body) => {
    const { id } = body || {};
    if (!id) return { error: 'id required' };
    const actedBy = req.headers?.['x-board-user'] || 'unknown';
    const result = await query(
      `UPDATE content.documents SET deleted_at = now(), metadata = metadata || $1 WHERE id = $2 AND deleted_at IS NULL`,
      [JSON.stringify({ deleted_by: actedBy, deleted_reason: 'manual' }), id]
    );
    if (result.rowCount === 0) return { error: 'Document not found or already deleted' };
    return { success: true };
  });

  // POST /api/documents/ingest-email — bulk ingest email threads for a Gmail account
  // Runs async in background — returns immediately with job status.
  // Body: { identifier: "eric@staqs.io", maxThreads?: 5000 }
  routes.set('POST /api/documents/ingest-email', async (req, body) => {
    const { identifier, maxThreads = 500 } = body || {};
    if (!identifier) return { error: 'identifier (email address) required' };

    // Concurrency guard — one job per identifier at a time
    if (activeEmailJobs.has(identifier)) {
      throw Object.assign(new Error(`Ingestion already running for ${identifier}`), { statusCode: 409 });
    }

    // Find account
    const accountResult = await query(
      `SELECT id, identifier, owner_id FROM inbox.accounts WHERE identifier = $1 AND is_active = true`,
      [identifier]
    );
    if (accountResult.rows.length === 0) {
      const all = await query(`SELECT identifier FROM inbox.accounts WHERE is_active = true`);
      return { error: `No active account for ${identifier}`, available: all.rows.map(r => r.identifier) };
    }

    const account = accountResult.rows[0];

    // Run in background (don't block the HTTP response)
    const jobId = `email-ingest-${Date.now()}`;
    activeEmailJobs.add(identifier);
    setImmediate(() => {
      (async () => {
      console.log(`[ingest-email] Starting bulk ingestion for ${identifier} (job: ${jobId})`);
      const BATCH_SIZE = 50;
      const DELAY_MS = 200;

      try {
        const auth = await getAuthForAccount(account.id);
        const gmail = google.gmail({ version: 'v1', auth });

        let pageToken = undefined;
        let totalThreads = 0;
        let ingested = 0;
        let skipped = 0;
        let errors = 0;

        do {
          const listResult = await gmail.users.threads.list({
            userId: 'me',
            q: `from:${identifier}`,
            maxResults: BATCH_SIZE,
            pageToken,
          });

          const threads = listResult.data.threads || [];
          totalThreads += threads.length;
          pageToken = listResult.data.nextPageToken;

          for (const threadStub of threads) {
            try {
              // Dedup
              const existing = await query(
                `SELECT id FROM content.documents WHERE source = 'email' AND source_id = $1`,
                [threadStub.id]
              );
              if (existing.rows.length > 0) { skipped++; continue; }

              // Fetch thread with minimal format to avoid OOM on large attachments
              // Use 'metadata' for headers + snippet for body (fast, memory-safe)
              const thread = await gmail.users.threads.get({
                userId: 'me',
                id: threadStub.id,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              });

              const messages = thread.data.messages || [];
              if (messages.length === 0) { skipped++; continue; }

              const subject = getHeader(messages[0], 'Subject') || '(no subject)';
              const participants = new Set();
              const threadParts = [];

              for (const msg of messages) {
                const from = getHeader(msg, 'From') || 'Unknown';
                const to = getHeader(msg, 'To') || '';
                const date = getHeader(msg, 'Date') || '';
                const msgBody = msg.snippet || '';

                participants.add(from);
                if (to) to.split(',').forEach(t => participants.add(t.trim()));
                threadParts.push(`From: ${from}\nDate: ${date}\n\n${msgBody}`);
              }

              const rawText = `Subject: ${subject}\nParticipants: ${Array.from(participants).join(', ')}\nMessages: ${messages.length}\n\n${threadParts.join('\n\n---\n\n')}`;

              const result = await ingestDocument({
                source: 'email',
                sourceId: threadStub.id,
                title: subject,
                rawText,
                format: 'plain',
                metadata: {
                  threadId: threadStub.id,
                  messageCount: messages.length,
                  participants: Array.from(participants),
                  account: identifier,
                  firstDate: getHeader(messages[0], 'Date'),
                  lastDate: getHeader(messages[messages.length - 1], 'Date'),
                },
                ownerId: account.owner_id || null,
                skipEmbedding: true, // Embed in batch afterward — bulk ingestion is too slow with per-doc embedding
              });

              if (result && result.chunkCount > 0) {
                ingested++;
                if (ingested % 50 === 0) {
                  console.log(`[ingest-email] Progress: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
                }
              } else {
                skipped++;
              }
            } catch (err) {
              errors++;
              if (errors <= 5) console.warn(`[ingest-email] Thread ${threadStub.id}: ${err.message.slice(0, 100)}`);
            }

            await new Promise(r => setTimeout(r, DELAY_MS));
          }

          if (totalThreads >= maxThreads) break;
        } while (pageToken);

        console.log(`[ingest-email] Complete for ${identifier}: ${ingested} ingested, ${skipped} skipped, ${errors} errors (${totalThreads} total)`);
      } catch (err) {
        console.error(`[ingest-email] Fatal error for ${identifier}: ${err.message}`);
      } finally {
        activeEmailJobs.delete(identifier);
      }
      })().catch(err => {
        console.error(`[ingest-email] Unhandled error: ${err.message}\n${err.stack}`);
        activeEmailJobs.delete(identifier);
      });
    });

    return { ok: true, jobId, message: `Email ingestion started for ${identifier}. Check Railway logs for progress.` };
  });

  // POST /api/documents/ingest-drive — bulk ingest Google Docs from Drive
  // Crawls all Google Docs (and text/PDF files) across the account's Drive.
  // Body: { identifier: "eric@staqs.io", maxFiles?: 500, query?: "mimeType query" }
  const activeDriveJobs = new Set();
  routes.set('POST /api/documents/ingest-drive', async (req, body) => {
    const { identifier, maxFiles = 500, driveQuery } = body || {};
    if (!identifier) return { error: 'identifier (email address) required' };

    if (activeDriveJobs.has(identifier)) {
      throw Object.assign(new Error(`Drive ingestion already running for ${identifier}`), { statusCode: 409 });
    }

    const accountResult = await query(
      `SELECT id, identifier, owner_id FROM inbox.accounts WHERE identifier = $1 AND is_active = true`,
      [identifier]
    );
    if (accountResult.rows.length === 0) {
      return { error: `No active account for ${identifier}` };
    }

    const account = accountResult.rows[0];
    const jobId = `drive-ingest-${Date.now()}`;
    activeDriveJobs.add(identifier);

    setImmediate(() => {
      (async () => {
      console.log(`[ingest-drive] Starting bulk Drive ingestion for ${identifier} (job: ${jobId})`);
      const DELAY_MS = 200;
      const MAX_SNIPPET = 50_000;

      try {
        // Use service account with domain-wide delegation (OAuth lacks drive.readonly — restricted scope)
        const { getDriveClient, hasServiceAccount } = await import('../drive/service-auth.js');
        let drive;
        if (hasServiceAccount()) {
          console.log(`[ingest-drive] Using service account for ${identifier}...`);
          drive = getDriveClient(identifier);
        } else {
          console.log(`[ingest-drive] No service account — trying OAuth for ${account.id}...`);
          const auth = await getAuthForAccount(account.id);
          drive = google.drive({ version: 'v3', auth });
        }
        console.log(`[ingest-drive] Drive client ready, searching files...`);

        // Search for Google Docs, plain text, and PDFs
        const q = driveQuery || "mimeType='application/vnd.google-apps.document' or mimeType='text/plain' or mimeType='application/pdf'";
        let pageToken = undefined;
        let totalFiles = 0;
        let ingested = 0;
        let skipped = 0;
        let errors = 0;

        do {
          const res = await drive.files.list({
            q,
            fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 100,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });

          const files = res.data.files || [];
          totalFiles += files.length;
          pageToken = res.data.nextPageToken;

          for (const file of files) {
            try {
              // Dedup
              const existing = await query(
                `SELECT id FROM content.documents WHERE source = 'drive' AND source_id = $1 AND deleted_at IS NULL`,
                [file.id]
              );
              if (existing.rows.length > 0) { skipped++; continue; }

              // Export/download text
              let text;
              if (file.mimeType === 'application/vnd.google-apps.document') {
                const exp = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
                text = String(exp.data || '').slice(0, MAX_SNIPPET);
              } else {
                const get = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
                text = String(get.data || '').slice(0, MAX_SNIPPET);
              }

              if (!text || text.trim().length === 0) { skipped++; continue; }

              await ingestDocument({
                source: 'drive',
                sourceId: file.id,
                title: file.name,
                rawText: text,
                format: 'plain',
                metadata: { mimeType: file.mimeType, createdTime: file.createdTime, modifiedTime: file.modifiedTime },
                ownerId: account.owner_id || null,
                skipEmbedding: true,
              });
              ingested++;

              if (ingested % 50 === 0) {
                console.log(`[ingest-drive] Progress: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
              }
            } catch (err) {
              errors++;
              if (errors <= 10) console.warn(`[ingest-drive] ${file.name}: ${err.message.slice(0, 100)}`);
            }

            await new Promise(r => setTimeout(r, DELAY_MS));
          }

          if (totalFiles >= maxFiles) break;
        } while (pageToken);

        console.log(`[ingest-drive] Complete for ${identifier}: ${ingested} ingested, ${skipped} skipped, ${errors} errors (${totalFiles} files scanned)`);
      } catch (err) {
        console.error(`[ingest-drive] Fatal error for ${identifier}: ${err.message}\n${err.stack}`);
      } finally {
        activeDriveJobs.delete(identifier);
      }
      })().catch(err => {
        console.error(`[ingest-drive] Unhandled error: ${err.message}\n${err.stack}`);
        activeDriveJobs.delete(identifier);
      });
    });

    return { ok: true, jobId, message: `Drive ingestion started for ${identifier}. Check Railway logs for progress.` };
  });

  // POST /api/documents/embed-pending — batch embed all chunks without embeddings
  // Runs async in background — processes 100 chunks at a time until done.
  let embedJobRunning = false;
  routes.set('POST /api/documents/embed-pending', async () => {
    if (embedJobRunning) {
      const remaining = await query(`SELECT count(*) as c FROM content.chunks WHERE embedding IS NULL`);
      return { status: 'running', remaining: parseInt(remaining.rows[0].c) };
    }

    const { embedMany: batchEmbed, getEmbeddingInfo: getInfo } = await import('../rag/embedder.js');
    const info = getInfo();
    if (!info) return { error: 'No embedding provider configured' };

    const countResult = await query(`SELECT count(*) as c FROM content.chunks WHERE embedding IS NULL`);
    const totalPending = parseInt(countResult.rows[0].c);
    if (totalPending === 0) return { embedded: 0, remaining: 0, message: 'No pending chunks' };

    embedJobRunning = true;
    const BATCH = 100;

    setImmediate(async () => {
      let totalEmbedded = 0;
      try {
        while (true) {
          const pending = await query(
            `SELECT c.id, c.text FROM content.chunks c WHERE c.embedding IS NULL ORDER BY c.created_at LIMIT $1`,
            [BATCH]
          );
          if (pending.rows.length === 0) break;

          const texts = pending.rows.map(r => r.text);
          const embeddings = await batchEmbed(texts);

          for (let i = 0; i < pending.rows.length; i++) {
            if (embeddings[i]) {
              await query(`UPDATE content.chunks SET embedding = $1 WHERE id = $2`, [
                `[${embeddings[i].join(',')}]`, pending.rows[i].id,
              ]);
              totalEmbedded++;
            }
          }
          console.log(`[embed-pending] Batch done: ${totalEmbedded} embedded so far`);
        }
        console.log(`[embed-pending] Complete: ${totalEmbedded} chunks embedded`);
      } catch (err) {
        console.error(`[embed-pending] Error: ${err.message}`);
      } finally {
        embedJobRunning = false;
      }
    });

    return { ok: true, totalPending, message: `Embedding ${totalPending} chunks in background. Check logs for progress.` };
  });

  // POST /api/documents/ingest-url — ingest a web page into RAG
  routes.set('POST /api/documents/ingest-url', async (_req, body) => {
    const { url } = body || {};
    if (!url) {
      const err = new Error('url is required');
      err.statusCode = 400;
      throw err;
    }

    const { normalizeUrl } = await import('../../../lib/rag/normalizers/url.js');
    const doc = await normalizeUrl(url);
    const result = await ingestDocument({
      source: doc.source,
      sourceId: `url_${doc.metadata.url}`,
      title: doc.title,
      rawText: doc.content,
      format: 'plain',
      metadata: doc.metadata,
    });
    return result || { error: 'Ingestion produced no result (empty page?)' };
  });

  // POST /api/documents/ingest-repo — ingest a GitHub repo into RAG
  routes.set('POST /api/documents/ingest-repo', async (_req, body) => {
    const { url } = body || {};
    if (!url) {
      const err = new Error('url is required');
      err.statusCode = 400;
      throw err;
    }

    const { normalizeGithubRepo } = await import('../../../lib/rag/normalizers/github.js');
    const doc = await normalizeGithubRepo(url);
    const result = await ingestDocument({
      source: doc.source,
      sourceId: `github_${doc.metadata.owner}/${doc.metadata.repo}`,
      title: doc.title,
      rawText: doc.content,
      format: 'markdown',
      metadata: doc.metadata,
    });
    return result || { error: 'Ingestion produced no result (empty repo?)' };
  });

  // GET /api/documents/stats — knowledge base statistics
  routes.set('GET /api/documents/stats', async () => {
    const stats = await cachedQuery('document-stats', async () => {
      const result = await query(`
        SELECT
          (SELECT COUNT(*) FROM content.documents) AS document_count,
          (SELECT COUNT(*) FROM content.chunks) AS chunk_count,
          (SELECT COUNT(*) FROM content.chunks WHERE embedding IS NOT NULL) AS embedded_chunks,
          (SELECT COALESCE(SUM(token_count), 0) FROM content.documents) AS total_tokens,
          (SELECT COUNT(DISTINCT source) FROM content.documents) AS source_types
      `);
      return result.rows[0];
    }, 60_000);

    return {
      ...stats,
      embeddingProvider: getEmbeddingInfo(),
    };
  });
}

/** Extract a header value from a Gmail message */
function getHeader(message, name) {
  const headers = message?.payload?.headers || [];
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

/** Extract plain text body from a Gmail message */
function extractBody(message) {
  const payload = message?.payload;
  if (!payload) return '';

  if (payload.body?.data) return decodeBase64(payload.body.data);

  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
    if (part.parts) {
      for (const sub of part.parts) {
        if (sub.mimeType === 'text/plain' && sub.body?.data) return decodeBase64(sub.body.data);
      }
    }
  }

  return message.snippet || '';
}

function decodeBase64(data) {
  return Buffer.from(data, 'base64url').toString('utf8');
}

import { google } from 'googleapis';
import { getAuthForAccount } from '../gmail/auth.js';
import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { ingestDocument } from '../rag/ingest.js';

const MAX_SNIPPET_LENGTH = 15_000;

/**
 * Poll all active Drive folder watches.
 * Called on interval from index.js. Each watch uses the linked
 * Gmail account's OAuth credentials (drive.readonly scope).
 *
 * @returns {Promise<number>} Total documents ingested across all watches
 */
export async function pollAllDriveWatches() {
  const watches = await query(
    `SELECT id, account_id, folder_id, preset, label
     FROM inbox.drive_watches
     WHERE is_active = true`
  );

  let total = 0;
  for (const watch of watches.rows) {
    try {
      const count = await pollDriveFolder(watch);
      total += count;
      if (count > 0) {
        await query(
          `UPDATE inbox.drive_watches SET last_poll_at = now(), last_error = NULL WHERE id = $1`,
          [watch.id]
        );
      } else {
        await query(
          `UPDATE inbox.drive_watches SET last_poll_at = now() WHERE id = $1`,
          [watch.id]
        );
      }
    } catch (err) {
      console.error(`[drive] Error polling folder ${watch.folder_id}: ${err.message}`);
      await query(
        `UPDATE inbox.drive_watches SET last_poll_at = now(), last_error = $1 WHERE id = $2`,
        [err.message.slice(0, 500), watch.id]
      );
      // Surface persistent errors in the governance feed (not just silent logs)
      await publishEvent(
        'infrastructure_error',
        `Drive watcher error: ${err.message}`,
        null,
        null,
        { folder_id: watch.folder_id, label: watch.label, error: err.message },
      ).catch(() => {}); // non-fatal
    }
  }
  return total;
}

/**
 * Poll a single Drive folder for new Google Docs.
 * Dedup: uses channel_id = fileId (unique within channel = 'webhook').
 *
 * @param {{ account_id: string, folder_id: string, preset: string|null, label: string }} watch
 * @returns {Promise<number>} Number of documents ingested
 */
async function pollDriveFolder(watch) {
  const { createWorkItem } = await import('../runtime/state-machine.js');
  const auth = await getAuthForAccount(watch.account_id);
  const drive = google.drive({ version: 'v3', auth });

  // List files in folder — Google Docs and common document types
  // tl;dv may save as Google Docs or upload as PDF/text
  // supportsAllDrives + includeItemsFromAllDrives required for shared/team drive folders
  const res = await drive.files.list({
    q: `'${watch.folder_id}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const allFiles = res.data.files || [];
  if (allFiles.length === 0) {
    console.log(`[drive] Folder ${watch.folder_id}: empty`);
    return 0;
  }
  console.log(`[drive] Folder ${watch.folder_id}: ${allFiles.length} files found`);
  for (const f of allFiles.slice(0, 5)) {
    console.log(`[drive]   - ${f.name} (${f.mimeType})`);
  }

  // Filter to exportable types: Google Docs, text, PDFs
  const SUPPORTED_MIME = new Set([
    'application/vnd.google-apps.document',
    'text/plain',
    'application/pdf',
  ]);
  const files = allFiles.filter(f => SUPPORTED_MIME.has(f.mimeType));
  if (files.length === 0) {
    console.log(`[drive] No supported document types found (${allFiles.map(f => f.mimeType).join(', ')})`);
    return 0;
  }

  let ingested = 0;
  for (const file of files) {
    // Dedup: check if we already have this file by channel_id
    const existing = await query(
      `SELECT 1 FROM inbox.messages WHERE channel = 'webhook' AND channel_id = $1 LIMIT 1`,
      [file.id]
    );
    if (existing.rows.length > 0) continue;

    // Export file as plain text (Google Docs use export, regular files use get)
    let text;
    try {
      if (file.mimeType === 'application/vnd.google-apps.document') {
        const exportRes = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
        text = String(exportRes.data || '').slice(0, MAX_SNIPPET_LENGTH);
      } else {
        // Regular files (text, PDF): download content
        const getRes = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
        text = String(getRes.data || '').slice(0, MAX_SNIPPET_LENGTH);
      }
    } catch (err) {
      console.warn(`[drive] Failed to export ${file.name} (${file.id}): ${err.message}`);
      continue;
    }

    if (!text || text.trim().length === 0) continue;

    const preset = watch.preset || 'generic';
    const labels = [`webhook:${preset}`, `${preset}:transcript`, 'drive:folder'];
    const providerMsgId = `drive_${file.id}`;

    // Insert into inbox.messages as webhook channel
    const msgResult = await query(
      `INSERT INTO inbox.messages
       (provider_msg_id, provider, channel, thread_id, message_id,
        from_address, from_name, to_addresses, subject, snippet,
        received_at, labels, has_attachments, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        providerMsgId, 'webhook', 'webhook',
        `wh_thread_${providerMsgId}`, `<${providerMsgId}@webhook>`,
        'tldv', watch.label, ['system@autobot'],
        file.name, text,
        file.createdTime || new Date().toISOString(), labels,
        false, file.id,
      ]
    );

    const msgId = msgResult.rows[0]?.id;
    if (!msgId) continue;

    // Create triage work item — enters governed pipeline
    const workItem = await createWorkItem({
      type: 'task',
      title: `Drive: ${file.name}`,
      description: `${preset} transcript from Drive folder`,
      createdBy: 'orchestrator',
      assignedTo: 'executor-triage',
      priority: 0,
      metadata: { email_id: msgId, provider_msg_id: providerMsgId, webhook_source: preset },
    });

    if (workItem) {
      await query(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, msgId]);
    }

    // Feed to document ingestion pipeline (RAG knowledge base)
    const format = preset === 'tldv' ? 'tldv' : 'plain';
    ingestDocument({
      source: 'drive',
      sourceId: file.id,
      title: file.name,
      rawText: text,
      format,
      metadata: { preset, folderId: watch.folder_id, label: watch.label },
      ownerId: null, // Drive docs are org-wide
    }).catch(err => console.warn(`[drive] RAG ingest failed for ${file.name}: ${err.message}`));

    console.log(`[drive] Ingested transcript: "${file.name}" (${file.id})`);
    ingested++;
  }

  return ingested;
}

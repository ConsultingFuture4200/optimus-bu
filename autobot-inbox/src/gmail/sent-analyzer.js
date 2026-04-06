import { google } from 'googleapis';
import { getAuth } from './auth.js';
import { query } from '../db.js';

/**
 * Sent email analyzer: bootstrap voice data from sent mail.
 * D3: Voice profiles derived from sent mail analysis, not hand-authored.
 * Pulls sent emails → stores in voice.sent_emails → builds profile clusters.
 */

/**
 * Bootstrap: fetch sent emails for voice training.
 * @param {number} maxResults - Number of sent emails to fetch (default 1000)
 */
export async function bootstrapSentEmails(maxResults = 1000, authClient = null) {
  const gmail = google.gmail({ version: 'v1', auth: authClient || getAuth() });
  let pageToken = null;
  let fetched = 0;

  console.log(`[sent-analyzer] Bootstrapping up to ${maxResults} sent emails...`);

  do {
    const params = {
      userId: 'me',
      labelIds: ['SENT'],
      maxResults: Math.min(100, maxResults - fetched),
    };
    if (pageToken) params.pageToken = pageToken;

    const listResult = await gmail.users.messages.list(params);
    const messages = listResult.data.messages || [];

    for (const msg of messages) {
      try {
        // Skip if already imported
        const existing = await query(
          `SELECT id FROM voice.sent_emails WHERE provider_msg_id = $1`,
          [msg.id]
        );
        if (existing.rows.length > 0) continue;

        // Fetch full message
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const headers = {};
        for (const h of full.data.payload.headers) {
          headers[h.name.toLowerCase()] = h.value;
        }

        // Extract body
        const body = extractPlainText(full.data.payload);
        if (!body || body.length < 20) continue; // Skip empty/tiny emails

        const toAddress = parseEmailAddress(headers.to || '');
        const toName = parseEmailName(headers.to || '');

        await query(
          `INSERT INTO voice.sent_emails
           (provider_msg_id, thread_id, to_address, to_name, subject, body, word_count, sent_at, is_reply)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (provider_msg_id) DO NOTHING`,
          [
            msg.id,
            full.data.threadId,
            toAddress,
            toName,
            headers.subject || '',
            body,
            body.split(/\s+/).length,
            headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
            !!(headers['in-reply-to']),
          ]
        );

        fetched++;
        if (fetched % 50 === 0) {
          console.log(`[sent-analyzer] Imported ${fetched} sent emails...`);
        }
      } catch (err) {
        console.error(`[sent-analyzer] Failed to process ${msg.id}:`, err.message);
      }
    }

    pageToken = listResult.data.nextPageToken;
  } while (pageToken && fetched < maxResults);

  console.log(`[sent-analyzer] Bootstrap complete: ${fetched} sent emails imported`);
  return fetched;
}

function extractPlainText(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return null;
}

function parseEmailAddress(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str.trim();
}

function parseEmailName(str) {
  const match = str.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : null;
}

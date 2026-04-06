/**
 * Signal Ingester: create inbox.messages + inbox.signals rows WITHOUT a work_item.
 *
 * This is Tier 3 of the webhook routing system:
 * - Tier 1: Direct work_item (board pre-authorized, e.g. auto-fix label)
 * - Tier 2: Intent (creates agent_intents row for board review)
 * - Tier 3: Signal-only (this module — surfaces in briefings, zero LLM cost)
 *
 * Reuses the webhook insertion pattern from api.js lines 960-1002
 * but stops before createWorkItem().
 *
 * P1: Deny by default — only called when routing config explicitly directs here.
 * P3: Transparency by structure — signals are logged, not chosen.
 * P4: Boring infrastructure — raw SQL, no ORM.
 */

import { query } from '../db.js';

/**
 * Ingest a webhook event as signal-only (no work_item created).
 *
 * @param {Object} opts
 * @param {string} opts.source - Webhook source identifier (e.g. 'linear', 'github', 'tldv')
 * @param {string} opts.title - Short title for the message
 * @param {string} opts.snippet - Body/description text (truncated to 2000 chars)
 * @param {string} opts.from - Sender identifier
 * @param {Array<Object>} opts.signals - Array of signal objects to create
 * @param {string} opts.signals[].signal_type - ADR-014 signal type (commitment, deadline, request, question, etc.)
 * @param {string} opts.signals[].content - Signal content text
 * @param {number} [opts.signals[].confidence] - Confidence score 0-1 (default 0.8)
 * @param {string} [opts.signals[].direction] - 'inbound' | 'outbound' | 'internal' (default 'inbound')
 * @param {string} [opts.signals[].domain] - Domain category (default null)
 * @param {Object} [opts.metadata] - Additional metadata for the message
 * @param {string[]} [opts.labels] - Additional labels (webhook:<source> and signal-only auto-added)
 * @param {string} [opts.providerMsgId] - Provider message ID for dedup (auto-generated if not provided)
 * @param {string} [opts.threadId] - Thread ID for grouping related signals
 * @returns {{ messageId: number, signalIds: number[] }}
 */
export async function ingestAsSignal({
  source,
  title,
  snippet,
  from,
  signals = [],
  metadata = {},
  labels = [],
  providerMsgId = null,
  threadId = null,
}) {
  // Normalize and truncate attacker-controlled fields
  const safeTitle = String(title || `Signal from ${source}`).slice(0, 500);
  const safeSnippet = String(snippet || '').slice(0, 2000) || `[${source} signal event]`;
  const safeFrom = String(from || source).slice(0, 255);
  const safeMsgId = providerMsgId
    || `sig_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safeThreadId = threadId || `sig_thread_${safeMsgId}`;

  // Build labels: always include source tag and signal-only marker
  const allLabels = [
    `webhook:${source}`,
    'signal-only',
    ...labels.filter(l => l && typeof l === 'string').map(l => l.slice(0, 100)),
  ];

  // Insert message into inbox (same pattern as api.js webhook handler)
  const msgResult = await query(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (channel, channel_id) WHERE channel_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      safeMsgId, 'webhook', 'webhook',
      safeThreadId, `<${safeMsgId}@webhook>`,
      safeFrom, source, ['system@autobot'],
      safeTitle, safeSnippet,
      new Date().toISOString(), allLabels,
      false, safeMsgId,
    ]
  );

  // Dedup: if ON CONFLICT triggered, return null (already ingested)
  if (msgResult.rows.length === 0) {
    console.log(`[signal-ingester] Dedup: skipped duplicate signal for ${source} msgId=${safeMsgId}`);
    return null;
  }

  const messageId = msgResult.rows[0].id;

  // Insert signals using existing ADR-014 schema
  const signalIds = [];
  for (const sig of signals) {
    if (!sig.signal_type || !sig.content) continue;

    try {
      const sigResult = await query(
        `INSERT INTO inbox.signals
         (message_id, signal_type, content, confidence, direction, domain)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          messageId,
          String(sig.signal_type).slice(0, 50),
          String(sig.content).slice(0, 2000),
          sig.confidence ?? 0.8,
          sig.direction || 'inbound',
          sig.domain || null,
        ]
      );
      if (sigResult.rows[0]) {
        signalIds.push(sigResult.rows[0].id);
      }
    } catch (err) {
      console.warn(`[signal-ingester] Failed to insert signal: ${err.message}`);
    }
  }

  // Store source-specific metadata on the message (best-effort)
  if (Object.keys(metadata).length > 0) {
    try {
      await query(
        `UPDATE inbox.messages SET metadata = $1 WHERE id = $2`,
        [JSON.stringify(metadata), messageId]
      );
    } catch {
      // metadata column may not exist — non-fatal
    }
  }

  console.log(`[signal-ingester] Ingested ${source} signal: msgId=${messageId}, ${signalIds.length} signal(s)`);
  return { messageId, signalIds };
}

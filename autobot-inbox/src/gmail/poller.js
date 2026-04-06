import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { fetchEmailMetadata, fetchMessageLabels } from './client.js';
import { query } from '../db.js';
import { resolveSignalsByMessage } from '../signal/extractor.js';

/**
 * Gmail poller: incremental polling via history ID (D7: poll, not push).
 * Multi-account: polls all active email accounts sequentially with stagger.
 */

/**
 * Poll all active email accounts for new messages.
 * Sequential with 2s stagger to avoid rate limits.
 * @returns {Promise<Array>} All new messages across all accounts
 */
export async function pollAllAccounts() {
  const accountsResult = await query(
    `SELECT id, identifier, label FROM inbox.accounts WHERE channel = 'email' AND is_active = true AND sync_status != 'setup' ORDER BY created_at`
  );
  const accounts = accountsResult.rows;

  if (accounts.length === 0) {
    // No active accounts — nothing to poll. Users add accounts via Settings UI.
    return [];
  }

  const allMessages = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await delay(2000); // 2s stagger between accounts

    try {
      // Update sync status
      await query(
        `UPDATE inbox.accounts SET sync_status = 'syncing', updated_at = now() WHERE id = $1`,
        [accounts[i].id]
      );

      const messages = await pollForNewMessages(accounts[i].id);
      allMessages.push(...messages);

      // Reconcile signals: detect Gmail replies/archives and auto-resolve
      await reconcileSignals(accounts[i].id);

      // Update sync status + last_sync_at
      await query(
        `UPDATE inbox.accounts SET sync_status = 'active', last_sync_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
        [accounts[i].id]
      );
    } catch (err) {
      console.error(`[poller] Error polling account ${accounts[i].label} (${accounts[i].id}):`, err.message);
      await query(
        `UPDATE inbox.accounts SET sync_status = 'error', last_error = $1, updated_at = now() WHERE id = $2`,
        [err.message.slice(0, 500), accounts[i].id]
      );
    }
  }

  return allMessages;
}

/**
 * Poll for new messages since last history ID.
 * @param {string} [accountId] - Account ID (null for env-var default)
 * @returns {Promise<Array>} Array of new email metadata objects
 */
export async function pollForNewMessages(accountId) {
  const auth = accountId ? await getAuthForAccount(accountId) : getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Get last sync state — keyed by account_id
  const syncKey = accountId || 'default';
  const syncResult = await query(
    `SELECT history_id FROM inbox.sync_state WHERE account_id = $1`,
    [syncKey]
  );

  let historyId = syncResult.rows[0]?.history_id;
  const newMessages = [];

  if (!historyId) {
    // First sync limited to 10 messages to avoid flooding budget.
    const listResult = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      labelIds: ['INBOX'],
    });

    const messages = listResult.data.messages || [];
    for (const msg of messages) {
      try {
        const metadata = await fetchEmailMetadata(msg.id, accountId);
        newMessages.push(metadata);
      } catch (err) {
        console.error(`[poller] Failed to fetch ${msg.id}:`, err.message);
      }
    }

    // Get current history ID for next poll
    const profile = await gmail.users.getProfile({ userId: 'me' });
    historyId = profile.data.historyId;

    // Initialize sync state (keyed by account_id)
    await query(
      `INSERT INTO inbox.sync_state (account_id, channel, history_id, messages_synced)
       VALUES ($1, 'email', $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         history_id = $2, messages_synced = inbox.sync_state.messages_synced + $3, last_poll_at = now(), updated_at = now()`,
      [syncKey, historyId, newMessages.length]
    );
  } else {
    // Incremental sync via history
    try {
      // No labelId filter — Gmail drops thread continuations when filtering
      // by label in history.list(). We fetch all history and filter client-side.
      const historyResult = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: historyId,
        historyTypes: ['messageAdded', 'labelAdded'],
      });

      const history = historyResult.data.history || [];
      const seenIds = new Set();

      for (const h of history) {
        // Collect candidates from both messageAdded and labelsAdded events
        const candidates = [
          ...(h.messagesAdded || []).map(a => a.message),
          ...(h.labelsAdded || [])
            .filter(a => a.labelIds?.includes('INBOX'))
            .map(a => a.message),
        ];

        for (const msg of candidates) {
          const msgId = msg.id;
          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);

          try {
            // Early dedup: skip messages already in DB
            const existing = await query(
              `SELECT 1 FROM inbox.messages WHERE provider_msg_id = $1`,
              [msgId]
            );
            if (existing.rows.length > 0) continue;

            const metadata = await fetchEmailMetadata(msgId, accountId);

            // Client-side INBOX filter: only process messages currently in inbox
            if (!metadata.labels?.includes('INBOX')) continue;

            newMessages.push(metadata);
          } catch (err) {
            console.error(`[poller] Failed to fetch ${msgId}:`, err.message);
          }
        }
      }

      // Update sync state
      const newHistoryId = historyResult.data.historyId || historyId;
      await query(
        `UPDATE inbox.sync_state
         SET history_id = $1, messages_synced = messages_synced + $2, last_poll_at = now(), updated_at = now()
         WHERE account_id = $3`,
        [newHistoryId, newMessages.length, syncKey]
      );
    } catch (err) {
      if (err.code === 404) {
        // History expired — delete sync state so next poll does a full sync
        console.warn('[poller] History ID expired. Will do full sync on next poll.');
        await query(
          `DELETE FROM inbox.sync_state WHERE account_id = $1`,
          [syncKey]
        );
      } else {
        throw err;
      }
    }
  }

  console.log(`[poller] ${accountId ? `Account ${accountId}: ` : ''}Found ${newMessages.length} new messages`);
  return newMessages;
}

// Signal types a reply resolves — persistent types (commitment, deadline, approval_needed) need explicit resolution
const REPLY_RESOLVES_TYPES = ['request', 'question', 'info', 'introduction', 'decision', 'action_item'];

/**
 * Reconcile signals against Gmail state: detect user replies and archives.
 * Cheap query — only checks messages with unresolved signals from the last 30 days.
 * @param {string} accountId - Account ID to reconcile
 */
async function reconcileSignals(accountId) {
  // Find messages with unresolved signals (last 30 days only)
  const unresolvedResult = await query(
    `SELECT DISTINCT m.id AS message_id, m.thread_id, m.provider_msg_id, m.account_id
     FROM inbox.signals s
     JOIN inbox.messages m ON s.message_id = m.id
     WHERE s.resolved = false
       AND m.channel = 'email'
       AND m.account_id = $1
       AND s.created_at >= now() - interval '30 days'`,
    [accountId]
  );

  if (unresolvedResult.rows.length === 0) return;

  // Get owned email addresses for this account
  const ownedResult = await query(
    `SELECT LOWER(identifier) AS email FROM inbox.accounts WHERE id = $1`,
    [accountId]
  );
  const ownedEmails = ownedResult.rows.map(r => r.email);

  for (const row of unresolvedResult.rows) {
    try {
      // 1. Check for user reply in thread — query local DB (no API call)
      if (row.thread_id) {
        const replyResult = await query(
          `SELECT 1 FROM inbox.messages
           WHERE thread_id = $1
             AND id != $2
             AND LOWER(from_address) = ANY($3)
             AND received_at > (SELECT received_at FROM inbox.messages WHERE id = $2)
           LIMIT 1`,
          [row.thread_id, row.message_id, ownedEmails]
        );
        if (replyResult.rows.length > 0) {
          await resolveSignalsByMessage(row.message_id, 'gmail_reply_detected', { onlyTypes: REPLY_RESOLVES_TYPES });
          continue; // Reply found — skip label check for this message
        }
      }

      // 2. Check for archive via Gmail API (format: 'minimal' — cheapest call)
      if (row.provider_msg_id && !row.provider_msg_id.startsWith('demo_') && !row.provider_msg_id.startsWith('test_')) {
        const labels = await fetchMessageLabels(row.provider_msg_id, row.account_id);
        if (!labels.includes('INBOX')) {
          // Message was archived in Gmail — resolve all signals
          await resolveSignalsByMessage(row.message_id, 'gmail_archived');
          await query(
            `UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
            [row.message_id]
          );
        }
      }
    } catch (err) {
      // Non-fatal — log and continue to next message
      console.error(`[poller] reconcileSignals: error on message ${row.message_id}:`, err.message);
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

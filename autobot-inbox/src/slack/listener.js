import { query } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { getUserInfo, sendMessage } from './client.js';
import { parseCommand, executeCommand } from '../commands/board-commands.js';
import { handleBoardQuery } from '../commands/board-query.js';

/**
 * Slack inbound message handler.
 * Pre-filter at ingestion (Liotta #3): only DMs and @mentions create work items.
 * Bot messages, file_share, channel_join, etc. are ignored — no LLM cost.
 */

// Subtypes to ignore — these never create work items
const IGNORED_SUBTYPES = new Set([
  'bot_message', 'bot_add', 'bot_remove',
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name',
  'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name',
  'file_share', 'file_comment', 'file_mention',
  'pinned_item', 'unpinned_item',
  'message_changed', 'message_deleted',
  'ekm_access_denied', 'me_message',
  'thread_broadcast',
]);

/**
 * Register Slack message listeners on the Bolt app.
 * @param {import('@slack/bolt').App} app - Slack Bolt app instance
 * @param {string} slackAccountId - The inbox.accounts.id for this Slack workspace
 */
export function registerSlackListeners(app, slackAccountId) {
  // Listen for all messages via event (more reliable than app.message in Socket Mode)
  app.event('message', async ({ event, context }) => {
    try {
      await handleMessage(event, context, slackAccountId);
    } catch (err) {
      console.error('[slack-listener] Error handling message:', err.message);
    }
  });

  // Listen for app_mention events (when someone @mentions the bot)
  app.event('app_mention', async ({ event }) => {
    try {
      await handleMention(event, slackAccountId);
    } catch (err) {
      console.error('[slack-listener] Error handling mention:', err.message);
    }
  });

  console.log('[slack-listener] Listeners registered');
}

async function handleMessage(message, context, slackAccountId) {
  // Pre-filter: skip ignored subtypes
  if (message.subtype && IGNORED_SUBTYPES.has(message.subtype)) return;

  // Skip bot messages (no subtype but has bot_id)
  if (message.bot_id) return;

  // Skip messages without text
  if (!message.text) return;

  // Only process DMs (channel type 'im')
  // Channel messages are handled via app_mention only
  if (message.channel_type !== 'im') return;

  // Board commands: parse DMs for approve/reject/resolve/status before ingesting as work items
  const cmd = parseCommand(message.text);
  if (cmd) {
    try {
      const reply = await executeCommand(cmd, { source: 'slack' });
      await sendMessage(message.channel, reply, message.ts);
    } catch (err) {
      await sendMessage(message.channel, `Command failed: ${err.message}`, message.ts);
    }
    return; // Don't ingest commands as work items
  }

  // Not a command — answer conversationally (actions only supported on Telegram)
  const result = await handleBoardQuery(message.text, { source: 'slack', sessionId: `slack:${message.channel}` });
  if (result?.type === 'answer') {
    await sendMessage(message.channel, result.answer, message.ts);
  } else if (result?.type === 'action') {
    await sendMessage(message.channel, `Proposed: ${result.summary} (use Telegram to confirm)`, message.ts);
  } else {
    // Fallback: ingest as work item (no API key, or query failed)
    await ingestSlackMessage({
      channelId: message.channel,
      messageTs: message.ts,
      threadTs: message.thread_ts || null,
      userId: message.user,
      text: message.text,
      slackAccountId,
    });
  }
}

async function handleMention(event, slackAccountId) {
  // Skip bot messages
  if (event.bot_id) return;
  if (!event.text) return;

  await ingestSlackMessage({
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts || null,
    userId: event.user,
    text: event.text,
    slackAccountId,
  });
}

/**
 * Ingest a Slack message into the pipeline.
 * Dedup via (channel, channel_id) unique index.
 */
async function ingestSlackMessage({ channelId, messageTs, threadTs, userId, text, slackAccountId }) {
  const channelIdKey = `${channelId}:${messageTs}`;

  // Dedup check
  const existing = await query(
    `SELECT id FROM inbox.messages WHERE channel = 'slack' AND channel_id = $1`,
    [channelIdKey]
  );
  if (existing.rows.length > 0) return;

  // Look up user display name
  let fromName = userId;
  let fromAddress = userId;
  try {
    const userInfo = await getUserInfo(userId);
    fromName = userInfo.realName || userInfo.name;
    fromAddress = userInfo.email || `${userId}@slack`;
  } catch {
    // Fall back to userId
  }

  // Insert into inbox.messages (Slack messages store body in snippet — they're short, no D1 concern)
  const msgResult = await query(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, thread_id, message_id, from_address, from_name, to_addresses,
      subject, snippet, received_at, labels, has_attachments, in_reply_to,
      channel, account_id, channel_id)
     VALUES (NULL, 'slack', $1, $2, $3, $4, $5, $6, $7, now(), $8, false, $9,
             'slack', $10, $11)
     RETURNING id`,
    [
      threadTs || channelId,           // thread_id: use thread_ts for threaded, channel for top-level
      channelIdKey,                    // message_id (unique ref)
      fromAddress,                     // from_address
      fromName,                        // from_name
      [],                              // to_addresses (Slack messages don't have explicit recipients)
      null,                            // subject (Slack has no subjects)
      text,                            // snippet: store full text (Slack messages are short)
      ['SLACK'],                       // labels
      threadTs || null,                // in_reply_to: thread parent ts
      slackAccountId,                  // account_id
      channelIdKey,                    // channel_id for dedup
    ]
  );

  const messageId = msgResult.rows[0]?.id;
  if (!messageId) return;

  // Create work item → normal pipeline
  const workItem = await createWorkItem({
    type: 'task',
    title: `Process Slack: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`,
    description: `Slack message from ${fromName}`,
    createdBy: 'orchestrator',
    assignedTo: 'orchestrator',
    priority: 0,
    metadata: { email_id: messageId, channel: 'slack', slack_channel: channelId, slack_ts: messageTs },
  });

  if (!workItem) return;

  // Link message to work item
  await query(
    `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
    [workItem.id, messageId]
  );

  console.log(`[slack-listener] New message from ${fromName} → task ${workItem.id}`);
}

import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { createDraft } from './client.js';
import { query } from '../db.js';
import { logCommsIntent, publishEvent } from '../runtime/infrastructure.js';

/**
 * Gmail sender: creates drafts (L0) or sends emails (L1+).
 * D2: In L0, ALWAYS create drafts, never send directly.
 * G5: Reversibility — drafts are reversible, sends are not.
 */

/**
 * Create a Gmail draft for a reviewed+approved draft.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Gmail draft ID
 */
export async function createGmailDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Get the original email for threading
  const emailResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [draft.message_id]);
  const email = emailResult.rows[0];

  const body = draft.board_edited_body || draft.body;
  const to = draft.to_addresses[0];
  const subject = draft.subject || `Re: ${email?.subject || ''}`;

  const gmailDraftId = await createDraft(
    to,
    subject,
    body,
    email?.thread_id || null,
    email?.message_id || null,
    draft.account_id || null
  );

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_draft_id = $1, send_state = 'staged', updated_at = now()
     WHERE id = $2`,
    [gmailDraftId, draftId]
  );

  // Shadow log the communication intent (autobot_comms)
  await logCommsIntent({ channel: 'email', recipient: to, subject, body, intentType: 'draft', sourceAgent: 'executor-responder', sourceTask: draftId });
  await publishEvent('draft_created', `Gmail draft created for ${draftId}`, null, null, { draft_id: draftId });

  console.log(`[sender] Gmail draft created: ${gmailDraftId} for draft ${draftId}`);
  return gmailDraftId;
}

/**
 * Send a Gmail draft (L1+ only, for auto-send after autonomy checks).
 * @param {string} draftId - Database draft ID
 */
export async function sendDraft(draftId) {
  const level = parseInt(process.env.AUTONOMY_LEVEL || '0', 10);
  if (level < 1) {
    throw new Error('sendDraft() requires autonomy level >= 1 (L1). Current: L0. Use sendApprovedDraft() for board-approved drafts.');
  }

  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft?.provider_draft_id) throw new Error(`No Gmail draft for ${draftId}`);

  const auth = draft.account_id ? await getAuthForAccount(draft.account_id) : getAuth();
  const gmailClient = google.gmail({ version: 'v1', auth });

  const sendResult = await gmailClient.users.drafts.send({
    userId: 'me',
    requestBody: { id: draft.provider_draft_id },
  });

  await query(
    `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
     WHERE id = $2`,
    [sendResult.data.id, draftId]
  );

  console.log(`[sender] Email sent: ${sendResult.data.id} for draft ${draftId}`);
  return sendResult.data.id;
}

/**
 * Send a board-approved draft. Board approval IS the L0 human check,
 * so this works at any autonomy level.
 * Flow: verify board_action → create Gmail draft if needed → send → update state.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Gmail sent message ID
 */
export async function sendApprovedDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Verify board has approved
  if (!draft.board_action || !['approved', 'edited', 'auto_approved'].includes(draft.board_action)) {
    throw new Error(`Draft ${draftId} has not been board-approved (board_action: ${draft.board_action})`);
  }

  // Already sent
  if (draft.provider_sent_id) {
    throw new Error(`Draft ${draftId} has already been sent (${draft.provider_sent_id})`);
  }

  // Create Gmail draft if not already created
  let gmailDraftId = draft.provider_draft_id;
  if (!gmailDraftId) {
    gmailDraftId = await createGmailDraft(draftId);
  }

  // Send the Gmail draft (from the correct account)
  const auth = draft.account_id ? await getAuthForAccount(draft.account_id) : getAuth();
  const gmailClient = google.gmail({ version: 'v1', auth });
  const sendResult = await gmailClient.users.drafts.send({
    userId: 'me',
    requestBody: { id: gmailDraftId },
  });

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
     WHERE id = $2`,
    [sendResult.data.id, draftId]
  );

  await publishEvent('draft_sent', `Email sent: ${sendResult.data.id} for draft ${draftId}`, null, null, { draft_id: draftId, provider_sent_id: sendResult.data.id });
  await logCommsIntent({ channel: 'email', recipient: draft.to_addresses?.[0] || 'unknown', subject: draft.subject, body: draft.board_edited_body || draft.body, intentType: 'send', sourceTask: draftId });

  console.log(`[sender] Board-approved email sent: ${sendResult.data.id} for draft ${draftId}`);
  return sendResult.data.id;
}

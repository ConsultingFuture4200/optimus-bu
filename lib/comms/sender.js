import { query } from '../db.js';

/**
 * Provider-aware sender dispatcher.
 * Single module that routes approve/send calls to the correct provider module.
 * Dispatch routes on provider (API implementation), not channel (medium).
 */

const SENDERS = {
  gmail: {
    createDraft: () => import('../../autobot-inbox/src/gmail/sender.js').then(m => m.createGmailDraft),
    send: () => import('../../autobot-inbox/src/gmail/sender.js').then(m => m.sendApprovedDraft),
  },
  outlook: {
    createDraft: () => import('../../autobot-inbox/src/outlook/sender.js').then(m => m.createOutlookDraft),
    send: () => import('../../autobot-inbox/src/outlook/sender.js').then(m => m.sendApprovedOutlookDraft),
  },
  slack: {
    createDraft: null, // Slack has no draft concept — messages send directly
    send: () => import('../../autobot-inbox/src/slack/sender.js').then(m => m.sendSlackDraft),
  },
};

/**
 * Look up the provider for a draft.
 * @param {string} draftId
 * @returns {Promise<{provider: string, draft: Object}>}
 */
async function getDraftProvider(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);
  return { provider: draft.provider || 'gmail', draft };
}

/**
 * Create a platform-specific draft (e.g., Gmail draft).
 * For Slack, this is a no-op (Slack has no draft concept).
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string|null>} Platform draft ID or null
 */
export async function createDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  const sender = SENDERS[provider];
  if (!sender) throw new Error(`No sender configured for provider: ${provider}`);

  if (!sender.createDraft) {
    // Provider doesn't support drafts (e.g., Slack) — skip
    return null;
  }

  const fn = await sender.createDraft();
  return fn(draftId);
}

/**
 * Send an approved draft through the appropriate provider.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Platform-specific sent ID
 */
export async function sendDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  const sender = SENDERS[provider];
  if (!sender?.send) throw new Error(`No send handler for provider: ${provider}`);

  const fn = await sender.send();
  return fn(draftId);
}

/**
 * Approve and optionally create a platform draft.
 * For email: creates Gmail draft. For Slack: no-op.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<{draftId: string, platformDraftId: string|null, provider: string}>}
 */
export async function approveDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  let platformDraftId = null;

  try {
    platformDraftId = await createDraft(draftId);
  } catch (err) {
    console.error(`[sender] Failed to create platform draft for ${draftId}:`, err.message);
  }

  return { draftId, platformDraftId, provider };
}

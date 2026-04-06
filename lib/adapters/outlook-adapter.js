import { fetchOutlookBody } from '../../autobot-inbox/src/outlook/client.js';
import { createOutlookDraft, sendApprovedOutlookDraft } from '../../autobot-inbox/src/outlook/sender.js';

/**
 * Create an Outlook adapter implementing InputAdapter + OutputAdapter.
 * Delegates to outlook/client.js and outlook/sender.js modules.
 * Channel is 'email' (same medium as Gmail), provider is 'outlook'.
 * @param {Object} [deps] - Optional dependency overrides (for testing)
 * @param {Function} [deps.fetchOutlookBody]
 * @param {Function} [deps.createOutlookDraft]
 * @param {Function} [deps.sendApprovedOutlookDraft]
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createOutlookAdapter(deps = {}) {
  const _fetchOutlookBody = deps.fetchOutlookBody || fetchOutlookBody;
  const _createOutlookDraft = deps.createOutlookDraft || createOutlookDraft;
  const _sendApprovedOutlookDraft = deps.sendApprovedOutlookDraft || sendApprovedOutlookDraft;

  return {
    channel: 'email',

    async fetchContent(message) {
      return _fetchOutlookBody(message.provider_msg_id, message.account_id);
    },

    buildPromptContext(message, body) {
      return {
        channel: 'email',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_email',
        contentType: 'email',
        sender: {
          name: message.from_name || '',
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: message.in_reply_to || null,
          subject: message.subject || null,
          toAddresses: message.to_addresses || [],
          ccAddresses: message.cc_addresses || [],
        },
        channelHint: '',
      };
    },

    async createDraft(draftId) {
      return _createOutlookDraft(draftId);
    },

    async executeDraft(draftId) {
      return _sendApprovedOutlookDraft(draftId);
    },
  };
}

import { fetchEmailBody } from '../../autobot-inbox/src/gmail/client.js';
import { createGmailDraft, sendApprovedDraft } from '../../autobot-inbox/src/gmail/sender.js';

/**
 * Create an email adapter implementing InputAdapter + OutputAdapter.
 * Delegates to existing gmail/client.js and gmail/sender.js modules.
 * @param {Object} [deps] - Optional dependency overrides (for testing)
 * @param {Function} [deps.fetchEmailBody]
 * @param {Function} [deps.createGmailDraft]
 * @param {Function} [deps.sendApprovedDraft]
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createEmailAdapter(deps = {}) {
  const _fetchEmailBody = deps.fetchEmailBody || fetchEmailBody;
  const _createGmailDraft = deps.createGmailDraft || createGmailDraft;
  const _sendApprovedDraft = deps.sendApprovedDraft || sendApprovedDraft;

  return {
    channel: 'email',

    async fetchContent(message) {
      return _fetchEmailBody(message.provider_msg_id, message.account_id);
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
      return _createGmailDraft(draftId);
    },

    async executeDraft(draftId) {
      return _sendApprovedDraft(draftId);
    },
  };
}

import { sendSlackDraft } from '../../autobot-inbox/src/slack/sender.js';

/**
 * Create a Slack adapter implementing InputAdapter + OutputAdapter.
 * Delegates to existing slack/sender.js for output; input is inline
 * since Slack stores full text at ingestion (no on-demand fetch needed).
 * @param {Object} [deps] - Optional dependency overrides (for testing)
 * @param {Function} [deps.sendSlackDraft]
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createSlackAdapter(deps = {}) {
  const _sendSlackDraft = deps.sendSlackDraft || sendSlackDraft;

  return {
    channel: 'slack',

    async fetchContent(message) {
      // Slack stores full text at ingestion — no API call needed
      return message.snippet || null;
    },

    buildPromptContext(message, body) {
      return {
        channel: 'slack',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_message',
        contentType: 'message',
        sender: {
          name: message.from_name || '',
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: message.in_reply_to || null,
          subject: null,
          toAddresses: message.to_addresses || [],
          ccAddresses: [],
        },
        channelHint: '\nCHANNEL: Slack DM/mention. People DM expecting a reply — bias toward "needs_response" unless clearly informational.',
      };
    },

    async createDraft(_draftId) {
      // Slack has no draft concept
      return null;
    },

    async executeDraft(draftId) {
      return _sendSlackDraft(draftId);
    },
  };
}

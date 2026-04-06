import { readFileSync } from 'fs';

const webhookSources = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/webhook-sources.json', import.meta.url), 'utf-8')
);

/**
 * Create a webhook adapter implementing InputAdapter.
 * Input-only — webhooks are inbound, no OutputAdapter needed.
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function createWebhookAdapter() {
  return {
    channel: 'webhook',

    async fetchContent(message) {
      // Webhook stores body as snippet at ingestion (same as Slack pattern)
      return message.snippet || null;
    },

    buildPromptContext(message, body) {
      // Resolve source from labels (e.g. 'webhook:tldv' → 'tldv').
      // Labels are always present on webhook messages; metadata column doesn't exist.
      const source = (message.labels || [])
        .map(l => l.match?.(/^webhook:(.+)$/)?.[1])
        .find(Boolean) || 'generic';
      const sourceConfig = webhookSources.sources[source] || webhookSources.sources.generic;

      return {
        channel: 'webhook',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_webhook',
        contentType: 'webhook',
        sender: {
          name: message.from_name || source,
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: null,
          subject: message.subject || null,
          toAddresses: [],
          ccAddresses: [],
        },
        channelHint: `\n${sourceConfig.channelHint}`,
      };
    },
  };
}

/**
 * Transcript Action Extractor: post-processing for tl;dv/transcript work items.
 *
 * Triggered when executor-triage completes on a transcript message
 * (detected via 'webhook:tldv' label in work_item metadata).
 *
 * Key insight: executor-triage + the tl;dv channelHint already extracts signals
 * (commitments, deadlines, action_items). This module promotes high-confidence
 * inbound signals to intents:
 *
 * - action_item/commitment with direction='inbound' → create intent (Tier 2)
 * - action_item with direction='outbound' → signal-only (briefing: "You asked X to do Y")
 * - Participant names → fuzzy-match to signal.contacts
 *
 * P1: Deny by default — only processes work items with webhook:tldv source.
 * P3: Transparency by structure — signals and intents are logged.
 * P4: Boring infrastructure — raw SQL.
 */

import { query } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';

/**
 * Extract and promote action items from a completed transcript triage.
 *
 * @param {number} messageId - The inbox.messages ID of the transcript
 * @returns {{ intentsCreated: number, signalsFound: number }}
 */
export async function extractTranscriptActions(messageId) {
  if (!messageId) {
    console.warn('[action-extractor] No messageId provided');
    return { intentsCreated: 0, signalsFound: 0 };
  }

  // Fetch signals extracted by executor-triage for this message
  const signalResult = await query(
    `SELECT s.id, s.signal_type, s.content, s.direction, s.confidence, s.domain,
            m.from_name, m.subject, m.labels
     FROM inbox.signals s
     JOIN inbox.messages m ON m.id = s.message_id
     WHERE s.message_id = $1
       AND s.signal_type IN ('action_item', 'commitment', 'deadline', 'request')
     ORDER BY s.confidence DESC`,
    [messageId]
  );

  const signals = signalResult.rows;
  if (signals.length === 0) {
    console.log(`[action-extractor] No actionable signals found for message ${messageId}`);
    return { intentsCreated: 0, signalsFound: 0 };
  }

  console.log(`[action-extractor] Found ${signals.length} actionable signal(s) for message ${messageId}`);

  let intentsCreated = 0;

  for (const signal of signals) {
    // Only promote high-confidence inbound signals to intents
    if (signal.direction === 'inbound' && signal.confidence >= 0.7) {
      const isUrgent = signal.signal_type === 'deadline' || signal.signal_type === 'commitment';

      const intent = await createIntent({
        agentId: 'orchestrator',
        intentType: 'task',
        decisionTier: isUrgent ? 'strategic' : 'tactical',
        title: `Transcript action: ${signal.content.slice(0, 100)}`,
        reasoning: `Extracted from transcript "${signal.subject || 'unknown'}". ` +
          `Signal type: ${signal.signal_type}, confidence: ${signal.confidence}. ` +
          `From: ${signal.from_name || 'unknown participant'}.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: `Transcript: ${signal.content.slice(0, 200)}`,
            description: `Action item from transcript: ${signal.content}\n\nSource: ${signal.subject || 'Meeting transcript'}`,
            assigned_to: 'executor-triage',
            priority: isUrgent ? 2 : 1,
            metadata: {
              source_message_id: messageId,
              source_signal_id: signal.id,
              signal_type: signal.signal_type,
              source: 'transcript-action-extractor',
            },
          },
        },
        triggerContext: {
          pattern: `transcript_action_${messageId}_${signal.id}`,
          source: 'transcript-action-extractor',
          message_id: messageId,
          signal_id: signal.id,
          signal_type: signal.signal_type,
        },
        budgetPerFire: 0.10,
      });

      if (intent) {
        intentsCreated++;
        console.log(`[action-extractor] Created intent for: ${signal.content.slice(0, 80)}`);
      }
    } else if (signal.direction === 'outbound') {
      // Outbound = "You asked X to do Y" — already captured as signal, no intent needed
      console.log(`[action-extractor] Outbound action noted (signal-only): ${signal.content.slice(0, 80)}`);
    }
  }

  // Fuzzy-match participant names to signal.contacts (best-effort)
  try {
    await matchParticipantsToContacts(messageId);
  } catch (err) {
    console.warn(`[action-extractor] Contact matching failed (non-fatal): ${err.message}`);
  }

  console.log(`[action-extractor] Done: ${intentsCreated} intent(s) created from ${signals.length} signal(s)`);
  return { intentsCreated, signalsFound: signals.length };
}

/**
 * Match transcript participant names to existing contacts.
 * Creates new contacts for unknown participants as 'meeting_participant' type.
 */
async function matchParticipantsToContacts(messageId) {
  // Get the from_name from the message (usually the meeting organizer/service)
  const msgResult = await query(
    `SELECT from_name, from_address FROM inbox.messages WHERE id = $1`,
    [messageId]
  );
  const msg = msgResult.rows[0];
  if (!msg) return;

  // Get all signal contents that mention people (action_items often have "assigned to X" patterns)
  const signalResult = await query(
    `SELECT content, direction FROM inbox.signals
     WHERE message_id = $1 AND signal_type IN ('action_item', 'commitment')`,
    [messageId]
  );

  // Extract potential participant names from signal content
  // Simple heuristic: look for "Name:" or "assigned to Name" patterns
  const namePatterns = /(?:assigned to|from|by|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  const mentionedNames = new Set();

  for (const sig of signalResult.rows) {
    let match;
    while ((match = namePatterns.exec(sig.content)) !== null) {
      mentionedNames.add(match[1].trim());
    }
  }

  // For each mentioned name, check if contact exists, create if not
  for (const name of mentionedNames) {
    try {
      const existing = await query(
        `SELECT id FROM signal.contacts WHERE name ILIKE $1 LIMIT 1`,
        [name]
      );

      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO signal.contacts (name, contact_type, source)
           VALUES ($1, 'meeting_participant', 'transcript')
           ON CONFLICT DO NOTHING`,
          [name]
        );
        console.log(`[action-extractor] Created contact: ${name} (meeting_participant)`);
      }
    } catch {
      // Contact table schema may differ — non-fatal
    }
  }
}

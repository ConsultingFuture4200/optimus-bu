/**
 * TLDv transcript poller.
 * Ported from brain-rag src/lib/tldv-poll-sync.ts, adapted for Optimus.
 *
 * Polls TLDv API for latest meetings, fetches transcripts, and feeds them
 * into the document ingestion pipeline. Runs via scheduleService().
 *
 * Replaces brain-rag's BullMQ cron job (Railway 5-min minimum) with
 * Optimus's scheduleService (configurable interval, no external deps).
 *
 * Env vars:
 *   TLDV_API_KEY           — Required
 *   TLDV_POLL_INTERVAL_MS  — Poll interval (default: 5 min)
 */

import { createHash } from 'crypto';
import { query } from '../db.js';
import { fetchMeetingsPage, fetchTranscript } from './api.js';
import { ingestDocument } from '../rag/ingest.js';

const TLDV_API_KEY = process.env.TLDV_API_KEY || '';

/**
 * Hash transcript content for change detection.
 * Skip re-ingestion if transcript hasn't changed.
 */
function hashTranscript(segments) {
  const content = segments.map(s => `${s.speaker || ''}:${s.text || ''}`).join('|');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Poll TLDv for the latest meeting and ingest its transcript.
 * Called by scheduleService in index.js.
 *
 * @returns {Promise<{ scanned: number, ingested: number, skipped: number, errors: number }>}
 */
export async function pollTldvTranscripts() {
  if (!TLDV_API_KEY) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };

  try {
    // Fetch latest page of meetings (newest first)
    const list = await fetchMeetingsPage(TLDV_API_KEY, 1, 5);
    if (!list.ok) {
      console.warn(`[tldv] Failed to fetch meetings: ${list.status} ${list.body?.slice(0, 100)}`);
      stats.errors++;
      return stats;
    }

    const meetings = list.page?.results || [];
    stats.scanned = meetings.length;

    for (const meeting of meetings) {
      const meetingId = meeting.id;
      if (!meetingId) continue;

      // Check if already ingested (dedup by tldv meeting ID)
      const existing = await query(
        `SELECT id FROM content.documents WHERE source = 'tldv' AND source_id = $1`,
        [meetingId]
      );
      if (existing.rows.length > 0) {
        stats.skipped++;
        continue;
      }

      // Fetch transcript
      const tr = await fetchTranscript(TLDV_API_KEY, meetingId);
      if (!tr.ok) {
        if (tr.status === 404) {
          // Transcript not ready yet — skip silently
          stats.skipped++;
          continue;
        }
        console.warn(`[tldv] Transcript failed for ${meetingId}: ${tr.status}`);
        stats.errors++;
        continue;
      }

      const segments = tr.transcript?.data || [];
      if (segments.length === 0) {
        stats.skipped++;
        continue;
      }

      // Build raw text from segments (TLDv format for normalizer)
      const rawText = segments.map(s => {
        const speaker = s.speaker || 'Unknown';
        const time = s.startTime != null ? formatTime(s.startTime) : '00:00';
        return `[${time}](https://tldv.io/e/${meetingId}) ${speaker}: ${s.text}`;
      }).join('\n');

      const contentHash = hashTranscript(segments);
      const title = meeting.name || `TLDv meeting ${meetingId}`;

      // Ingest into document pipeline
      const result = await ingestDocument({
        source: 'tldv',
        sourceId: meetingId,
        title,
        rawText,
        format: 'tldv',
        metadata: {
          tldvMeetingId: meetingId,
          happenedAt: meeting.happenedAt,
          url: meeting.url,
          contentHash,
          segmentCount: segments.length,
        },
      });

      if (result && result.chunkCount > 0) {
        console.log(`[tldv] Ingested: "${title}" (${result.chunkCount} chunks, embedded=${result.embedded})`);
        stats.ingested++;
      } else {
        stats.skipped++;
      }
    }
  } catch (err) {
    console.error(`[tldv] Poll error: ${err.message}`);
    stats.errors++;
  }

  if (stats.ingested > 0 || stats.errors > 0) {
    console.log(`[tldv] Poll complete: scanned=${stats.scanned} ingested=${stats.ingested} skipped=${stats.skipped} errors=${stats.errors}`);
  }

  return stats;
}

/** Format seconds to MM:SS */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

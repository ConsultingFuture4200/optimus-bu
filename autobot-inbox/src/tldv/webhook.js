/**
 * TLDv webhook handler.
 * Receives "Transcript Ready" events from TLDv and feeds transcripts
 * into the document ingestion pipeline.
 *
 * Auth: query param ?secret= must match TLDV_WEBHOOK_SECRET env var.
 * URL to configure in TLDv: https://preview.staqs.io/api/webhooks/tldv?secret=YOUR_SECRET
 *
 * Env vars:
 *   TLDV_WEBHOOK_SECRET — Required for webhook auth
 */

import { timingSafeEqual } from 'crypto';
import { ingestDocument } from '../rag/ingest.js';

/**
 * Handle incoming TLDv webhook.
 * @param {import('http').IncomingMessage} req
 * @param {Object} body - Parsed JSON body
 * @param {URL} url - Parsed request URL
 * @returns {Promise<Object>}
 */
export async function handleTldvWebhook(req, body, url) {
  // Auth: verify secret query param
  const secret = url.searchParams.get('secret');
  const expected = process.env.TLDV_WEBHOOK_SECRET || '';
  if (!expected) {
    console.error('[tldv-webhook] TLDV_WEBHOOK_SECRET not configured');
    throw Object.assign(new Error('Webhook not configured'), { statusCode: 500 });
  }
  if (!secret || !constantTimeEq(secret, expected)) {
    console.warn('[tldv-webhook] Invalid secret');
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }

  // Extract transcript from payload
  // TLDv sends: { event: "TranscriptReady", data: { meetingId, ... } }
  const event = body?.event || body?.type;
  const data = body?.data || body;

  if (!event?.includes?.('Transcript') && !event?.includes?.('transcript')) {
    // Not a transcript event — acknowledge silently
    return { ok: true, message: 'Event ignored', event };
  }

  const meetingId = data?.meetingId || data?.meeting_id || data?.id;
  if (!meetingId) {
    console.warn('[tldv-webhook] No meetingId in payload');
    return { ok: false, error: 'Missing meetingId' };
  }

  // Extract segments from various payload shapes
  const segments = extractSegments(data);
  if (segments.length === 0) {
    console.warn(`[tldv-webhook] No transcript segments for meeting ${meetingId}`);
    return { ok: false, error: 'No transcript segments' };
  }

  // Build raw text in TLDv format for the normalizer
  const rawText = segments.map(s => {
    const speaker = s.speaker || 'Unknown';
    const time = s.startTime != null ? formatTime(s.startTime) : '00:00';
    return `[${time}](https://tldv.io/e/${meetingId}) ${speaker}: ${s.text}`;
  }).join('\n');

  const title = data?.name || data?.meetingName || `TLDv meeting ${meetingId}`;

  // Ingest into document pipeline
  const result = await ingestDocument({
    source: 'tldv',
    sourceId: meetingId,
    title,
    rawText,
    format: 'tldv',
    metadata: {
      tldvMeetingId: meetingId,
      happenedAt: data?.happenedAt || data?.created_at,
      url: data?.url,
      segmentCount: segments.length,
      ingestSource: 'webhook',
    },
  });

  if (result) {
    console.log(`[tldv-webhook] Ingested "${title}": ${result.chunkCount} chunks`);
  }

  return { ok: true, meetingId, chunks: result?.chunkCount || 0, embedded: result?.embedded || false };
}

/**
 * Extract segments from various TLDv payload shapes.
 * Brain-rag handled 4 shapes — we do the same.
 */
function extractSegments(data) {
  // Shape 1: data.data = array of segments
  if (Array.isArray(data?.data)) {
    return data.data.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 2: data.data.segments = array
  if (Array.isArray(data?.data?.segments)) {
    return data.data.segments.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 3: data.segments = array
  if (Array.isArray(data?.segments)) {
    return data.segments.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 4: data.transcript = string (full text, no segments)
  if (typeof data?.transcript === 'string' && data.transcript.trim()) {
    return [{ speaker: undefined, text: data.transcript, startTime: undefined }];
  }
  return [];
}

function mapSegment(s) {
  return {
    speaker: s.speaker || s.speakerName,
    text: s.text || s.content || '',
    startTime: s.startTime ?? s.start_time,
    endTime: s.endTime ?? s.end_time,
  };
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function constantTimeEq(a, b) {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

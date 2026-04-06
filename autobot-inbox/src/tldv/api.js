/**
 * TLDv public API client.
 * Ported from brain-rag src/lib/tldv-api.ts
 *
 * Auth: x-api-key header
 * Docs: https://doc.tldv.io/
 *
 * Env vars:
 *   TLDV_API_KEY      — Required for TLDv polling
 *   TLDV_API_BASE_URL — Override base URL (default: https://pasta.tldv.io)
 */

const DEFAULT_BASE = 'https://pasta.tldv.io';

function getBaseUrl() {
  return (process.env.TLDV_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

async function tldvFetch(apiKey, path) {
  const url = `${getBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
}

/**
 * Fetch paginated meetings list. TLDv uses 1-based pages.
 * @param {string} apiKey
 * @param {number} page - 1-based page index
 * @param {number} pageSize
 * @returns {Promise<{ ok: true, page: { page: number, pages: number, total: number, results: Array } } | { ok: false, status: number, body: string }>}
 */
export async function fetchMeetingsPage(apiKey, page = 1, pageSize = 10) {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const result = await tldvFetch(apiKey, `/v1alpha1/meetings?${qs}`);
  if (!result.ok) return result;
  return { ok: true, page: result.data };
}

/**
 * Fetch transcript for a meeting. Returns 404 if not ready yet.
 * @param {string} apiKey
 * @param {string} meetingId
 * @returns {Promise<{ ok: true, transcript: { data: Array<{ speaker?: string, text: string, startTime?: number, endTime?: number }> } } | { ok: false, status: number, body: string }>}
 */
export async function fetchTranscript(apiKey, meetingId) {
  const result = await tldvFetch(apiKey, `/v1alpha1/meetings/${encodeURIComponent(meetingId)}/transcript`);
  if (!result.ok) return result;
  return { ok: true, transcript: result.data };
}

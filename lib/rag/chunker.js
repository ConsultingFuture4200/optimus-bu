/**
 * Document chunker.
 * Ported from brain-rag src/lib/chunking.ts, adapted for Optimus.
 *
 * Two strategies:
 *   - chunkSegments(): Merges normalized segments (transcripts with speaker turns)
 *   - chunkByWindow(): Sliding window for unstructured text (PDFs, docs)
 *
 * Config via env vars (same as brain-rag):
 *   MIN_CHUNK_TOKENS (default 256)
 *   MAX_CHUNK_TOKENS (default 512)
 *   OVERLAP_TOKENS   (default 50)
 */

const DEFAULT_MIN = parseInt(process.env.MIN_CHUNK_TOKENS || '256', 10);
const DEFAULT_MAX = parseInt(process.env.MAX_CHUNK_TOKENS || '512', 10);
const DEFAULT_OVERLAP = parseInt(process.env.OVERLAP_TOKENS || '50', 10);
const CHARS_PER_TOKEN = 4; // Rough estimate (~4 chars per token for English)

/** Rough token count. Same heuristic as brain-rag. */
export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Merge normalized segments into chunks of target token size.
 * Preserves speaker and timestamp metadata from transcript segments.
 *
 * @param {import('./normalizers/types.js').NormalizedSegment[]} segments
 * @param {Object} [options]
 * @param {number} [options.minChunkTokens]
 * @param {number} [options.maxChunkTokens]
 * @param {number} [options.overlapTokens]
 * @returns {{ content: string, metadata: { speakers?: string[], start_timestamp?: string, end_timestamp?: string }, tokenCount: number }[]}
 */
export function chunkSegments(segments, options = {}) {
  const minTokens = options.minChunkTokens ?? DEFAULT_MIN;
  const maxTokens = options.maxChunkTokens ?? DEFAULT_MAX;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP;
  const chunks = [];

  let currentSegments = [];
  let currentTokens = 0;
  let currentSpeakers = new Set();
  let startTimestamp;
  let endTimestamp;

  const finalizeChunk = () => {
    if (currentSegments.length === 0) return;
    const content = currentSegments.map(s => s.content).join(' ').trim();
    chunks.push({
      content,
      metadata: {
        speakers: Array.from(currentSpeakers),
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
      },
      tokenCount: estimateTokens(content),
    });
  };

  const seedFromOverlapTail = () => {
    currentSegments = [];
    currentTokens = 0;
    currentSpeakers = new Set();
    startTimestamp = undefined;
    endTimestamp = undefined;

    if (overlapTokens <= 0 || chunks.length === 0) return;
    const lastChunkContent = chunks[chunks.length - 1].content;
    if (!lastChunkContent) return;

    const words = lastChunkContent.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    const overlapCharsTarget = overlapTokens * CHARS_PER_TOKEN;
    let collected = '';
    for (let i = words.length - 1; i >= 0; i--) {
      const candidate = words[i] + (collected ? ` ${collected}` : '');
      if (candidate.length > overlapCharsTarget && collected.length > 0) break;
      collected = candidate;
      if (candidate.length >= overlapCharsTarget) break;
    }
    if (!collected) return;

    currentSegments.push({ content: collected, tokens: estimateTokens(collected) });
    currentTokens = currentSegments[0].tokens;
  };

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.content);
    const speaker = seg.metadata?.speaker;
    const timestamp = seg.metadata?.timestamp;

    if (
      currentTokens + segTokens > maxTokens &&
      currentSegments.length > 0 &&
      currentTokens >= minTokens
    ) {
      finalizeChunk();
      seedFromOverlapTail();
    }

    currentSegments.push({ content: seg.content, tokens: segTokens, metadata: seg.metadata });
    currentTokens += segTokens;
    if (speaker) currentSpeakers.add(speaker);
    if (timestamp) {
      if (!startTimestamp) startTimestamp = timestamp;
      endTimestamp = timestamp;
    }
  }

  finalizeChunk();
  return chunks;
}

/**
 * Sliding window chunker for unstructured text (PDFs, docs, plain text).
 *
 * @param {string[]} paragraphs - Array of paragraph strings
 * @param {Object} [options]
 * @param {number} [options.maxChunkTokens]
 * @param {number} [options.overlapTokens]
 * @returns {{ content: string, metadata: {}, tokenCount: number }[]}
 */
export function chunkByWindow(paragraphs, options = {}) {
  const maxTokens = options.maxChunkTokens ?? DEFAULT_MAX;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP;
  const chunks = [];
  const fullText = paragraphs.join('\n\n');
  const chunkChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  let start = 0;

  while (start < fullText.length) {
    let end = Math.min(start + chunkChars, fullText.length);
    // Break at word boundary
    if (end < fullText.length) {
      const lastSpace = fullText.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }
    const slice = fullText.slice(start, end).trim();
    if (slice) {
      chunks.push({
        content: slice,
        metadata: {},
        tokenCount: estimateTokens(slice),
      });
    }
    const nextStart = end - overlapChars;
    // Prevent infinite loop: always advance at least 1 char
    start = nextStart > start ? nextStart : end;
    if (start >= fullText.length) break;
  }

  return chunks;
}

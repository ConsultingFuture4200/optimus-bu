"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { opsPost, opsFetch } from "@/lib/ops-api";

interface Citation {
  text: string;
  similarity: number;
  documentId: string;
  metadata: Record<string, unknown>;
}

interface SearchResult {
  answer: string | null;
  citations?: Citation[];
  chunks?: Array<{ text: string; similarity: number; documentId: string; metadata: Record<string, unknown> }>;
  tokens?: { input: number; output: number };
  error?: string;
  message?: string;
}

interface SearchStats {
  documents: number;
  embeddedChunks: number;
  ready: boolean;
}

export default function SearchPage() {
  const { status } = useSession({ required: true });
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [stats, setStats] = useState<SearchStats | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    opsFetch<SearchStats>("/api/search/stats").then(setStats);
    inputRef.current?.focus();
  }, []);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setResult(null);

    const res = await opsPost<SearchResult>("/api/search", {
      query: query.trim(),
      raw: showRaw,
    });

    if (res.ok) {
      setResult(res.data);
    } else {
      setResult({ answer: null, error: res.error });
    }
    setLoading(false);
  }

  if (status === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
        <div className="h-8 w-48 bg-surface-raised animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Search Knowledge Base</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Ask questions across meeting transcripts, emails, and documents.
          {stats?.ready && (
            <span className="ml-2 text-zinc-600">
              {stats.documents} documents, {stats.embeddedChunks.toLocaleString()} chunks indexed
            </span>
          )}
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} className="mb-8">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What was discussed in the last Altitude Guitar meeting?"
            className="flex-1 bg-surface-raised border border-white/10 rounded-lg px-4 py-3 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent-bright/50 focus:border-accent-bright/50"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-6 py-3 bg-accent-bright text-white rounded-lg font-medium hover:bg-accent-bright/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "..." : "Search"}
          </button>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => setShowRaw(e.target.checked)}
              className="rounded border-zinc-600"
            />
            Show raw chunks (debug)
          </label>
        </div>
      </form>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          <div className="h-4 w-3/4 bg-surface-raised animate-pulse rounded" />
          <div className="h-4 w-1/2 bg-surface-raised animate-pulse rounded" />
          <div className="h-4 w-5/6 bg-surface-raised animate-pulse rounded" />
        </div>
      )}

      {/* Synthesized answer */}
      {result?.answer && !showRaw && (
        <div className="mb-6">
          <div className="bg-surface-raised rounded-lg border border-white/5 p-5">
            <div className="prose prose-invert prose-sm max-w-none">
              <p className="text-zinc-200 whitespace-pre-wrap leading-relaxed">{result.answer}</p>
            </div>
            {result.tokens && (
              <p className="text-xs text-zinc-600 mt-3">
                {result.tokens.input + result.tokens.output} tokens (~${((result.tokens.input + result.tokens.output) * 0.00000025).toFixed(4)})
              </p>
            )}
          </div>

          {/* Citations */}
          {result.citations && result.citations.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Sources</h3>
              <div className="space-y-2">
                {result.citations.map((cite, i) => (
                  <div key={i} className="bg-surface-raised/50 rounded border border-white/5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-zinc-400 line-clamp-2">{cite.text}</p>
                      <span className="text-xs text-zinc-600 whitespace-nowrap">
                        {(cite.similarity * 100).toFixed(0)}%
                      </span>
                    </div>
                    {Array.isArray(cite.metadata?.speakers) && (
                      <div className="flex gap-1 mt-1">
                        {(cite.metadata.speakers as string[]).map((s, j) => (
                          <span key={j} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                            {String(s)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Raw chunks (debug mode or fallback) */}
      {(showRaw || !result?.answer) && result?.chunks && result.chunks.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">
            {showRaw ? "Raw Chunks" : "Relevant Passages"}
          </h3>
          <div className="space-y-2">
            {result.chunks.map((chunk, i) => (
              <div key={i} className="bg-surface-raised rounded-lg border border-white/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-zinc-300 whitespace-pre-wrap">{chunk.text}</p>
                  <span className="text-xs text-zinc-600 whitespace-nowrap font-mono">
                    {(chunk.similarity * 100).toFixed(1)}%
                  </span>
                </div>
                {Array.isArray(chunk.metadata?.speakers) && (
                  <div className="flex gap-1 mt-2">
                    {(chunk.metadata.speakers as string[]).map((s, j) => (
                      <span key={j} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                        {String(s)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No results */}
      {result && !result.answer && !result.chunks?.length && !result.error && (
        <p className="text-zinc-500 text-sm">{result.message || "No relevant documents found."}</p>
      )}

      {/* Error */}
      {result?.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="text-sm text-red-400">{result.error}</p>
        </div>
      )}

      {/* Empty state */}
      {!stats?.ready && !loading && !result && (
        <div className="text-center py-12">
          <p className="text-zinc-500">Knowledge base is empty or embeddings not configured.</p>
          <p className="text-zinc-600 text-sm mt-1">Go to Knowledge Base to ingest documents.</p>
        </div>
      )}
    </div>
  );
}

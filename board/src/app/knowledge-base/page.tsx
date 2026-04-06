"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import type { OpsPostResult } from "@/lib/ops-api";
import WikiGraph, { type GraphNode, type GraphEdge } from "@/components/WikiGraph";

// --- Interfaces ---

interface Document {
  id: string;
  source: string;
  source_id: string;
  title: string;
  format: string;
  sanitized: boolean;
  threat_count: number;
  token_count: number;
  embedding_model: string;
  created_at: string;
  chunk_count: string;
}

interface DocumentList {
  documents: Document[];
  total: number;
  limit: number;
  offset: number;
}

interface KBStats {
  document_count: string;
  chunk_count: string;
  embedded_chunks: string;
  total_tokens: string;
  source_types: string;
  embeddingProvider: { provider: string; model: string; dimensions: number } | null;
}

interface Account {
  id: string;
  identifier: string;
  is_active: boolean;
}

// --- Source styling ---

const SOURCE_COLORS: Record<string, string> = {
  email: "text-blue-400 bg-blue-500/10",
  tldv: "text-green-400 bg-green-500/10",
  drive: "text-amber-400 bg-amber-500/10",
  upload: "text-purple-400 bg-purple-500/10",
  "brain-rag": "text-zinc-400 bg-zinc-500/10",
  transcript: "text-teal-400 bg-teal-500/10",
  url: "text-cyan-400 bg-cyan-500/10",
  github: "text-rose-400 bg-rose-500/10",
};

function SourceBadge({ source }: { source: string }) {
  const color = SOURCE_COLORS[source] || "text-zinc-400 bg-zinc-500/10";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${color}`}>{source}</span>;
}

// --- Tabs ---

type Tab = "documents" | "search" | "overview" | "wiki" | "graph";

export default function KnowledgeBasePage() {
  const { status } = useSession({ required: true });
  const [tab, setTab] = useState<Tab>("documents");

  if (status === "loading") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="h-8 w-48 bg-surface-raised animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="text-2xl font-bold text-zinc-100 mb-1">Knowledge Base</h1>
      <p className="text-sm text-zinc-500 mb-6">Manage documents, ingestion, and search index</p>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-white/10 mb-6">
        {(["documents", "wiki", "graph", "search", "overview"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "text-accent-bright border-b-2 border-accent-bright -mb-px"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "documents" && <DocumentsTab />}
      {tab === "search" && <SearchTab />}
      {tab === "overview" && <OverviewTab />}
      {tab === "wiki" && <WikiTab />}
      {tab === "graph" && <GraphTab />}
    </div>
  );
}

// --- Documents Tab ---

function DocumentsTab() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [showIngest, setShowIngest] = useState(false);
  const limit = 25;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (filter) params.set("source", filter);
    opsFetch<DocumentList>(`/api/documents?${params}`).then((data) => {
      if (data) {
        setDocs(data.documents);
        setTotal(data.total);
      }
      setLoading(false);
    });
  }, [filter, offset]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1">
          {[null, "email", "tldv", "drive", "upload", "url", "github", "brain-rag"].map((s) => (
            <button
              key={s ?? "all"}
              onClick={() => { setFilter(s); setOffset(0); }}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                filter === s
                  ? "bg-accent-bright/20 text-accent-bright"
                  : "bg-surface-raised text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s ?? "All"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowIngest(true)}
          className="text-xs px-3 py-1.5 bg-accent-bright text-white rounded-lg font-medium hover:bg-accent-bright/90"
        >
          + Ingest
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-surface-raised animate-pulse rounded" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <p className="text-zinc-500 text-sm py-8 text-center">No documents found.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 text-xs border-b border-white/5">
                  <th className="pb-2 pr-3">Title</th>
                  <th className="pb-2 pr-3">Source</th>
                  <th className="pb-2 pr-3 hidden sm:table-cell">Chunks</th>
                  <th className="pb-2 pr-3 hidden sm:table-cell">Tokens</th>
                  <th className="pb-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-b border-white/5 hover:bg-surface-raised/50">
                    <td className="py-2 pr-3 text-zinc-200 max-w-[300px] truncate">{doc.title}</td>
                    <td className="py-2 pr-3"><SourceBadge source={doc.source} /></td>
                    <td className="py-2 pr-3 text-zinc-500 hidden sm:table-cell">{doc.chunk_count}</td>
                    <td className="py-2 pr-3 text-zinc-500 hidden sm:table-cell">{Number(doc.token_count).toLocaleString()}</td>
                    <td className="py-2 text-zinc-600 text-xs">{new Date(doc.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-xs text-zinc-500">
            <span>{total} documents</span>
            <div className="flex gap-2">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className="px-2 py-1 bg-surface-raised rounded disabled:opacity-30"
              >
                Prev
              </button>
              <button
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                className="px-2 py-1 bg-surface-raised rounded disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {/* Ingest Modal */}
      {showIngest && <IngestModal onClose={() => setShowIngest(false)} onComplete={() => { setShowIngest(false); setOffset(0); setFilter(null); }} />}
    </div>
  );
}

// --- Ingest Modal ---

function IngestModal({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const [mode, setMode] = useState<"email" | "paste" | "url" | "github">("email");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteFormat, setPasteFormat] = useState("plain");
  const [urlInput, setUrlInput] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    opsFetch<Account[]>("/api/accounts").then((data) => {
      if (data && Array.isArray(data)) {
        const active = data.filter((a) => a.is_active);
        setAccounts(active);
        if (active.length > 0) setSelectedAccount(active[0].identifier);
      }
    });
  }, []);

  async function handleEmailIngest() {
    if (!selectedAccount) return;
    setSubmitting(true);
    setMessage(null);
    const res = await opsPost<{ ok: boolean; jobId: string; message: string }>("/api/documents/ingest-email", {
      identifier: selectedAccount,
    });
    if (res.ok) {
      setMessage(res.data.message);
    } else {
      setMessage(res.error);
    }
    setSubmitting(false);
  }

  async function handlePasteIngest() {
    if (!pasteTitle || !pasteText) return;
    setSubmitting(true);
    setMessage(null);
    const res = await opsPost<{ documentId: string; chunkCount: number }>("/api/documents/ingest", {
      title: pasteTitle,
      rawText: pasteText,
      format: pasteFormat,
      source: "upload",
    });
    if (res.ok) {
      setMessage(`Ingested: ${res.data.chunkCount} chunks created`);
      setTimeout(onComplete, 1500);
    } else {
      setMessage(res.error);
    }
    setSubmitting(false);
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#0f0f14] border border-white/10 rounded-xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">Ingest Documents</h2>

        {/* Mode tabs */}
        <div className="flex gap-1 mb-4">
          {(["email", "paste", "url", "github"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setMessage(null); }}
              className={`text-xs px-3 py-1.5 rounded capitalize ${
                mode === m ? "bg-accent-bright/20 text-accent-bright" : "bg-surface-raised text-zinc-500"
              }`}
            >
              {m === "email" ? "Email Threads" : m === "paste" ? "Paste / Upload" : m === "url" ? "URL" : "GitHub"}
            </button>
          ))}
        </div>

        {mode === "email" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Gmail Account</label>
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.identifier}>{a.identifier}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleEmailIngest}
              disabled={submitting || !selectedAccount}
              className="w-full py-2 bg-accent-bright text-white rounded-lg text-sm font-medium hover:bg-accent-bright/90 disabled:opacity-40"
            >
              {submitting ? "Starting..." : "Start Email Ingestion"}
            </button>
            <p className="text-[10px] text-zinc-600">Ingests all sent email threads. Runs in background — check logs for progress.</p>
          </div>
        )}

        {mode === "paste" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Title</label>
              <input
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
                placeholder="Meeting notes 2026-03-30"
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Content</label>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste transcript, notes, or any text..."
                rows={8}
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 resize-y"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Format</label>
              <select
                value={pasteFormat}
                onChange={(e) => setPasteFormat(e.target.value)}
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200"
              >
                <option value="plain">Plain text</option>
                <option value="tldv">TLDv transcript</option>
              </select>
            </div>
            <button
              onClick={handlePasteIngest}
              disabled={submitting || !pasteTitle || !pasteText}
              className="w-full py-2 bg-accent-bright text-white rounded-lg text-sm font-medium hover:bg-accent-bright/90 disabled:opacity-40"
            >
              {submitting ? "Ingesting..." : "Ingest"}
            </button>
          </div>
        )}

        {mode === "url" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Web Page URL</label>
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/article"
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600"
              />
            </div>
            <button
              onClick={async () => {
                if (!urlInput.trim()) return;
                setSubmitting(true);
                setMessage(null);
                const res = await opsPost<{ documentId: string; chunkCount: number }>("/api/documents/ingest-url", { url: urlInput.trim() });
                if (res.ok) {
                  setMessage(`Ingested: ${res.data.chunkCount} chunks created`);
                  setTimeout(onComplete, 1500);
                } else {
                  setMessage(res.error || "Failed to ingest URL");
                }
                setSubmitting(false);
              }}
              disabled={submitting || !urlInput.trim()}
              className="w-full py-2 bg-accent-bright text-white rounded-lg text-sm font-medium hover:bg-accent-bright/90 disabled:opacity-40"
            >
              {submitting ? "Fetching..." : "Ingest URL"}
            </button>
            <p className="text-[10px] text-zinc-600">Fetches the page, strips HTML, and ingests the text content.</p>
          </div>
        )}

        {mode === "github" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">GitHub Repository URLs (one per line)</label>
              <textarea
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder={"https://github.com/owner/repo1\nhttps://github.com/owner/repo2\nhttps://github.com/owner/repo3"}
                rows={4}
                className="w-full bg-surface-raised border border-white/10 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 resize-y font-mono"
              />
            </div>
            <button
              onClick={async () => {
                const urls = repoInput.trim().split(/\n+/).map(u => u.trim()).filter(u => u.startsWith('http'));
                if (urls.length === 0) return;
                setSubmitting(true);
                setMessage(null);
                let totalChunks = 0;
                let succeeded = 0;
                let failed = 0;
                for (const url of urls) {
                  const res = await opsPost<{ documentId: string; chunkCount: number }>("/api/documents/ingest-repo", { url });
                  if (res.ok) {
                    totalChunks += res.data.chunkCount || 0;
                    succeeded++;
                  } else {
                    failed++;
                  }
                }
                setMessage(`Ingested ${succeeded}/${urls.length} repos (${totalChunks} chunks)${failed > 0 ? `, ${failed} failed` : ''}`);
                if (succeeded > 0) setTimeout(onComplete, 2000);
                setSubmitting(false);
              }}
              disabled={submitting || !repoInput.trim()}
              className="w-full py-2 bg-accent-bright text-white rounded-lg text-sm font-medium hover:bg-accent-bright/90 disabled:opacity-40"
            >
              {submitting ? "Fetching..." : `Ingest ${repoInput.trim().split(/\n+/).filter(u => u.trim().startsWith('http')).length || 0} Repo(s)`}
            </button>
            <p className="text-[10px] text-zinc-600">Fetches repo metadata and README via GitHub API. One URL per line. Set GITHUB_TOKEN for private repos.</p>
          </div>
        )}

        {message && (
          <div className={`mt-3 text-xs p-2 rounded ${message.includes("error") || message.includes("Error") ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
            {message}
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full py-1.5 text-xs text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>
    </div>
  );
}

// --- Search Tab (raw chunks, admin/debug) ---

function SearchTab() {
  const [query, setQuery] = useState("");
  const [chunks, setChunks] = useState<Array<{ text: string; similarity: number; metadata: Record<string, unknown> }>>([]);
  const [loading, setLoading] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    const res = await opsPost<{ chunks: typeof chunks }>("/api/documents/search", { query: query.trim() });
    if (res.ok) setChunks(res.data.chunks || []);
    setLoading(false);
  }

  return (
    <div>
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Vector similarity search..."
          className="flex-1 bg-surface-raised border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-accent-bright/50"
        />
        <button type="submit" disabled={loading} className="px-4 py-2 bg-surface-raised text-zinc-300 rounded-lg text-sm hover:bg-surface-raised/80 disabled:opacity-40">
          {loading ? "..." : "Search"}
        </button>
      </form>
      <div className="space-y-2">
        {chunks.map((c, i) => (
          <div key={i} className="bg-surface-raised rounded border border-white/5 p-3">
            <div className="flex justify-between gap-3">
              <p className="text-xs text-zinc-300 whitespace-pre-wrap line-clamp-4">{c.text}</p>
              <span className="text-[10px] text-zinc-600 font-mono whitespace-nowrap">{(c.similarity * 100).toFixed(1)}%</span>
            </div>
            {Array.isArray(c.metadata?.speakers) && (
              <div className="flex gap-1 mt-1">
                {(c.metadata.speakers as string[]).map((s, j) => (
                  <span key={j} className="text-[10px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400">{String(s)}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Overview Tab ---

function OverviewTab() {
  const [stats, setStats] = useState<KBStats | null>(null);

  useEffect(() => {
    opsFetch<KBStats>("/api/documents/stats").then(setStats);
  }, []);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-surface-raised animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  const statCards = [
    { label: "Documents", value: Number(stats.document_count).toLocaleString() },
    { label: "Chunks", value: Number(stats.chunk_count).toLocaleString() },
    { label: "Embedded", value: Number(stats.embedded_chunks).toLocaleString() },
    { label: "Total Tokens", value: Number(stats.total_tokens).toLocaleString() },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {statCards.map((s) => (
          <div key={s.label} className="bg-surface-raised rounded-lg border border-white/5 p-4">
            <p className="text-xs text-zinc-500">{s.label}</p>
            <p className="text-xl font-semibold text-zinc-100 mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      {stats.embeddingProvider && (
        <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
          <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Embedding Provider</h3>
          <p className="text-sm text-zinc-300">
            {stats.embeddingProvider.provider} / {stats.embeddingProvider.model} ({stats.embeddingProvider.dimensions} dims)
          </p>
        </div>
      )}
    </div>
  );
}

// ── Wiki Tab ──────────────────────────────────────────────────────────────────

interface WikiArticle {
  id: string;
  title: string;
  classification: string;
  sourceCount: number;
  chunkCount: number;
  wikilinks: string[];
  compiledBy: string;
  createdAt: string;
  updatedAt: string;
}

interface WikiStatus {
  pending: number;
  compiled: number;
  wikiArticles: number;
  none: number;
}

function WikiTab() {
  const [articles, setArticles] = useState<WikiArticle[]>([]);
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [arts, st] = await Promise.all([
      opsFetch<{ articles: WikiArticle[] }>("/api/wiki/articles"),
      opsFetch<WikiStatus>("/api/wiki/status"),
    ]);
    setArticles(arts?.articles || []);
    setStatus(st);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCompile() {
    setCompiling(true);
    // Compile globally (no project scope)
    await opsPost("/api/projects/compile", { slug: "optimus", maxArticles: 10 });
    setCompiling(false);
    await load();
  }

  if (loading) return <div className="py-8 text-center text-zinc-500 text-sm">Loading wiki...</div>;

  return (
    <div className="space-y-4">
      {/* Status bar */}
      {status && (
        <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-300">Wiki Compilation</h3>
            <button
              onClick={handleCompile}
              disabled={compiling || !status || status.pending === 0}
              className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 disabled:opacity-40 transition-colors"
            >
              {compiling ? "Compiling..." : `Compile ${status.pending} Pending`}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div><div className="text-lg font-bold text-amber-300">{status.pending}</div><div className="text-[10px] text-zinc-500">Pending</div></div>
            <div><div className="text-lg font-bold text-emerald-300">{status.compiled}</div><div className="text-[10px] text-zinc-500">Compiled</div></div>
            <div><div className="text-lg font-bold text-blue-300">{status.wikiArticles}</div><div className="text-[10px] text-zinc-500">Articles</div></div>
            <div><div className="text-lg font-bold text-zinc-400">{status.none}</div><div className="text-[10px] text-zinc-500">Untracked</div></div>
          </div>
        </div>
      )}

      {/* Articles */}
      {articles.length === 0 ? (
        <div className="bg-surface-raised rounded-lg border border-white/5 p-8 text-center text-zinc-500 text-sm">
          No wiki articles yet. Compile pending vault documents to get started.
        </div>
      ) : (
        <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <h3 className="text-sm font-medium text-zinc-300">Articles ({articles.length})</h3>
          </div>
          <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
            {articles.map((a) => (
              <div
                key={a.id}
                onClick={() => setSelected(selected === a.id ? null : a.id)}
                className={`px-4 py-3 cursor-pointer transition-colors ${selected === a.id ? "bg-zinc-800" : "hover:bg-white/[.02]"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-200 truncate">{a.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-600">
                      <span>{a.sourceCount} sources</span>
                      <span>{a.chunkCount} chunks</span>
                      <span>by {a.compiledBy}</span>
                    </div>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                    a.classification === "CONFIDENTIAL" ? "bg-red-500/20 text-red-300" : "bg-zinc-700 text-zinc-400"
                  }`}>{a.classification}</span>
                </div>
                {selected === a.id && a.wikilinks.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/5">
                    <div className="text-[10px] text-zinc-500 mb-1">Links to:</div>
                    <div className="flex flex-wrap gap-1">
                      {a.wikilinks.map((link, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/20">
                          [[{link}]]
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Graph Tab ─────────────────────────────────────────────────────────────────

function GraphTab() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    opsFetch<{ nodes: GraphNode[]; edges: GraphEdge[] }>("/api/wiki/graph").then((data) => {
      setNodes(data?.nodes || []);
      setEdges(data?.edges || []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="py-8 text-center text-zinc-500 text-sm">Loading graph...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5">
          <h3 className="text-sm font-medium text-zinc-300">Knowledge Graph</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            All wiki articles, source documents, and their connections
          </p>
        </div>
        <WikiGraph nodes={nodes} edges={edges} height={600} />
      </div>
    </div>
  );
}

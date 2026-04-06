"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import MarkdownEditor from "@/components/ui/MarkdownEditor";
import { useEventStream } from "@/hooks/useEventStream";
import { usePageContext } from "@/contexts/PageContext";

interface Campaign {
  id: string;
  work_item_id: string;
  goal_description: string;
  campaign_status: string;
  campaign_mode: string;
  budget_envelope_usd: string;
  spent_usd: string;
  reserved_usd: string;
  max_iterations: number;
  completed_iterations: number;
  total_iterations: string;
  best_score: string | null;
  work_item_title: string;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface ExplorerDomain {
  domain: string;
  enabled: boolean;
  priority: number;
  runs_7d: string;
  findings_7d: string;
}

interface ExplorerStatus {
  cycles: Array<{
    cycle_id: string;
    domain: string;
    findings_count: number;
    cost_usd: string;
    duration_ms: number;
    error: string | null;
    created_at: string;
  }>;
  domains: ExplorerDomain[];
  today_spend: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-blue-500/20 text-blue-300",
  running: "bg-emerald-500/20 text-emerald-300",
  paused: "bg-zinc-500/20 text-zinc-300",
  plateau_paused: "bg-orange-500/20 text-orange-300",
  awaiting_input: "bg-violet-500/20 text-violet-300",
  succeeded: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-600/20 text-zinc-400",
};

export default function CampaignsPage() {
  const { setCurrentPage } = usePageContext();
  useEffect(() => { setCurrentPage({ route: "/campaigns", title: "Campaigns" }); return () => setCurrentPage(null); }, [setCurrentPage]);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [explorer, setExplorer] = useState<ExplorerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [goalText, setGoalText] = useState("");
  // Quick Build removed — use ChatSurface sidebar instead

  const load = useCallback(async () => {
    const [campData, expData] = await Promise.all([
      opsFetch<{ campaigns: Campaign[] }>("/api/campaigns"),
      opsFetch<ExplorerStatus>("/api/explorer/status"),
    ]);
    setCampaigns(campData?.campaigns || []);
    setExplorer(expData);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Debounced load — prevents SSE event storms from exhausting DB connections
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = useCallback(() => {
    if (loadTimeoutRef.current) return; // Already pending
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      load();
    }, 1000); // Coalesce events within 1s
  }, [load]);

  // SSE-driven refresh on campaign events
  useEventStream("campaign_approved", debouncedLoad);
  useEventStream("campaign_paused", debouncedLoad);
  useEventStream("campaign_iterated", debouncedLoad);
  useEventStream("campaign_outcome_recorded", debouncedLoad);
  useEventStream("hitl_request", debouncedLoad);

  // Fallback poll at 30s (SSE handles real-time; this is just a safety net)
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggleDomain(domain: string) {
    await opsPost(`/api/explorer/domains/${domain}/toggle`);
    load();
  }

  async function createCampaign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    const form = new FormData(e.currentTarget);
    const body = {
      goal_description: goalText,
      budget_envelope_usd: parseFloat(form.get("budget") as string) || 10,
      max_iterations: parseInt(form.get("iterations") as string, 10) || 20,
      campaign_mode: form.get("mode") as string || "stateless",
      iteration_time_budget: (form.get("time_budget") as string) || "5 minutes",
      auto_approve: form.get("auto_approve") === "on",
      success_criteria: [{ metric: "quality_score", operator: ">=", threshold: parseFloat(form.get("threshold") as string) || 0.85 }],
    };
    await opsPost("/api/campaigns", body);
    setShowCreate(false);
    setCreating(false);
    setGoalText("");
    load();
  }


  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading campaigns...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns & Explorer</h1>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showCreate ? "Cancel" : "Advanced Campaign"}
          </button>
        </div>

        {/* Create Campaign Form (Advanced) */}
        {showCreate && (
          <form onSubmit={createCampaign} className="bg-zinc-900 border border-white/10 rounded-lg p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Goal (Markdown supported)</label>
              <MarkdownEditor
                value={goalText}
                onChange={setGoalText}
                placeholder="Describe what the Claw should optimize..."
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Budget ($)</label>
                <input name="budget" type="number" step="0.01" defaultValue="10" min="0.50"
                  className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Max Iterations</label>
                <input name="iterations" type="number" defaultValue="20" min="1" max="200"
                  className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Success Threshold</label>
                <input name="threshold" type="number" step="0.01" defaultValue="0.85" min="0" max="1"
                  className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Time Budget</label>
                <input name="time_budget" type="text" defaultValue="5 minutes"
                  className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
              </div>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <select name="mode" defaultValue="stateless"
                  className="bg-zinc-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none">
                  <option value="stateless">Stateless</option>
                  <option value="stateful">Stateful (git worktree)</option>
                  <option value="workshop">Workshop (Claude Code)</option>
                  <option value="project">Project (repo + deploy)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input name="auto_approve" type="checkbox" defaultChecked
                  className="rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/50" />
                Auto-approve
              </label>
              <button type="submit" disabled={creating}
                className="ml-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg transition-colors">
                {creating ? "Creating..." : "Create Campaign"}
              </button>
            </div>
          </form>
        )}

        {/* Campaign List */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium text-zinc-300">Campaigns</h2>
            <span className="text-xs text-zinc-500">{campaigns.length} total</span>
          </div>
          {campaigns.length === 0 ? (
            <div className="bg-zinc-900 border border-white/5 rounded-lg p-8 text-center text-zinc-500 text-sm">
              No campaigns yet. Use the chat to create one.
            </div>
          ) : (
            <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden divide-y divide-white/5">
              {campaigns.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
                  <Link href={`/campaigns/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium shrink-0 w-24 text-center ${STATUS_COLORS[c.campaign_status] || "bg-zinc-700 text-zinc-300"}`}>
                      {c.campaign_status.replace(/_/g, " ")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-200 truncate">
                        {c.goal_description.replace(/^#\s+/, "").split("\n")[0].slice(0, 100)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-500 shrink-0">
                      <span>{c.total_iterations}/{c.max_iterations}</span>
                      <span>${parseFloat(c.spent_usd).toFixed(2)}</span>
                      <BudgetBar spent={parseFloat(c.spent_usd)} total={parseFloat(c.budget_envelope_usd)} />
                      <span className="w-16 text-right">{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </Link>
                  {/* Actions: cancel/pause for active campaigns */}
                  {["approved", "running", "awaiting_input", "paused", "plateau_paused"].includes(c.campaign_status) && (
                    <button
                      onClick={async (e) => {
                        e.preventDefault();
                        await opsPost(`/api/campaigns/${c.id}/cancel`);
                        load();
                      }}
                      className="px-2 py-1 text-[10px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors shrink-0"
                      title="Cancel campaign"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Explorer Status */}
        {explorer && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-medium text-zinc-300">Explorer</h2>
              <span className="text-xs text-zinc-500">Today: ${explorer.today_spend.toFixed(2)}</span>
            </div>

            {/* Domain Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {explorer.domains.map((d) => (
                <div
                  key={d.domain}
                  className={`bg-zinc-900 border rounded-lg p-3 ${d.enabled ? "border-white/10" : "border-white/5 opacity-50"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-zinc-300">{d.domain.replace(/_/g, " ")}</span>
                    <button
                      onClick={(e) => { e.preventDefault(); toggleDomain(d.domain); }}
                      className={`w-8 h-4 rounded-full transition-colors ${d.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                    >
                      <div className={`w-3 h-3 rounded-full bg-white transition-transform ${d.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>P{d.priority}</span>
                    <span>{d.runs_7d} runs/7d</span>
                    <span>{d.findings_7d} findings</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Recent Cycles */}
            {explorer.cycles.length > 0 && (
              <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
                <div className="px-4 py-2 border-b border-white/5">
                  <span className="text-xs font-medium text-zinc-400">Recent Exploration Cycles</span>
                </div>
                <div className="divide-y divide-white/5 max-h-64 overflow-y-auto">
                  {explorer.cycles.slice(0, 20).map((cycle, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="text-zinc-500 w-20">{new Date(cycle.created_at).toLocaleTimeString()}</span>
                      <span className="text-zinc-300 w-28">{cycle.domain.replace(/_/g, " ")}</span>
                      <span className={cycle.findings_count > 0 ? "text-yellow-300" : "text-zinc-500"}>
                        {cycle.findings_count} finding(s)
                      </span>
                      <span className="text-zinc-600">{cycle.duration_ms}ms</span>
                      {cycle.error && <span className="text-red-400 truncate">{cycle.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function BudgetBar({ spent, total }: { spent: number; total: number }) {
  const pct = total > 0 ? Math.min((spent / total) * 100, 100) : 0;
  const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-emerald-500";
  const tooltipText = `Metric: Budget Utilization | Details: $${spent.toFixed(2)} / $${total.toFixed(2)} spent`;
  return (
    <div className="w-20 flex-shrink-0 relative group">
      {/* Tooltip */}
      <div
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-zinc-800 border border-white/10 rounded-md text-xs text-zinc-200 whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-50 shadow-lg"
        aria-label={tooltipText}
      >
        <div className="font-medium text-zinc-100">Budget Utilization</div>
        <div className="text-zinc-400">${spent.toFixed(2)} / ${total.toFixed(2)} &mdash; {pct.toFixed(0)}%</div>
        {/* Arrow */}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-800" />
      </div>
      <div
        className="h-1.5 bg-zinc-800 rounded-full overflow-hidden cursor-default"
        aria-label={tooltipText}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-zinc-500 mt-0.5 text-right">{pct.toFixed(0)}%</div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { AgentActivityFeed } from "@/components/observability/AgentActivityFeed";
import { AgentTimeline } from "@/components/observability/AgentTimeline";
import { ConfidenceGateFilter } from "@/components/observability/ConfidenceGateFilter";
import { useAgentActivity, AgentActivityProvider } from "@/contexts/AgentActivityContext";

const WINDOWS = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h",  ms: 60 * 60 * 1000 },
  { label: "6h",  ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
];

function ObservabilityStats() {
  const { state, filteredEvents } = useAgentActivity();
  const total = state.events.length;
  const filtered = filteredEvents.length;
  const active = filteredEvents.filter((e) =>
    ["assigned", "in_progress", "review"].includes(e.toState)
  ).length;
  const failed = filteredEvents.filter((e) =>
    ["failed", "timed_out", "blocked"].includes(e.toState)
  ).length;
  const avgConf =
    filteredEvents.length > 0
      ? Math.round(
          (filteredEvents.reduce((s, e) => s + e.confidenceScore, 0) / filteredEvents.length) * 100
        )
      : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[
        { label: "Total events", value: filtered < total ? `${filtered} / ${total}` : total, sub: filtered < total ? "filtered" : "last 200" },
        { label: "Active transitions", value: active, sub: "assigned · in_progress · review" },
        { label: "Failures", value: failed, sub: "failed · timed_out · blocked", warn: failed > 0 },
        { label: "Avg confidence", value: avgConf !== null ? `${avgConf}%` : "—", sub: "across gate checks" },
      ].map(({ label, value, sub, warn }) => (
        <div
          key={label}
          className="bg-surface-raised rounded-lg p-3 border border-white/5"
        >
          <div className="text-xs text-zinc-500">{label}</div>
          <div className={`text-2xl font-bold tabular-nums ${warn ? "text-red-400" : ""}`}>
            {String(value)}
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>
        </div>
      ))}
    </div>
  );
}

export default function ObservabilityPage() {
  return (
    <AgentActivityProvider>
      <ObservabilityPageInner />
    </AgentActivityProvider>
  );
}

function ObservabilityPageInner() {
  const [windowIdx, setWindowIdx] = useState(0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold">Agent Observability</h1>
        <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-1 border border-white/5">
          {WINDOWS.map((w, i) => (
            <button
              key={w.label}
              onClick={() => setWindowIdx(i)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                windowIdx === i
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              aria-pressed={windowIdx === i}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <ObservabilityStats />

      {/* Gate filter */}
      <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
        <ConfidenceGateFilter label="Filter by constitutional gate" showDescriptions />
      </div>

      {/* Two-column: timeline + feed */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Timeline: 3/5 width */}
        <div className="lg:col-span-3 bg-surface-raised rounded-lg border border-white/5">
          <div className="p-4 border-b border-white/5">
            <h2 className="text-sm font-semibold text-zinc-300">Activity Timeline</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Per-agent swimlane — {WINDOWS[windowIdx].label} window</p>
          </div>
          <div className="p-4">
            <AgentTimeline windowMs={WINDOWS[windowIdx].ms} />
          </div>
        </div>

        {/* Feed: 2/5 width */}
        <div className="lg:col-span-2 bg-surface-raised rounded-lg border border-white/5 flex flex-col">
          <div className="p-4 border-b border-white/5">
            <h2 className="text-sm font-semibold text-zinc-300">Live Activity Feed</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Real-time state transitions</p>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[600px]">
            <AgentActivityFeed maxVisible={50} />
          </div>
        </div>
      </div>
    </div>
  );
}

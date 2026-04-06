# Feature Research

**Domain:** Plugin-based operational dashboard / command console (board command surface for governed AI agent organization)
**Researched:** 2026-04-05
**Confidence:** HIGH — grounded in PRD v1.0.0, SPEC.md, and verified against Grafana/Datadog patterns and AI agent observability literature

---

## Context: This Is Not a Generic Admin Dashboard

This is a **board command console** for two named principals (Dustin and Eric) governing a live AI agent organization. That distinction changes feature priorities significantly:

- **Approval Queue and HALT Control are life-safety features**, not convenience features. They must work when everything else is broken.
- **There are no anonymous users.** GitHub OAuth gates access to exactly two accounts. RBAC, user management, and onboarding flows are anti-features.
- **The brain (agents, API, Postgres) is already built.** Every feature here is a rendering and interaction decision, not a new backend capability.
- **Board members are power users by definition.** Keyboard-first navigation, information density, and precision controls matter more than discoverability.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features whose absence makes the dashboard non-functional or unacceptable to the board.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Approval Queue — view, approve, reject, edit drafts | Core daily operation. Without this, agents cannot communicate externally | High | P0. Mobile-critical. Must work at 375px. Existing page is the reference. |
| HALT Control — trigger and resume | SPEC §9 kill switch. Legal and constitutional requirement, not a convenience | Low | P0. Tiny UI (button + status indicator). Must be reachable from any workspace within 2 keystrokes. |
| Real-time state updates via SSE | Agent state changes must be visible without manual refresh. Polling >30s creates dangerous lag in approval scenarios | Medium | SSE backed by Redis pub/sub. REST polling fallback required — SSE is unreliable on Railway proxies. |
| Agent status — live health of all 18 agents | Board cannot govern what it cannot observe. Dead or looping agents are operational incidents | Medium | Read-only. Tier, sub-tier, model, last active, current task. |
| Pipeline view — task funnel with current state | SPEC §8 explicit requirement: task funnel visualization. Maps directly to agent_graph schema states | Medium | created → assigned → in\_progress → review → completed. |
| Cost tracking — per-tier, per-model spend | Budget control is a board duty. Constitutional gate G1 (budget pre-authorization) requires cost visibility | Low | Read-only charts. recharts is already in spec. |
| Audit log — immutable event history | SPEC P3 (transparency by structure). Board must be able to audit any action taken by any agent | Low | Read-only table with filters. Append-only, hash-chained in backend. |
| Governance / constitutional gate status | Board's primary oversight surface. Gates G1-G8 status, gate config, recent gate trips | Medium | Dual-use: read (compliance view) + write (gate config). |
| Today brief — daily digest | SPEC §8 "event digests." Board needs a zero-config morning context view without navigating individually | Medium | Aggregates from multiple providers (drafts, signals, agents). Default landing view. |
| Signal feed | Extracted intelligence from agent activity. Core output of the signal pipeline | Medium | Read-only. Existing page reference. |
| Workspace persistence — save/restore layouts | A command console that forgets your layout between sessions is not usable by power users | Medium | One Postgres table (board.workspaces). Per-member, shared presets. |
| Command palette (Cmd+K) | SPEC D5 (keyboard-first). Power users cannot operate efficiently without this. Grafana and Linear both treat this as table stakes | Low | cmdk already selected. Scope: workspaces, plugins, drafts, HALT. |
| Plugin crash isolation | A failing DAG visualization must not prevent draft approval. Error boundaries are a correctness requirement | Low | React error boundary per plugin pane. Error card + retry button. |
| Mobile approval queue | Board members must be able to approve drafts on mobile. Agents do not pause for desktop availability | High | Single-plugin full-screen at <768px. Swipe navigation between active plugins. |
| Shell load time < 2s desktop / < 3s mobile | A slow console creates hesitation before safety-critical actions (HALT). Standard web performance expectation | Medium | Lighthouse-verifiable. Directly in PRD exit criteria. |

---

### Differentiators (Competitive Advantage for This Specific Console)

Features that make this board console significantly better than a generic admin dashboard for this domain.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| DAG Visualization — live task dependency graph | SPEC §8 explicit requirement. Makes agent coordination legible: what depends on what, what is blocked, where is the bottleneck | Medium | Read-only. React Flow with dagre layout is the right library (built-in dagre support, MIT, 19K+ stars). Uses existing pipeline data provider. No new API needed. |
| Workspace presets — role-specific views | "Daily Ops" vs "Governance" vs "Cost Review" reduces context switching time by 60–80% for known workflows. Grafana Scenes proved this pattern at scale | Low | 5 presets seeded as non-editable system workspaces. Board can fork to create custom variants. |
| CLI Workstation plugin (xterm.js) | Board members can issue CLI commands without switching to a terminal. Critical for development / debugging phases. Turns the dashboard into a full control surface | High | Existing code, needs plugin wrapping. xterm.js is already in the stack. |
| Knowledge base management | RAG pipeline management (add/remove docs) directly in the console. Migrated from legacy inbox dashboard. Direct board control over what agents know | Medium | Write-capable provider (knowledge.add, knowledge.remove). |
| Per-plugin configurable time windows | "Show cost for last 7 days" vs "last 30 days" without leaving the plugin. Grafana established this as user expectation for analytics panels | Low | configSchema in PluginManifest. Per-plugin config persisted in board.workspaces.plugin\_configs JSONB. |
| HALT reachability from command palette | Triggering HALT via keyboard (Cmd+K → "halt") is faster than any mouse-driven UI in a crisis. No other admin dashboard does this for AI safety controls | Low | One command entry in cmdk registry. Calls existing POST /api/halt endpoint. |
| Drag/resize/reorder grid panes | Board members have different workflows — Dustin monitors approvals; Eric reviews pipeline. A fixed layout forces a single mental model onto two different operators | Medium | react-grid-layout. Layout serialized to JSONB, round-trips without precision loss. |

---

### Anti-Features (Commonly Requested, Often Problematic)

Features to deliberately NOT build in this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Runtime plugin loading (dynamic imports from URL) | Security boundary required. Any remotely-loaded code bypasses SPEC P1 (deny by default) and P2 (infrastructure enforces). Adds significant complexity with zero benefit when all plugins are first-party | All plugins compile-time. Add new plugins via code review, not URL registration. |
| Plugin sandboxing (iframes, web workers) | Same-origin first-party plugins don't need sandboxing. iframes break react-grid-layout resize behavior and increase bundle complexity for zero security gain in this threat model | React error boundaries provide crash isolation without the overhead. |
| User management / RBAC / role assignment | There are exactly two board members, fixed in config. Building an access management UI wastes sprint budget and adds attack surface | GitHub OAuth + BOARD\_MEMBERS env var. Period. |
| Notification system / alerts / email | Agents already communicate through Gmail/Slack/Telegram channels. Adding a notification layer to the dashboard creates a third channel competing with the existing two | Board uses existing channels. Dashboard shows real-time state. |
| AI-assisted dashboard features (anomaly detection, predictive analytics) | Training data on your own agent activity is insufficient at this scale. Premature optimization. Creates trust issues with outputs that can't be verified against groundtruth | Surface raw data clearly. Let the board draw conclusions. |
| Onboarding flows / guided tours / help modals | Two users who built the system. Onboarding is wasted pixels and insulting to power users | Strong keyboard discoverability via command palette serves the "how do I do X" need. |
| Theming / color customization | Internal tool. Brand consistency is not a concern. Every hour on theming is an hour not on HALT control | Dark mode as the single theme. If the board asks for light mode later, one CSS variable swap. |
| board-query chat plugin (Cmd+K AI assistant) | Architecturally sound idea (OQ-4), but adds a new data path and LLM call latency to an otherwise pure API-driven console. Scope risk in a 10-14 day build | Defer to Phase 2. board-query utility agent already works standalone. |
| Pagination-heavy audit logs with complex filtering | Power users export raw data for analysis. Surfacing 10 pages of filter controls in a plugin is the wrong interaction model | Show last 50 events with a single date-range filter. Link to raw data export. |
| Cross-member workspace sync | If Dustin changes his layout, Eric's layout changes too. Violates the principle of per-operator configuration. | Per-member workspaces. Shared presets are read-only templates. |

---

## Feature Dependencies

```
HALT Control
  └── system data provider (useSystemStatus)
       └── POST /api/halt (existing endpoint)

Approval Queue
  └── drafts data provider (useDrafts)
       ├── GET /api/drafts (REST initial load)
       ├── SSE /api/events?channel=drafts (real-time)
       └── POST /api/drafts/:id/approve|reject (writes → guardCheck)

DAG Visualization
  └── pipeline data provider (usePipeline)
       └── GET /api/pipeline (REST — read-only, no SSE needed)
       └── React Flow + dagre layout (new npm dep, compile-time)

All plugins
  └── Plugin shell (react-grid-layout)
       └── Workspace persistence (board.workspaces table)
            └── Command palette (cmdk) → workspace switching

Agent Status
  └── agents data provider (useAgents)
       └── SSE /api/events?channel=agents (real-time critical)

Cost Tracker
  └── cost data provider (useCost)
       └── GET /api/cost (REST only — historical, no live updates needed)

Governance plugin
  └── governance data provider (useGovernance)
       └── audit data provider (useAuditLog)
       └── POST /api/governance (gate config writes → guardCheck)

Today Brief
  └── today data provider (useTodayBrief)
       └── drafts data provider (pending count)
       └── signals data provider (signal count)

Knowledge Base plugin
  └── knowledge data provider (useKnowledge)
       └── POST /api/knowledge/add|remove (writes)

CLI Workstation
  └── No data provider dependency
       └── xterm.js (existing dependency)

Mobile shell behavior
  └── Plugin shell (viewport detection)
       └── Swipe navigation (touch event handlers on shell, not per-plugin)

Workspace presets
  └── Workspace persistence (must exist first)
       └── All 12 plugins (must be registered first)
```

**Critical path:** Shell → Data Providers → Approval Queue + HALT → All other plugins → Presets → Mobile → Decommission

---

## MVP Definition

### Launch With (v1 — this milestone)

Everything in the 12-plugin registry plus the shell infrastructure. No feature additions beyond what the PRD specifies:

1. Plugin shell (react-grid-layout, error boundaries, lifecycle)
2. Command palette (cmdk, Cmd+K, HALT reachable)
3. Data provider layer (10 typed hooks, REST + SSE)
4. Approval Queue plugin (P0 — build first)
5. HALT Control plugin (P0 — build second)
6. Today Brief, Agent Status, Pipeline, Signals, Cost Tracker, Governance, Audit Log, Workstation, DAG View, Knowledge Base (P1-P3, in priority order)
7. 5 workspace presets (seeded)
8. Mobile optimization (single-plugin full-screen, swipe nav)
9. Legacy inbox dashboard decommissioned

### Add After Validation (v1.x)

Features that are architecturally clean to add as plugins after the shell proves stable:

- **board-query chat plugin** (OQ-4) — DeepSeek utility agent with embedded chat. Drops in as `optimus.board-query` once shell is proven.
- **Per-plugin keyboard shortcuts** — e.g., `A` to approve in Approval Queue when focused. Requires focus management in shell.
- **Workspace export/import as JSON** — for backup or sharing presets between members.
- **Agent performance trends** — time-series charts on agent latency and error rates. Uses existing cost/agents data.

### Future Consideration (v2+)

Features that require new infrastructure or significant scope expansion:

- **Fleet management plugins** — Phase 3 in SPEC. Requires new API layer for multi-agent deployment.
- **OpenClaw integration plugins** — Named in PRD as future plugin drop-in candidate.
- **Mobile app** — Native shell for iOS/Android. Current spec calls for mobile-optimized web only.
- **Vercel deployment** — BD-3 pending board decision. Separate deployment target, not a feature.

---

## Feature Prioritization Matrix

| Feature | User Value | Build Complexity | Risk If Missing | Priority |
|---------|-----------|-----------------|-----------------|----------|
| Plugin shell + grid | Critical | Medium | Dashboard doesn't exist | P0 |
| HALT Control | Critical | Low | Constitutional requirement unmet | P0 |
| Approval Queue | Critical | High | Core daily operation blocked | P0 |
| Data provider layer | Critical | Medium | All plugins broken | P0 |
| Command palette | High | Low | Navigation unusable without keyboard | P1 |
| Workspace persistence | High | Medium | Layout lost on refresh | P1 |
| Agent Status | High | Medium | No agent observability | P1 |
| Today Brief | High | Medium | No morning context view | P1 |
| SSE real-time updates | High | Medium | Stale data, dangerous for approvals | P1 |
| Pipeline view | Medium | Medium | SPEC §8 requirement | P2 |
| Signals feed | Medium | Medium | Existing page parity | P2 |
| Governance plugin | Medium | Medium | Gate oversight reduced | P2 |
| Cost Tracker | Medium | Low | Weekly cost review impaired | P2 |
| Audit Log | Medium | Low | SPEC P3 (transparency) | P2 |
| Mobile optimization | Medium | High | Board approval on mobile blocked | P2 |
| DAG Visualization | Medium | Medium | SPEC §8 explicit requirement | P3 |
| CLI Workstation | Medium | High | Debugging requires terminal switch | P3 |
| Knowledge Base | Low | Medium | Legacy migration completeness | P3 |
| Workspace presets | Low | Low | Nice UX, not critical path | P3 |
| Legacy decommission | Low | Low | Maintenance burden, not board-facing | P4 |

---

## Sources

- PRD v1.0.0 (`dashboard-rebuild.md`) — primary specification, HIGH confidence
- SPEC.md §2, §8, §9 — governance requirements, HIGH confidence
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/) — plugin/workspace patterns, HIGH confidence
- [AI Agent Observability — N-iX, 2026](https://www.n-ix.com/ai-agent-observability/) — agent monitoring feature landscape, MEDIUM confidence
- [AI Agent Dashboard Comparison Guide 2026](https://thecrunch.io/ai-agent-dashboard/) — approval queue and kill switch patterns in production AI dashboards, MEDIUM confidence
- [The Kill Switch Debate — Medium](https://medium.com/@kavithabanerjee/the-kill-switch-debate-why-every-production-ai-agent-needs-a-hard-stop-39fe5ec05c7b) — HALT control design rationale, MEDIUM confidence (only 40% of orgs have kill-switch capability)
- [React Flow — Node-Based UIs](https://reactflow.dev/) — DAG visualization library recommendation, HIGH confidence (official docs)
- [react-grid-layout — npm](https://www.npmjs.com/package/react-grid-layout) — layout persistence pattern (onLayoutChange serialization), HIGH confidence
- [cmdk — GitHub](https://github.com/pacocoursey/cmdk) — command palette scope and keyboard nav patterns, HIGH confidence
- [Command Palette UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette) — keyboard-first navigation patterns, MEDIUM confidence
- [Bad Dashboard Examples — Databox](https://databox.com/bad-dashboard-examples) — anti-pattern source (metric overload, missing context), MEDIUM confidence
- [Dashboard Design Patterns](https://dashboarddesignpatterns.github.io/) — structural patterns for operational dashboards, MEDIUM confidence
- [SSE vs WebSockets vs Long Polling — DEV Community](https://dev.to/haraf/server-sent-events-sse-vs-websockets-vs-long-polling-whats-best-in-2025-5ep8) — SSE reliability and fallback patterns, HIGH confidence

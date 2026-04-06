# Project Research Summary

**Project:** Board Workstation Plugin Rebuild
**Domain:** Plugin-based operational dashboard / command console
**Researched:** 2026-04-05
**Confidence:** HIGH

## Executive Summary

The Board Workstation rebuild is a brownfield migration of an existing 16-page Next.js 15 app into a plugin-based canvas architecture. The project is not building new backend capabilities — the autobot-inbox API (port 3001), Redis pub/sub SSE relay, guardCheck constitutional gates, and all 18 agent endpoints already exist and must not be touched. The entire scope is a new frontend shell: a drag/resize/reorder grid (react-grid-layout v2) that replaces fixed page navigation, 12 purpose-built plugin components that replace 16 fixed pages, and a Cmd+K command palette (cmdk) as the primary navigation surface. Research confirms all required libraries are React 19 / Next.js 15 compatible without flag workarounds, the architectural patterns are well-established (Grafana-scale precedent), and the dependency chain dictates a clear 5-phase build order.

The recommended approach is incremental replacement: build the shell harness first with a single stub plugin to prove hydration and grid layout work, then add the data provider hooks layer, then build plugins in P0 → P1 → P2 → P3 priority order, then add the command palette and workspace persistence, and finally decommission the legacy inbox dashboard. This order is not a preference — it is a hard dependency chain. Plugins cannot exist without the data layer; the command palette cannot be wired without the shell and plugins already mounted; workspace persistence requires the grid to be a controlled component from day one or a full rewrite is required.

The dominant risks are not architectural — they are operational safety risks specific to this deployment context. HALT control and the Approval Queue are constitutional requirements, and both can silently degrade under Railway's SSE infrastructure constraints (15-minute connection termination, 1MB transfer limit, proxy buffering). The mitigation is explicit: SSE drives display state only; all P0 safety-critical actions (HALT, approve, reject) go through direct REST POST calls that are independent of SSE connection status. Polling fallback (30-second interval via SWR) must be built into the data layer from day one, not retrofitted. Additionally, the workspace persistence schema must include `schemaVersion` from the moment the `board.workspaces` table is created — this costs nothing at creation time and is extremely expensive to retrofit after board members have saved layouts.

---

## Key Findings

### Recommended Stack

The existing stack (Next.js 15.2, React 19, TypeScript 5.7, Tailwind 3, next-auth v4, ioredis 5, @xyflow/react, react-resizable-panels) is already installed and working. Three new dependencies are required: `react-grid-layout@^2.2.3`, `cmdk@^1.1.1`, and `recharts@^3.8.1`. All three declare peer dep ranges that include React 19 — no `--legacy-peer-deps`. No auth migration, no Tailwind upgrade, no framework changes during this milestone.

The critical version note: react-grid-layout v2 (Dec 2025) is a complete TypeScript rewrite with a hooks-based API (`useContainerWidth`, `useGridLayout`). The legacy `WidthProvider` HOC is deprecated. All new grid code must use the v2 hook API. The only residual uncertainty is React 19 runtime behavior at this specific version combination — v2 has limited production reports at React 19 specifically (MEDIUM confidence), warranting a mount-guard pattern (`{mounted && <ReactGridLayout .../>}`) as a precaution.

**Core technologies:**
- `react-grid-layout@^2.2.3`: drag/resize/reorder grid engine — only library providing drag + resize + responsive breakpoints with React 19 peer deps and no jQuery
- `cmdk@^1.1.1`: command palette (Cmd+K) — Vercel-maintained, explicit React 19 peer dep, unstyled (no Tailwind conflicts)
- `recharts@^3.8.1`: charts for cost/pipeline plugins — React 19 peer dep explicit in v3.x, standard Next.js 15 App Router pattern
- `swr` (already installed): data provider layer — per-key cache deduplication, polling fallback, optimistic updates
- `react-error-boundary` (add): plugin crash isolation — provides `useErrorBoundary()` hook for async error capture that class-based boundaries miss
- `next/dynamic` with `ssr: false`: required for the grid shell — ResizeObserver is browser-only; SSR of the grid causes hard hydration errors in React 19

**Do not add:** next-auth v5 (still beta), Tailwind v4 (breaking config format), any runtime URL plugin loading, WebSockets (SSE is already wired), Zustand/Redux (no global state needed — SWR cache + per-plugin state is sufficient).

### Expected Features

This is a board command console for two named principals, not a generic admin dashboard. Feature priorities are dominated by that context: HALT Control and Approval Queue are constitutional requirements whose failure has legal and operational consequences; every other feature is observability or convenience.

**Must have — table stakes (P0):**
- Plugin shell (react-grid-layout canvas, PluginSlot, ErrorBoundary per slot, plugin registry)
- HALT Control — always-visible, always-enabled, direct REST POST, never gated on SSE state
- Approval Queue — view/approve/reject/edit drafts; mobile-critical (must work at 375px)
- Data provider layer — 10 typed SWR hooks (useAgents, useDrafts, useApprovals, usePipeline, useCosts, useHaltStatus, useSignals, useGovernance, useTaskGraph, useEventFeed) + 3 mutation hooks
- Real-time SSE updates with mandatory polling fallback (30s interval)

**Must have — P1:**
- Command palette (Cmd+K via cmdk) — HALT reachable via keyboard
- Workspace persistence (board.workspaces Postgres table, useWorkspace hook, schemaVersion from day one)
- Agent Status plugin — live health of all 18 agents
- Today Brief plugin — default landing view, daily digest
- SSE reconnect with exponential backoff + server heartbeat (15–20s keep-alive comment)

**Should have — P2/P3:**
- Pipeline view, Signals feed, Cost Tracker, Governance, Audit Log, DAG Visualization, CLI Workstation, Knowledge Base
- 5 workspace presets (seeded, read-only templates)
- Mobile optimization (single-plugin full-screen at <768px, swipe nav, `isDraggable={false}`)

**Defer (v1.x after validation):**
- board-query chat plugin (OQ-4) — architecturally clean drop-in but adds new data path and LLM latency
- Per-plugin keyboard shortcuts
- Workspace export/import as JSON

**Explicit anti-features (do not build):**
- Runtime plugin loading from URLs (violates P1 deny-by-default)
- Plugin sandboxing via iframes (breaks grid resize, zero security gain for same-origin first-party plugins)
- User management / RBAC (two fixed users in config)
- Notification system (agents already communicate via Gmail/Slack/Telegram)
- Theming / color customization (dark mode is the single theme)
- Cross-member workspace sync (per-member workspaces, shared presets are read-only)

### Architecture Approach

The architecture is a layered client-rendered shell with a clear separation of concerns: the shell (WorkspaceShell, PluginSlot, CommandPalette, WorkspaceBar) owns layout state and plugin mounting; the data provider layer (10 typed SWR hooks) owns all API communication; individual plugin components own nothing but their render logic and call hooks directly. There is no global state store. SWR's per-key cache deduplicates requests across plugins calling the same hook. SSE events invalidate SWR cache keys rather than maintaining parallel local state. The shell is a controlled component — layout state lives in `useWorkspace` (backed by Postgres), not inside react-grid-layout's internal state.

**Major components:**
1. `WorkspaceShell` — react-grid-layout canvas, plugin mounting, workspace state owner; loaded with `dynamic({ ssr: false })`
2. `PluginSlot` — per-cell ErrorBoundary wrapper; each slot is isolated; crashes render an error card, not a blank workspace
3. `PLUGIN_REGISTRY` — static compile-time map: pluginId → lazy-loaded component + metadata (defaultSize, mobileFullscreen flag)
4. Data provider hooks (`hooks/data/*`) — typed SWR wrappers; each hook owns its URL and cache key; plugins import directly, no prop drilling
5. Mutation hooks (`hooks/mutations/*`) — all writes go to `OPS_API_URL` (port 3001) where guardCheck enforces G1–G8; no Next.js Server Actions for mutations
6. `useEventStream` (existing) — global SSE singleton; one `EventSource` shared via module-level listeners; never instantiated per plugin
7. `useWorkspace` — layout + plugin config persistence to `board.workspaces`; react-grid-layout is a controlled component against this hook
8. `CommandPalette` — global Cmd+K overlay; mounts once at shell level; searches plugin registry + loaded workspace presets + pending drafts

**Key patterns to follow:**
- SSE drives display invalidation (SWR `mutate()` on relevant events), not local state
- All mutations bypass Next.js Server Actions — direct `fetch(OPS_API_URL + path)`
- `'use client'` boundaries pushed as far down the tree as possible — only interactive grid/plugin internals need it
- `schemaVersion` in workspace JSON from migration 001; `migrateWorkspace()` function exists before any layouts are persisted
- Persist all breakpoint layouts from `onLayoutChange(layout, allLayouts)` — use `allLayouts`, not `layout`, or mobile layouts are lost
- Debounce `onLayoutChange` persistence by 500–1000ms; write on drag stop, not drag move

### Critical Pitfalls

1. **react-grid-layout SSR hydration crash (CP-1)** — React 19 treats hydration mismatches as hard errors; the entire workspace goes blank. Prevention: `dynamic(() => import('./WorkspaceShell'), { ssr: false })` on the grid shell, mounted guard in `useContainerWidth`. Address in Phase 1 before any plugins exist.

2. **Railway SSE silent drops making HALT appear stale (CP-2 + CP-5)** — Railway terminates SSE after 15 minutes and ~1MB transfer. The HALT button must be always-visible and always-enabled regardless of SSE connection state. HALT action is a direct REST POST. SSE drives badge counts and display only. Prevention: server heartbeat every 15–20s, `X-Accel-Buffering: no` header, SWR polling fallback (30s), exponential backoff reconnect. Address in Phase 1 data layer.

3. **Workspace schema without version field silently corrupts layouts on plugin renames (CP-3)** — Once board members have saved workspaces, there is no recovery path without a version field. Prevention: `schemaVersion: 1` in the DDL migration that creates `board.workspaces`; `migrateWorkspace()` function exists before first save. Address in Phase 1 persistence schema.

4. **Error boundaries do not catch async/event-handler errors (CP-4)** — A button click throwing a network error will bubble uncaught and crash the workspace instead of showing an error card. Prevention: `react-error-boundary` with `useErrorBoundary()` hook so mutation hooks can call `showBoundary(error)` from async catch blocks. Establish as part of plugin host contract in Phase 1.

5. **onLayoutChange debounce missing — database hammered during drag (Performance Trap)** — Without debouncing, every pixel of drag movement triggers a Postgres write. Prevention: debounce persistence by 500–1000ms; write on drag stop (`onDragStop`, `onResizeStop` callbacks), not on every `onLayoutChange` tick.

---

## Implications for Roadmap

Based on the architecture dependency chain and pitfall-to-phase mapping, a 5-phase structure is indicated. The chain is strict: shell scaffolding must precede data hooks; data hooks must precede plugins; plugins must exist before command palette and workspace presets can be wired; decommission is last.

### Phase 1: Shell Scaffold + Safety Foundation

**Rationale:** The grid shell, plugin slot contract, error boundary pattern, SSE fallback strategy, and workspace schema versioning are all foundational decisions that cannot be changed without rewriting downstream code. CP-1, CP-3, CP-4, CP-5 all demand Phase 1 resolution. Building a stub plugin in Phase 1 proves the harness works before investing in 12 real plugins.

**Delivers:**
- WorkspaceShell with `dynamic({ ssr: false })` and `useContainerWidth` mounted guard
- PluginSlot with `react-error-boundary` + `useErrorBoundary` contract
- PLUGIN_REGISTRY (static compile-time map, lazy imports)
- Stub plugin (e.g., HelloPlugin) proving the harness renders and grid layout serializes correctly
- `board.workspaces` DDL migration with `schemaVersion: 1` and `migrateWorkspace()` function
- WorkspaceBar skeleton and WorkspaceShell → WorkspaceBar wiring
- SSE reconnect + heartbeat + polling fallback baked into `useEventStream` extension (or confirm existing implementation satisfies CP-2)

**Addresses:** CP-1 (hydration), CP-2 (SSE drops), CP-3 (schema version), CP-4 (error boundary gaps), CP-5 (HALT SSE dependency)
**Avoids:** Building any plugins before the harness is proven

### Phase 2: Data Provider Layer

**Rationale:** All 12 plugins depend on typed data hooks. Building plugins before hooks exist forces either stub data or repeated refactors when hooks are added. The data layer is also where SSE invalidation, polling fallback timing, and mutation guardCheck routing are standardized for all plugins.

**Delivers:**
- `lib/api-client.ts` — typed fetch wrapper with `OPS_API_URL` base and auth headers
- All 10 typed SWR data hooks (`useAgents`, `useDrafts`, `useApprovals`, `usePipeline`, `useCosts`, `useHaltStatus`, `useSignals`, `useGovernance`, `useTaskGraph`, `useEventFeed`)
- All 3 mutation hooks (`useApproveDraft`, `useRejectDraft`, `useHaltToggle`)
- `useWorkspace` hook (load/save workspace layout + plugin configs to `board.workspaces`)
- SWR polling fallback (30s `refreshInterval`) as standard per-hook config
- SSE → SWR cache invalidation pattern documented and demonstrated

**Addresses:** Data correctness for all downstream plugins; mutation path through guardCheck (not Server Actions)
**Uses:** `swr`, `lib/api-client.ts`, existing `useEventStream`, `OPS_API_URL`

### Phase 3: Core Plugins (P0 first, then P1/P2/P3)

**Rationale:** P0 plugins (HALT Control, Approval Queue) are constitutional requirements with safety implications and must be built and reviewed before P1/P2/P3 plugins. Once the two P0 plugins prove the plugin development pattern, the remaining 10 plugins follow the same pattern and can be built in parallel or sequence as capacity allows.

**Delivers:**
- HaltControlPlugin — always-visible button, always-enabled, direct `useHaltToggle()` REST POST, SSE-independent, explicit review gate before ship
- ApprovalQueuePlugin — draft list with approve/reject/edit, SSE invalidation on `draft_ready`, mobile-first layout (min-width 375px)
- Remaining 10 plugins in P1 → P2 → P3 order: Today Brief, Agent Status, Pipeline, Signals, Cost Tracker, Governance, Audit Log, DAG Visualization, CLI Workstation, Knowledge Base

**Addresses:** All 12 items in the 12-plugin registry; feature parity matrix sign-off before any legacy page is decommissioned
**Implements:** All plugin architecture patterns (Pattern 1 through 6 from ARCHITECTURE.md)
**Avoids:** HALT gated on SSE state (CP-5 explicit check before HALT plugin ships)

### Phase 4: Command Palette, Workspace Presets, Mobile Optimization

**Rationale:** The command palette requires the plugin registry and loaded workspace state to be queryable — it cannot be built before plugins and workspace persistence exist. Workspace presets require all 12 plugins to be registered. Mobile optimization (swipe nav, `isDraggable={false}`) requires the full plugin set to test against.

**Delivers:**
- CommandPalette (`cmdk`, global Cmd+K, searches plugins + workspaces + pending drafts, HALT reachable in 2 keystrokes)
- 5 workspace presets (`workspace-presets.ts`, seeded as read-only system workspaces, applying creates a new workspace not overwrites current)
- Mobile breakpoint behavior (single-plugin full-screen at <768px, swipe nav, drag disabled, validated on real iOS Safari not emulation)
- WorkspaceBar preset switcher and add-plugin button

**Addresses:** Keyboard-first navigation (SPEC D5); power-user efficiency; mobile approval queue requirement
**Avoids:** Preset applying overwriting current layout (UX pitfall from PITFALLS.md)

### Phase 5: Legacy Decommission

**Rationale:** Decommission happens last, after explicit feature parity sign-off. Every workflow from the 16 existing fixed pages must be verifiable in the new plugins before the legacy inbox dashboard (port 3100 / inbox.staqs.io) is removed. Domain redirect must be configured in Railway before the service is deleted.

**Delivers:**
- Feature parity matrix signed off (one row per existing page function, verified in plugin equivalent)
- Legacy inbox dashboard service removed from docker-compose and Railway
- `inbox.staqs.io` domain redirect configured to `board.staqs.io` before service deletion
- Lighthouse performance validation (shell load <2s desktop / <3s mobile per PRD exit criteria)

**Addresses:** Legacy maintenance burden; PRD exit criteria; domain redirect gap (from "Looks Done But Isn't" checklist)
**Avoids:** 404 on inbox.staqs.io after decommission

---

### Phase Ordering Rationale

- **Foundation before features:** Shell (Phase 1) and data layer (Phase 2) are hard prerequisites for all plugins. This is not a design preference — it is the literal dependency chain from ARCHITECTURE.md step 1–9.
- **Safety-critical first within Phase 3:** HALT Control and Approval Queue have constitutional and legal weight. They get the first implementation slots and an explicit review gate, not the last.
- **Composition before orchestration:** Command palette (Phase 4) requires the plugin registry and workspace state from Phase 3 to be queryable. Building it earlier would require stub data that gets discarded.
- **Decommission last:** Any legacy page decommissioned before its feature parity is confirmed in the new plugin represents lost functionality with no recovery path.
- **Schema versioning in Phase 1, not Phase 3:** Moving `schemaVersion` to "when we add workspace persistence" means the first saved layouts have no version field. Retrofitting costs a migration plus custom board-member data recovery. The cost in Phase 1 is a single JSON field.

### Research Flags

Phases with standard, well-documented patterns (skip additional research-phase):
- **Phase 2 (Data layer):** SWR + typed hooks + REST is a standard Next.js 15 pattern; ample documentation and prior art.
- **Phase 4 (Command palette):** cmdk API is well-documented; shadcn/ui has extensive examples.
- **Phase 5 (Decommission):** Operational checklist, not a technical challenge requiring research.

Phases that may benefit from targeted research during planning:
- **Phase 1 (Shell scaffold):** react-grid-layout v2 has limited React 19 production reports. The mounted guard pattern and `useContainerWidth` hook API should be validated against the actual v2.2.3 package before writing the WorkspaceShell. Recommend reading the v2 CHANGELOG and RFC before the phase planning session.
- **Phase 3 (DAG Visualization plugin):** @xyflow/react is already installed and working, but the dagre layout integration for task graph DAGs is non-trivial. Recommend a brief spike on the dagre layout adapter before estimating the DAG visualization plugin.
- **Phase 3 (CLI Workstation plugin):** xterm.js is already in the stack but the wrapping pattern inside a resizable react-grid-layout cell (where dimensions change on drag) needs validation. Terminal resize events must be forwarded to xterm when the grid cell resizes.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH (core), MEDIUM (rgl v2 React 19 runtime) | All peer deps verified from package.json. react-grid-layout v2 was released Dec 2025 — limited React 19 production reports but v2 API is fully documented. |
| Features | HIGH | Grounded in PRD v1.0.0, SPEC.md §2/§8/§9, and verified against the existing codebase. No speculation required — the backend is built, the feature set is determined. |
| Architecture | HIGH | Existing codebase read directly. All patterns cross-referenced against Next.js 15 official docs and community sources. The 6 architectural anti-patterns are all grounded in specific GitHub issues or official docs. |
| Pitfalls | HIGH | Railway SSE limits confirmed from official Railway docs. Hydration crash confirmed from Next.js GitHub issues. Schema versioning gap confirmed from react-grid-layout GitHub issues. Error boundary gap confirmed from React docs. |

**Overall confidence: HIGH**

### Gaps to Address

- **react-grid-layout v2 React 19 runtime behavior:** The v2 API is documented and peer deps are correct, but production reports at the exact React 19 + Next.js 15.2 + rgl 2.2.3 combination are thin (library released Dec 2025). Mitigate with mounted guard and a small integration test in Phase 1 before committing to the full shell design.

- **SSE heartbeat implementation in port 3001:** PITFALLS.md recommends server-side heartbeat comments (`": keep-alive\n\n"` every 15–20s) to prevent Railway proxy buffering. Research did not verify whether the existing SSE relay in `autobot-inbox/` already sends heartbeats. This should be checked before assuming the fix is purely client-side. If not present, a small backend change to `autobot-inbox/` may be required — which is outside the stated scope ("API is UNTOUCHED").

- **board.workspaces Postgres table location:** ARCHITECTURE.md references a "board-side Postgres" instance for workspace persistence. The project's docker-compose has a single Postgres service. Clarify whether `board.workspaces` goes into the existing `autobot-inbox` Postgres (as a new schema) or requires a second database instance before writing the migration.

- **Feature parity matrix:** PITFALLS.md flags maintaining an explicit parity matrix before decommissioning any legacy page. This matrix does not exist yet. It should be a deliverable within Phase 3 planning (created before Phase 5 execution begins), not a post-hoc verification.

---

## Sources

### Primary (HIGH confidence)
- `board/package.json` — existing dependency versions, verified directly
- `dashboard-rebuild.md` (PRD v1.0.0) — primary feature specification
- `SPEC.md §2, §8, §9` — governance requirements, agent tier architecture, task funnel
- react-grid-layout v2 CHANGELOG and RFC: https://github.com/react-grid-layout/react-grid-layout
- cmdk GitHub releases (peer dep verification): https://github.com/pacocoursey/cmdk/releases
- Railway SSE documentation: https://docs.railway.com/guides/sse-vs-websockets
- Next.js 15 App Router official docs
- react-error-boundary official docs

### Secondary (MEDIUM confidence)
- Grafana dashboard best practices: https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/
- N-iX AI agent observability guide (2026): https://www.n-ix.com/ai-agent-observability/
- Railway SSE 1MB transfer limit (community report): https://station.railway.com/questions/are-there-limits-on-total-transfer-size-3c991de1
- SSE proxy buffering post-mortem: https://dev.to/miketalbot/server-sent-events-are-still-not-production-ready-after-a-decade-a-lesson-for-me-a-warning-for-you-2gie
- react-grid-layout hydration mismatch: https://oneuptime.com/blog/post/2026-01-24-fix-hydration-mismatch-errors-nextjs/view
- Dashboard schema versioning: https://github.com/perses/perses/discussions/1186

### Tertiary (contextual)
- AI Agent Dashboard Comparison Guide 2026: https://thecrunch.io/ai-agent-dashboard/
- The Kill Switch Debate: https://medium.com/@kavithabanerjee/the-kill-switch-debate-why-every-production-ai-agent-needs-a-hard-stop-39fe5ec05c7b

---

*Research completed: 2026-04-05*
*Ready for roadmap: yes*

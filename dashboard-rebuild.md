# Board Workstation Plugin Rebuild — PRD v1.0.0

> **Date:** 2026-04-05
> **Authors:** Dustin (board), Claude (drafting)
> **Status:** Proposed — pending board review
> **Spec version:** v1.0.0 (SPEC.md)
> **Repository:** `ConsultingFuture4200/optimus-bu` → `board/`
> **Deployment:** Railway → board.staqs.io (port 3200)
> **Supersedes:** Optimus Command dashboard (dashboard.consultingfutures.com, Vercel), inbox dashboard (port 3100, inbox.staqs.io)

---

## 1. Executive Summary

Replace the existing 16-page fixed-layout Board Workstation (`board/`) and the legacy inbox dashboard (`autobot-inbox/dashboard/`, port 3100) with a single plugin-host workspace architecture. One codebase, one deployment, one port. The plugin shell consumes the existing autobot-inbox API (port 3001) — the brain connection is already built, we're replacing the frontend that renders it.

**What this is:** A frontend rebuild of `board/src/app/` from fixed Next.js pages to composable plugin panes, plus decommissioning the legacy inbox dashboard.

**What this is not:** A new API layer, a new database, or a change to the agent runtime. The autobot-inbox API at port 3001, the Postgres task graph, the constitutional gates G1-G8, and the agent pipeline are untouched.

**Cost:** ~10-14 days of build effort. $0 incremental infrastructure cost. Eliminates one Railway service (inbox-dashboard).

**Payback:** Every future dashboard feature (Phase 2 learning tab, Phase 3 fleet management, OpenClaw integration) drops in as a plugin instead of restructuring a monolith. Breaks even during Phase 2.

---

## 2. Project Identity

The Board Workstation is the human board's operational control surface for Optimus — the governed agent organization. It is the primary interface through which Dustin and Eric observe agent activity, approve/reject work, inject directives, trigger HALT, and monitor costs. It implements SPEC §2 (board interaction layer), §8 (dashboard requirements), and §9 (kill switch UI). It is NOT a customer-facing product dashboard — it is the board's command console.

---

## 3. Stack Constraints

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 15 (App Router) | Already in use at `board/`. No migration cost. |
| Language | TypeScript | Existing board codebase. Type safety for plugin API contracts. |
| Runtime | Node.js >= 20.0.0 | Repo-wide constraint (package.json). ES modules throughout. |
| Database | Supabase (Postgres + pgvector) | Existing. Workspace layouts stored here. No new database. |
| Cache/Pubsub | Redis 7 | Already in compose.yml. Used for real-time event relay. |
| Hosting | Railway | Board decision: keep Railway. Domain: board.staqs.io. |
| Package manager | npm | Repo-wide constraint. |
| Auth | NextAuth (GitHub OAuth) | Already configured. `BOARD_MEMBERS: ecgang,ConsultingFuture4200`. |
| Layout engine | `react-grid-layout` (MIT, 19K+ stars) | New dependency. Battle-tested: Grafana, Datadog, Jupyter. |
| Command palette | `cmdk` (MIT, Vercel-maintained) | New dependency. Tiny bundle, keyboard-first. |
| Charts | `recharts` (MIT) | Already in thUMBox spec. Standard React charting. |

**New dependencies total:** 2 (`react-grid-layout`, `cmdk`). Both MIT. Both < 50KB gzipped.

---

## 4. Architecture

### 4.1 Current State (What Exists)

```
┌─────────────────────────────────────────────────────────┐
│  board.staqs.io (port 3200)                             │
│  Next.js 15 — 16 fixed pages                           │
│  NextAuth (GitHub OAuth)                                │
│  Talks to autobot-inbox API via OPS_API_URL             │
│  Redis for session/state                                │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (OPS_API_URL)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  autobot-inbox API (port 3001)                          │
│  18 agents, G1-G8 gates, lib/runtime/*                  │
│  Postgres (agent_graph, 96 tables, 5 schemas)           │
│  Neo4j (knowledge graph), Redis, RAG pipeline           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  inbox.staqs.io (port 3100) — LEGACY, TO BE KILLED      │
│  autobot-inbox/dashboard/ — separate Next.js app         │
│  Duplicates draft approval, sent history, status views   │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Target State

```
┌──────────────────────────────────────────────────────────┐
│  BOARD WORKSTATION — board.staqs.io (port 3200)          │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  SHELL (NextAuth, layout engine, plugin lifecycle, │  │
│  │         command palette, workspace persistence)     │  │
│  │                                                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │ Approval │ │ Pipeline │ │  Signals │  ...      │  │
│  │  │ Queue    │ │ View     │ │  Feed    │           │  │
│  │  │ (plugin) │ │ (plugin) │ │ (plugin) │           │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │  │
│  │       │             │            │                 │  │
│  │  ┌────┴─────────────┴────────────┴──────────────┐ │  │
│  │  │     DATA PROVIDER LAYER (typed hooks)        │ │  │
│  │  │  useDrafts() · usePipeline() · useSignals()  │ │  │
│  │  │  useCost() · useAgents() · useGovernance()   │ │  │
│  │  └───────────────────┬──────────────────────────┘ │  │
│  └──────────────────────┼────────────────────────────┘  │
│                         │                                │
└─────────────────────────┼────────────────────────────────┘
                          │  OPS_API_URL (existing)
                          │  + Redis pub/sub (SSE for live updates)
                          ▼
┌──────────────────────────────────────────────────────────┐
│  autobot-inbox API (port 3001) — UNCHANGED               │
│  Postgres · Neo4j · Redis · 18 agents · G1-G8 gates     │
└──────────────────────────────────────────────────────────┘

   inbox.staqs.io (port 3100) — DECOMMISSIONED
```

### 4.3 Connection Architecture — How the Dashboard Talks to the Brain

There are exactly three data paths. All three use existing infrastructure.

**Path 1 — Read (REST).** Data provider hooks call the existing autobot-inbox API endpoints over `OPS_API_URL` (already wired in compose.yml). Initial page loads, historical data, search queries.

```
Plugin → useApprovalQueue() → fetch(`${OPS_API_URL}/api/drafts`) → Postgres
```

**Path 2 — Write (REST + guardCheck).** Action plugins (approve/reject drafts, inject directives, trigger HALT) POST to existing API endpoints. The API server enforces constitutional gates G1-G8 via `lib/runtime/guard-check.js` — the dashboard is just another client, never bypassing `guardCheck()` (P2).

```
Approval Queue plugin → POST /api/drafts/:id/approve → guardCheck() → transition_state()
HALT button → POST /api/halt → INSERT halt_signals
```

**Path 3 — Real-time (Redis → SSE).** The autobot-inbox API already publishes events to Redis (via `lib/runtime/` event bus). The board workstation's Next.js API routes subscribe to Redis channels and push Server-Sent Events to the browser. When a state transition happens in the brain, the plugin updates without polling.

```
Agent completes task → transition_state() → Redis PUBLISH → Next.js SSE route → Plugin re-renders
```

No new API server. No new database. No new infrastructure. The brain connection already exists — we're rebuilding the shell that renders it.

### 4.4 Design Principles

| # | Principle | Spec Alignment | Implementation |
|---|-----------|----------------|----------------|
| D1 | Read-only by default | P1 (deny by default) | Data providers are read-only. Write capabilities require explicit declaration in plugin manifest + server-side auth enforcement. |
| D2 | Infrastructure enforces writes | P2 | Plugin write actions go through the existing API → guardCheck() → transition_state(). The dashboard never writes directly to Postgres. |
| D3 | Every action logged | P3 | Plugin activations, workspace switches, board actions logged to `dashboard_audit_log` table. Inherits audit trail from the API for all write operations. |
| D4 | Boring stack | P4 | Next.js, react-grid-layout, cmdk, recharts. No custom rendering engine. |
| D5 | Keyboard-first | P6 (familiar interfaces) | Command palette (Cmd+K) for all navigation. Board members can operate entirely from keyboard. |
| D6 | Plugin crash isolation | — | React error boundaries per plugin. A crashing plugin shows an error card — does not take down the workspace. |

---

## 5. Plugin API Specification

### 5.1 Plugin Manifest

```typescript
interface PluginManifest {
  id: string;                    // e.g., 'optimus.approval-queue'
  name: string;                  // e.g., 'Approval Queue'
  version: string;               // semver
  category: 'workflow' | 'analytics' | 'system' | 'governance' | 'ops';
  dataDependencies: string[];    // e.g., ['drafts', 'classifications']
  writeCapabilities?: string[];  // e.g., ['drafts.approve', 'drafts.reject']
  defaultSize: { w: number; h: number };  // grid units
  minSize?: { w: number; h: number };
  mobileSupported: boolean;
  configSchema?: Record<string, ConfigField>;
}
```

### 5.2 Plugin Implementation Contract

```typescript
interface OptimusPlugin {
  manifest: PluginManifest;
  component: React.ComponentType<PluginProps>;
  onActivate?: (context: PluginContext) => void | Promise<void>;
  onDeactivate?: () => void;
}

interface PluginProps {
  config: Record<string, unknown>;
  size: { w: number; h: number };
}

interface PluginContext {
  api: ApiClient;            // typed wrapper around OPS_API_URL
  subscribe: (channel: string, handler: (data: unknown) => void) => Unsubscribe;
  getConfig: () => Record<string, unknown>;
  boardMember: string;       // GitHub username from NextAuth session
}
```

### 5.3 Plugin Lifecycle

```
1. REGISTER    Shell loads plugin manifest from registry at build time
2. ACTIVATE    Shell calls onActivate(), plugin subscribes to data providers
3. RENDER      Plugin renders into its assigned grid pane
4. CONFIGURE   User passes settings (time window, filters) via plugin config panel
5. DEACTIVATE  Shell calls onDeactivate(), plugin unsubscribes, cleans up
```

All plugins are first-party and registered in code at build time. No runtime plugin loading in this phase.

---

## 6. Data Provider Layer

Typed React hooks that abstract the existing autobot-inbox API. Read-only by default. Write actions are separate named functions.

### 6.1 Provider Registry

| Provider | Hook | API Endpoint (existing) | Read/Write |
|----------|------|------------------------|------------|
| `drafts` | `useDrafts()` | `/api/drafts` | Read + Write (approve/reject/edit) |
| `pipeline` | `usePipeline()` | `/api/pipeline` | Read-only |
| `signals` | `useSignals()` | `/api/signals` | Read-only |
| `agents` | `useAgents()` | `/api/agents` | Read-only (status, performance) |
| `cost` | `useCost()` | `/api/cost` | Read-only |
| `governance` | `useGovernance()` | `/api/governance` | Read + Write (gate config) |
| `system` | `useSystemStatus()` | `/api/system` | Read + Write (HALT trigger) |
| `audit` | `useAuditLog()` | `/api/audit` | Read-only |
| `knowledge` | `useKnowledge()` | `/api/knowledge` | Read + Write (add/remove docs) |
| `today` | `useTodayBrief()` | `/api/today` | Read-only |

### 6.2 Real-time Update Pattern

```typescript
// Example: useDrafts() hook with SSE subscription
function useDrafts() {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // Initial load via REST
  useEffect(() => {
    fetch(`${OPS_API_URL}/api/drafts`).then(/* ... */);
  }, []);

  // Live updates via SSE (backed by Redis pub/sub)
  useEffect(() => {
    const source = new EventSource('/api/events?channel=drafts');
    source.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setDrafts(prev => applyUpdate(prev, update));
    };
    return () => source.close();
  }, []);

  return { drafts, loading, error };
}
```

### 6.3 Write Enforcement

Write-capable providers expose named action functions, not generic setters:

```typescript
// CORRECT — named actions that go through guardCheck()
const { drafts, approveDraft, rejectDraft, editDraft } = useDrafts();

// WRONG — generic setter that could bypass gates
const { drafts, setDrafts } = useDrafts(); // NOT THIS
```

Every write function POSTs to the existing API, which enforces constitutional gates server-side.

---

## 7. Core Plugin Registry — Phase 1

These plugins replace the existing 16 fixed pages. Each maps to an existing page + its existing API endpoints.

| Plugin ID | Name | Replaces Page | Category | Data Dependencies | Write | Mobile |
|-----------|------|---------------|----------|-------------------|-------|--------|
| `optimus.today` | Today Brief | Today | workflow | `today`, `drafts`, `signals` | — | Yes |
| `optimus.approval-queue` | Approval Queue | Drafts | workflow | `drafts` | `drafts.approve`, `drafts.reject`, `drafts.edit` | Yes |
| `optimus.signals` | Signal Feed | Signals | analytics | `signals` | — | Yes |
| `optimus.pipeline` | Pipeline | Pipeline | ops | `pipeline`, `agents` | — | Partial |
| `optimus.governance` | Governance | Governance | governance | `governance`, `audit` | `governance.updateGate` | No |
| `optimus.workstation` | CLI Workstation | Workstation | ops | — | — | No |
| `optimus.agent-status` | Agent Status | (new — extracted from Pipeline) | system | `agents` | — | Yes |
| `optimus.cost-tracker` | Cost Tracker | (extracted from existing) | analytics | `cost` | — | Partial |
| `optimus.audit-log` | Audit Log | (extracted from Governance) | governance | `audit` | — | No |
| `optimus.dag-view` | DAG Visualization | (new — SPEC §8 requirement) | ops | `pipeline` | — | No |
| `optimus.halt-control` | HALT Control | (extracted from System) | system | `system` | `system.halt`, `system.resume` | Yes |
| `optimus.knowledge-base` | Knowledge Base | (from inbox dashboard) | workflow | `knowledge` | `knowledge.add`, `knowledge.remove` | No |

Total: 12 plugins replacing 16 pages + absorbing legacy inbox dashboard features.

---

## 8. Workspace Presets

Predefined layout configurations. Board members can create custom workspaces on top of these.

| Workspace | Plugins | Default For |
|-----------|---------|-------------|
| **Daily Ops** | Today (top-left), Approval Queue (right, tall), Signal Feed (bottom-left), Agent Status (bottom-right) | Morning check-in. Default on login. |
| **Pipeline** | Pipeline (top, full-width), DAG View (bottom-left), Agent Status (bottom-right) | Monitoring agent execution. |
| **Governance** | Governance (left), Audit Log (right), HALT Control (bottom-center) | Reviewing constitutional compliance. |
| **Command** | Workstation (full-width, tall), Agent Status (sidebar), HALT Control (bottom) | Active development / debugging. |
| **Cost Review** | Cost Tracker (top), Pipeline (middle), Audit Log (bottom) | Weekly cost review with Eric. |

### Workspace Persistence

```sql
CREATE TABLE board.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_member TEXT NOT NULL,          -- GitHub username
  name TEXT NOT NULL,
  is_preset BOOLEAN DEFAULT false,     -- true for system presets
  layout JSONB NOT NULL,               -- react-grid-layout serialized state
  plugin_configs JSONB DEFAULT '{}',   -- per-plugin config overrides
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (board_member, name)
);
```

This is one new table in the existing Postgres instance. No new schema, no new database role.

---

## 9. Decommissioning Plan — Legacy Inbox Dashboard

The legacy inbox dashboard (`autobot-inbox/dashboard/`, port 3100, inbox.staqs.io) is eliminated.

### Migration Mapping

| Legacy Dashboard Feature | Plugin Replacement |
|--------------------------|-------------------|
| Draft approval queue | `optimus.approval-queue` |
| Sent history | `optimus.approval-queue` (filter: status=sent) |
| Classification log | `optimus.signals` |
| System status | `optimus.agent-status` + `optimus.halt-control` |
| Knowledge base management | `optimus.knowledge-base` |

### Decommission Steps

1. Verify all legacy features have plugin equivalents (acceptance criteria per feature).
2. Redirect inbox.staqs.io → board.staqs.io (Railway domain config).
3. Remove `inbox-dashboard` service from `compose.yml`.
4. Remove `autobot-inbox/dashboard/` directory from repo.
5. Remove `Dockerfile.dev` from `autobot-inbox/dashboard/`.
6. Update CLAUDE.md to remove legacy dashboard references.

### Rollback Plan

If the plugin dashboard has critical issues post-deploy, the legacy dashboard can be restored by reverting the compose.yml change (the code stays in git history). Railway redeploys in < 2 minutes.

---

## 10. Deliverables

| # | Deliverable | Description | Exit Criteria |
|---|------------|-------------|---------------|
| D1 | Plugin shell | Layout engine, plugin lifecycle, workspace persistence, error boundaries | EC-1, EC-2, EC-3 |
| D2 | Command palette | Cmd+K navigation: switch workspace, open plugin, search drafts, jump to settings | EC-4 |
| D3 | Data provider layer | Typed hooks for all 10 providers, REST + SSE integration | EC-5, EC-6 |
| D4 | Core plugins (12) | All plugins from §7 converted from existing pages | EC-7, EC-8 |
| D5 | Workspace presets (5) | Predefined layouts per §8 | EC-9 |
| D6 | Legacy decommission | inbox-dashboard service removed, inbox.staqs.io redirected | EC-10 |
| D7 | Railway deployment | board.staqs.io serving plugin architecture | EC-11 |

---

## 11. Exit Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| EC-1 | Shell load time | < 2s on desktop, < 3s on mobile | Lighthouse / manual timing |
| EC-2 | Plugin activation time | < 500ms per plugin | Performance profiling |
| EC-3 | Plugin crash isolation | Crashing plugin does not affect other active plugins (100%) | Integration test with intentionally failing plugin |
| EC-4 | Command palette responsiveness | < 100ms from keystroke to results | Manual testing |
| EC-5 | Data provider accuracy | All 10 providers return data matching direct API calls (100%) | Automated comparison test |
| EC-6 | Real-time update latency | State transition visible in dashboard < 3s after brain event | End-to-end test: trigger transition → measure dashboard update |
| EC-7 | Feature parity — approval queue | Approve, reject, edit drafts with identical behavior to existing page | Manual QA checklist |
| EC-8 | Feature parity — all plugins | Every feature from existing 16 pages accessible via plugins | Manual QA checklist (per-plugin) |
| EC-9 | Workspace save/restore fidelity | Restored workspace matches saved layout exactly | Automated round-trip test |
| EC-10 | Legacy decommission complete | inbox-dashboard service removed from compose.yml, inbox.staqs.io redirects to board.staqs.io | Deployment verification |
| EC-11 | Railway deployment healthy | board.staqs.io serves plugin dashboard, all plugins functional | Smoke test post-deploy |

---

## 12. Kill Criteria

Conditions that abort or restructure this build:

- Plugin shell + Approval Queue plugin exceed 5 days of combined build time.
- react-grid-layout introduces > 200ms render latency on a standard laptop.
- Plugin API requires > 50 lines of boilerplate per plugin (architecture too heavy).
- SSE real-time path adds > 5s latency vs. polling (Redis pub/sub unreliable on Railway).
- Any existing board workflow (approve draft, trigger HALT, view cost) is slower or harder to reach after the rebuild than before it.

---

## 13. Task Breakdown

> Total tasks: 19 across 5 batches
> Estimated effort: 10–14 days
> Spec sections: §2 (board interaction), §8 (dashboard/observability), §9 (kill switch UI)

### Dependency Graph

```
Batch 0 (prep) → Batch 1 (shell) → Batch 2 (providers + plugins) → Batch 3 (presets + polish) → Batch 4 (decommission + deploy)
```

Batches 1-2 are sequential (shell before plugins). Tasks within each batch are parallel.

### Batch 0: Preparation (1 day)

#### Task 0.1: Audit existing pages and API endpoints

**Depends on:** none
**Produces:** `board/docs/page-api-mapping.md`

**Objective:** Document every existing page in `board/src/app/`, every API endpoint it calls, every write action it performs, and every feature it exposes. This is the migration checklist.

**Acceptance Criteria:**
- [ ] Every page in `board/src/app/` listed with its API dependencies
- [ ] Every write action documented (which endpoint, what payload, what gate)
- [ ] Feature checklist per page (used for EC-8 verification)

---

### Batch 1: Shell Infrastructure (2-3 days, parallel tasks)

#### Task 1.1: Plugin shell with react-grid-layout

**Depends on:** Task 0.1
**Produces:** `board/src/components/shell/`, `board/src/lib/plugin-registry.ts`

**Objective:** Build the layout engine — draggable/resizable grid panes, plugin lifecycle manager (register/activate/deactivate), error boundaries per plugin.

**Requirements:**
1. Install `react-grid-layout`, configure responsive breakpoints (desktop, tablet, mobile).
2. Plugin registry: in-memory Map of registered plugins, loaded at build time.
3. Plugin lifecycle: `onActivate()` called when pane opens, `onDeactivate()` when closed.
4. React error boundary wrapping each plugin pane — crash shows error card with retry button.
5. Layout serialization to JSON (compatible with workspace persistence in Task 1.3).

**Acceptance Criteria:**
- [ ] Grid renders with placeholder panes (drag, resize, reorder)
- [ ] Error boundary catches thrown errors without affecting adjacent panes
- [ ] Layout serializes to JSON and restores from JSON exactly

**Anti-Requirements:**
- Do NOT build runtime plugin loading (dynamic imports from URL). All plugins are compile-time imports.
- Do NOT build plugin sandboxing (iframes, web workers). Plugins run in the same React tree.

---

#### Task 1.2: Command palette (cmdk)

**Depends on:** none (can parallel with 1.1)
**Produces:** `board/src/components/shell/command-palette.tsx`

**Objective:** Cmd+K / Ctrl+K opens a searchable command palette. Commands: switch workspace, activate/deactivate plugin, search drafts, navigate to plugin, trigger HALT.

**Acceptance Criteria:**
- [ ] Cmd+K opens palette, Escape closes
- [ ] Fuzzy search over workspace names, plugin names, recent draft subjects
- [ ] "HALT" command present and functional (calls existing HALT API endpoint)

---

#### Task 1.3: Workspace persistence

**Depends on:** Task 1.1
**Produces:** `board/src/lib/workspaces.ts`, DDL migration for `board.workspaces` table

**Objective:** Save and restore workspace layouts (which plugins open, grid positions, per-plugin config) to Postgres via the existing database connection.

**Acceptance Criteria:**
- [ ] Save current layout to named workspace
- [ ] Load workspace restores exact grid layout + plugin configs
- [ ] Preset workspaces (from §8) exist as seed data
- [ ] Workspace switcher in shell sidebar

---

### Batch 2: Data Providers + Core Plugins (4-6 days, parallel per plugin)

#### Task 2.1: Data provider layer

**Depends on:** Batch 1
**Produces:** `board/src/providers/`

**Objective:** Typed React hooks for all 10 data providers. REST for initial load, SSE for real-time updates via Redis pub/sub.

**Requirements:**
1. Each provider: `use[Name]()` hook returning `{ data, loading, error, refetch }`.
2. Write providers additionally return named action functions (e.g., `approveDraft(id)`).
3. SSE endpoint at `/api/events` subscribing to Redis channels, pushing to browser.
4. Automatic reconnection on SSE disconnect (exponential backoff).

**Acceptance Criteria:**
- [ ] All 10 providers return data matching direct API calls
- [ ] Write actions go through existing API endpoints (verified by checking audit log)
- [ ] SSE delivers updates within 3s of brain state change
- [ ] Graceful degradation: if SSE disconnects, plugins still work via REST polling fallback

---

#### Tasks 2.2–2.13: Individual plugin conversions

Each existing page becomes a plugin. The pattern is identical for each:

1. Create plugin file at `board/src/plugins/[name]/index.tsx`
2. Define manifest (id, name, category, data dependencies, write capabilities, default size)
3. Extract the React component from the existing page in `board/src/app/[page]/page.tsx`
4. Replace direct API calls with data provider hooks
5. Register in plugin registry

**Plugins by priority (build order):**

| Priority | Plugin | Complexity | Notes |
|----------|--------|-----------|-------|
| P0 | `optimus.approval-queue` | High | Most interactive. Approve/reject/edit. Mobile-critical. Build first. |
| P0 | `optimus.halt-control` | Low | Safety-critical. Must work. Tiny UI (button + status). |
| P1 | `optimus.today` | Medium | Default landing view. Aggregates from multiple providers. |
| P1 | `optimus.agent-status` | Medium | Extracted from Pipeline page. Real-time agent health. |
| P1 | `optimus.pipeline` | Medium | DAG-adjacent. Task funnel view. |
| P2 | `optimus.signals` | Medium | Signal feed from existing page. |
| P2 | `optimus.cost-tracker` | Low | Read-only charts. Straightforward. |
| P2 | `optimus.governance` | Medium | Gate config + constitutional compliance view. |
| P2 | `optimus.audit-log` | Low | Read-only table with filters. |
| P3 | `optimus.workstation` | High | CLI terminal (xterm.js). Existing code, needs plugin wrapping. |
| P3 | `optimus.dag-view` | Medium | New — SPEC §8 "Active DAG visualization." Uses existing pipeline data. |
| P3 | `optimus.knowledge-base` | Medium | Migrated from legacy inbox dashboard. RAG doc management. |

**Acceptance Criteria (per plugin):**
- [ ] Plugin renders correctly in grid pane at default size
- [ ] Plugin renders correctly when resized (responsive within pane)
- [ ] Plugin handles loading state (skeleton/spinner)
- [ ] Plugin handles error state (error card, retry button)
- [ ] All features from the replaced page are present and functional

---

### Batch 3: Presets + Polish (1-2 days)

#### Task 3.1: Workspace presets

**Depends on:** Batch 2
**Produces:** Seed data for `board.workspaces`, preset switcher UI

**Objective:** Create the 5 workspace presets from §8 as default workspace layouts.

---

#### Task 3.2: Mobile optimization

**Depends on:** Tasks 2.2 (approval queue), 2.5 (agent status)
**Produces:** Mobile-responsive shell behavior

**Objective:** At < 768px viewport, shell switches to single-plugin full-screen view with swipe navigation between active plugins. Approval Queue must be fully usable at 375px.

**Acceptance Criteria:**
- [ ] Approval queue: approve/reject/edit completable at 375px without horizontal scrolling
- [ ] Mobile view: swipe or tab-bar to switch between active plugins
- [ ] Command palette works on mobile (tap, not just keyboard)

---

### Batch 4: Decommission + Deploy (1-2 days)

#### Task 4.1: Legacy dashboard decommission

**Depends on:** EC-7, EC-8 (feature parity confirmed)
**Produces:** Updated compose.yml, redirected domain

**Objective:** Remove inbox-dashboard service, redirect inbox.staqs.io to board.staqs.io.

**Acceptance Criteria:**
- [ ] `inbox-dashboard` service removed from compose.yml and compose.prod.yml
- [ ] inbox.staqs.io redirects to board.staqs.io (Railway domain config)
- [ ] No broken references in CLAUDE.md, README.md, or ONBOARDING.md

---

#### Task 4.2: Railway production deployment

**Depends on:** Task 4.1
**Produces:** Live board.staqs.io with plugin architecture

**Objective:** Deploy to Railway, verify all plugins functional, confirm SSE real-time path works in production.

**Acceptance Criteria:**
- [ ] board.staqs.io serves plugin dashboard
- [ ] All 12 plugins load and function
- [ ] Approve a real draft through the new dashboard
- [ ] Trigger and resume HALT through the new dashboard
- [ ] SSE updates visible within 3s of brain state change

---

## 14. Cost Estimate

| Category | Low | High | Notes |
|----------|-----|------|-------|
| Build effort | 10 days | 14 days | Primary cost. Assumes one developer (Claude Code). |
| New dependencies | $0 | $0 | react-grid-layout, cmdk — both MIT, no license fees. |
| Infrastructure delta | -$5/mo | -$15/mo | Eliminating one Railway service (inbox-dashboard). Net savings. |
| Railway (board.staqs.io) | $0 | $0 | Already running and paid. No change. |
| Database | $0 | $0 | One new table (workspaces). Negligible storage. |

**Total incremental cost:** Negative. This saves money by eliminating a service.

---

## 15. Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| react-grid-layout performs poorly on Railway's container specs | Low | Medium | Test during Batch 1 before building plugins. Kill criteria: > 200ms render. |
| SSE unreliable on Railway (connection drops, proxy timeouts) | Medium | Low | Fallback to REST polling (30s interval). SSE is a nice-to-have, not load-bearing. |
| Feature parity gap discovered late | Medium | High | Task 0.1 audit catches gaps before build starts. Per-plugin QA checklist. |
| Board members dislike the new layout | Low | Medium | Preset workspaces match existing page flows. Custom workspaces let them arrange to preference. Rollback possible via git revert. |
| Existing API endpoints insufficient for plugin data needs | Low | Medium | Data providers wrap existing endpoints. If gaps found, add new endpoints to autobot-inbox API (not a dashboard concern). |

---

## 16. Spec Sections Implemented

| Spec Section | What This PRD Implements |
|-------------|--------------------------|
| §2 — Board interaction layer | Dashboard with task graph + audit log + cost tracking + event digests |
| §8 — Dashboard requirements | Task funnel, cost by tier, agent utilization, latency, DAG visualization, HALT status |
| §8 — Event digests | Real-time SSE push to dashboard |
| §9 — Kill switch UI | HALT control plugin with trigger + resume |
| §14 — Phase 1 deliverables | "Board command interface" — approve/reject tasks, inject directives, trigger HALT |

---

## 17. Open Questions

| # | Question | Impact | Recommendation |
|---|----------|--------|----------------|
| OQ-1 | Should the existing Vercel deployment (dashboard.consultingfutures.com) be redirected to board.staqs.io or kept as a separate artifact? | DNS config, potential confusion. | Redirect to board.staqs.io. One dashboard, one URL. Decommission the Vercel project. |
| OQ-2 | The compose.yml mounts `./dashboard` but the repo directory is `board/`. Is there a symlink, or does Railway use a different build context? | Affects local dev and deployment path. Needs Eric to clarify. | [NEEDS_CLARIFICATION: Is `board/` the actual directory and `./dashboard` in compose.yml a stale reference, or is there a symlink? | Affects: Task 1.1 file paths, Task 4.2 Railway build context] |
| OQ-3 | Should workspace layouts sync across board members (Dustin sees Eric's custom workspaces) or are they per-member? | Schema design for `board.workspaces`. | Per-member. Presets are shared. Custom workspaces are private. Simplest correct answer. |
| OQ-4 | The repo uses `board-query` (DeepSeek) as a utility agent for board question answering. Should this become a plugin with an embedded chat interface? | New plugin beyond the 12 defined. | Defer to Phase 2. Keep the existing board-query interface as-is for now. Add `optimus.board-query` plugin later. |

---

## 18. Board Decision Flags

| # | Decision | Type | Recommendation |
|---|----------|------|----------------|
| BD-1 | Approve plugin architecture rebuild (this PRD) | Strategic | PROCEED — $0 incremental infrastructure cost, eliminates a service, and every future feature is a plugin drop-in instead of a page restructure. |
| BD-2 | Decommission legacy inbox dashboard (port 3100) | Tactical | PROCEED — all features absorbed by plugins. Eliminates maintenance burden and developer confusion (two dashboards for one product). |
| BD-3 | Decommission Vercel deployment (dashboard.consultingfutures.com) | Tactical | PROCEED — consolidate to board.staqs.io on Railway. One dashboard, one URL, one deploy pipeline. |
| BD-4 | Resolve `board/` vs `./dashboard` directory mapping (OQ-2) | Tactical | Needs Eric's input. |

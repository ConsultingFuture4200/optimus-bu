# Requirements: Board Workstation Plugin Rebuild

**Defined:** 2026-04-05
**Core Value:** The board's operational control surface works reliably through composable plugins — and every future feature drops in as a plugin instead of restructuring a monolith.

## v1 Requirements

### Shell Infrastructure

- [ ] **SHELL-01**: Plugin shell renders draggable/resizable grid panes via react-grid-layout
- [ ] **SHELL-02**: Plugin registry loads all plugins at build time (compile-time imports, no runtime loading)
- [ ] **SHELL-03**: Plugin lifecycle calls onActivate() when pane opens and onDeactivate() when closed
- [ ] **SHELL-04**: React error boundary per plugin pane — crash shows error card with retry, does not affect adjacent plugins
- [ ] **SHELL-05**: Error boundaries handle async errors via useErrorBoundary hook (not just render errors)
- [ ] **SHELL-06**: Layout serializes to JSON and restores from JSON exactly (round-trip fidelity)
- [ ] **SHELL-07**: Grid shell uses `ssr: false` / dynamic import with mounted guard to prevent hydration mismatch
- [ ] **SHELL-08**: Shell loads in < 2s on desktop, < 3s on mobile
- [ ] **SHELL-09**: Plugin activation time < 500ms per plugin

### Command Palette

- [ ] **CMD-01**: Cmd+K / Ctrl+K opens command palette, Escape closes
- [ ] **CMD-02**: Fuzzy search over workspace names, plugin names, and recent draft subjects
- [ ] **CMD-03**: HALT command present and functional (calls existing HALT API endpoint)
- [ ] **CMD-04**: Command palette responsive < 100ms from keystroke to results
- [ ] **CMD-05**: Command palette works on mobile (tap activation, not just keyboard)

### Workspace Persistence

- [ ] **WKSP-01**: Save current layout to named workspace in Postgres (board.workspaces table)
- [ ] **WKSP-02**: Load workspace restores exact grid layout + per-plugin configs
- [ ] **WKSP-03**: 5 preset workspaces seeded (Daily Ops, Pipeline, Governance, Command, Cost Review)
- [ ] **WKSP-04**: Workspace switcher in shell sidebar
- [ ] **WKSP-05**: Workspaces are per-member; presets are shared
- [ ] **WKSP-06**: Workspace schema includes schemaVersion field for future migration safety

### Data Providers

- [ ] **DATA-01**: 10 typed React hooks (useDrafts, usePipeline, useSignals, useAgents, useCost, useGovernance, useSystemStatus, useAuditLog, useKnowledge, useTodayBrief)
- [ ] **DATA-02**: Each hook returns { data, loading, error, refetch }
- [ ] **DATA-03**: Write providers expose named action functions (approveDraft, rejectDraft, etc.), not generic setters
- [ ] **DATA-04**: All write actions POST to existing API endpoints — dashboard never writes directly to Postgres
- [ ] **DATA-05**: SSE endpoint at /api/events subscribes to Redis channels and pushes to browser
- [ ] **DATA-06**: SSE client reconnects automatically with exponential backoff
- [ ] **DATA-07**: REST polling fallback (30s interval) when SSE disconnects
- [ ] **DATA-08**: Real-time update visible in dashboard < 3s after brain state change
- [ ] **DATA-09**: All 10 providers return data matching direct API calls (100% accuracy)
- [ ] **DATA-10**: SSE route uses `new Response(stream)` with `X-Accel-Buffering: no` header (not NextResponse)

### Core Plugins — P0 (Safety-Critical)

- [ ] **PLG-01**: Approval Queue plugin — approve, reject, edit drafts with identical behavior to existing page
- [ ] **PLG-02**: Approval Queue renders correctly at default size and when resized (responsive within pane)
- [ ] **PLG-03**: Approval Queue handles loading/error states (skeleton, error card with retry)
- [ ] **PLG-04**: Approval Queue fully usable at 375px mobile width without horizontal scrolling
- [ ] **PLG-05**: HALT Control plugin — trigger HALT and resume via existing API endpoints
- [ ] **PLG-06**: HALT Control reachable within 2 keystrokes from any workspace
- [ ] **PLG-07**: HALT Control never depends solely on SSE state — always has polling fallback for current status

### Core Plugins — P1

- [ ] **PLG-08**: Today Brief plugin — aggregates from today, drafts, signals providers
- [ ] **PLG-09**: Agent Status plugin — real-time agent health extracted from Pipeline page
- [ ] **PLG-10**: Pipeline plugin — task funnel view with agent data

### Core Plugins — P2

- [ ] **PLG-11**: Signal Feed plugin — signal feed from existing page
- [ ] **PLG-12**: Cost Tracker plugin — read-only cost charts via recharts
- [ ] **PLG-13**: Governance plugin — gate config + constitutional compliance view with write capability
- [ ] **PLG-14**: Audit Log plugin — read-only table with filters

### Core Plugins — P3

- [ ] **PLG-15**: CLI Workstation plugin — xterm.js terminal wrapped as plugin
- [ ] **PLG-16**: DAG Visualization plugin — active DAG view per SPEC §8, uses pipeline data
- [ ] **PLG-17**: Knowledge Base plugin — RAG doc management migrated from legacy inbox dashboard

### Plugin Standards (All Plugins)

- [ ] **PSTD-01**: Every plugin defines a manifest (id, name, version, category, dataDependencies, defaultSize, mobileSupported)
- [ ] **PSTD-02**: Every plugin renders correctly at default size and when resized
- [ ] **PSTD-03**: Every plugin handles loading state and error state
- [ ] **PSTD-04**: Plugin boilerplate < 50 lines per plugin (kill criterion)
- [ ] **PSTD-05**: All features from replaced pages are present and functional (feature parity)

### Mobile

- [ ] **MOBL-01**: At < 768px viewport, shell switches to single-plugin full-screen view
- [ ] **MOBL-02**: Swipe or tab-bar navigation between active plugins on mobile
- [ ] **MOBL-03**: Drag/resize disabled at mobile breakpoint (touch conflict prevention)

### Legacy Decommission

- [ ] **DECOM-01**: inbox-dashboard service removed from compose.yml and compose.prod.yml
- [ ] **DECOM-02**: inbox.staqs.io redirects to board.staqs.io (Railway domain config)
- [ ] **DECOM-03**: No broken references in CLAUDE.md, README.md, or ONBOARDING.md
- [ ] **DECOM-04**: autobot-inbox/dashboard/ directory removed from repo

### Deployment

- [ ] **DEPLOY-01**: board.staqs.io serves plugin dashboard on Railway
- [ ] **DEPLOY-02**: All 12 plugins load and function in production
- [ ] **DEPLOY-03**: Approve a real draft through the new dashboard (end-to-end verification)
- [ ] **DEPLOY-04**: Trigger and resume HALT through the new dashboard (end-to-end verification)
- [ ] **DEPLOY-05**: SSE updates visible within 3s of brain state change in production

## v2 Requirements

### Deferred Features

- **CHAT-01**: board-query utility agent as embedded chat plugin (optimus.board-query)
- **THEME-01**: Dark mode / theme switching
- **NOTIF-01**: Browser push notifications for state transitions
- **SHARE-01**: Cross-member workspace sharing (currently per-member only)
- **RUNTIME-01**: Runtime plugin loading (dynamic imports from URL)

## Out of Scope

| Feature | Reason |
|---------|--------|
| New API layer or database | Brain connection already exists at port 3001 (PRD §1) |
| Runtime plugin loading | All plugins first-party, compile-time only (PRD §5.3) |
| Plugin sandboxing (iframes/workers) | Plugins run in same React tree — no trust boundary needed (PRD Task 1.1) |
| Changes to agent runtime / gates G1-G8 | Untouched by this rebuild (PRD §1) |
| Vercel deployment redirect | Pending board decision BD-3, separate from this project |
| next-auth v5 upgrade | Still beta, gratuitous scope creep (research) |
| Tailwind v4 upgrade | Breaking config changes, no value for this rebuild (research) |
| RBAC / user management | Only 2 board members, existing NextAuth sufficient (research) |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SHELL-01 | Phase 1 | Pending |
| SHELL-02 | Phase 1 | Pending |
| SHELL-03 | Phase 1 | Pending |
| SHELL-04 | Phase 1 | Pending |
| SHELL-05 | Phase 1 | Pending |
| SHELL-06 | Phase 1 | Pending |
| SHELL-07 | Phase 1 | Pending |
| SHELL-08 | Phase 1 | Pending |
| SHELL-09 | Phase 1 | Pending |
| DATA-01 | Phase 2 | Pending |
| DATA-02 | Phase 2 | Pending |
| DATA-03 | Phase 2 | Pending |
| DATA-04 | Phase 2 | Pending |
| DATA-05 | Phase 2 | Pending |
| DATA-06 | Phase 2 | Pending |
| DATA-07 | Phase 2 | Pending |
| DATA-08 | Phase 2 | Pending |
| DATA-09 | Phase 2 | Pending |
| DATA-10 | Phase 2 | Pending |
| PLG-01 | Phase 3 | Pending |
| PLG-02 | Phase 3 | Pending |
| PLG-03 | Phase 3 | Pending |
| PLG-04 | Phase 3 | Pending |
| PLG-05 | Phase 3 | Pending |
| PLG-06 | Phase 3 | Pending |
| PLG-07 | Phase 3 | Pending |
| PLG-08 | Phase 3 | Pending |
| PLG-09 | Phase 3 | Pending |
| PLG-10 | Phase 3 | Pending |
| PLG-11 | Phase 3 | Pending |
| PLG-12 | Phase 3 | Pending |
| PLG-13 | Phase 3 | Pending |
| PLG-14 | Phase 3 | Pending |
| PLG-15 | Phase 3 | Pending |
| PLG-16 | Phase 3 | Pending |
| PLG-17 | Phase 3 | Pending |
| PSTD-01 | Phase 3 | Pending |
| PSTD-02 | Phase 3 | Pending |
| PSTD-03 | Phase 3 | Pending |
| PSTD-04 | Phase 3 | Pending |
| PSTD-05 | Phase 3 | Pending |
| CMD-01 | Phase 4 | Pending |
| CMD-02 | Phase 4 | Pending |
| CMD-03 | Phase 4 | Pending |
| CMD-04 | Phase 4 | Pending |
| CMD-05 | Phase 4 | Pending |
| WKSP-01 | Phase 4 | Pending |
| WKSP-02 | Phase 4 | Pending |
| WKSP-03 | Phase 4 | Pending |
| WKSP-04 | Phase 4 | Pending |
| WKSP-05 | Phase 4 | Pending |
| WKSP-06 | Phase 4 | Pending |
| MOBL-01 | Phase 4 | Pending |
| MOBL-02 | Phase 4 | Pending |
| MOBL-03 | Phase 4 | Pending |
| DECOM-01 | Phase 5 | Pending |
| DECOM-02 | Phase 5 | Pending |
| DECOM-03 | Phase 5 | Pending |
| DECOM-04 | Phase 5 | Pending |
| DEPLOY-01 | Phase 5 | Pending |
| DEPLOY-02 | Phase 5 | Pending |
| DEPLOY-03 | Phase 5 | Pending |
| DEPLOY-04 | Phase 5 | Pending |
| DEPLOY-05 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 55 total
- Mapped to phases: 55/55
- Unmapped: 0

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 — traceability completed by roadmapper*

# Roadmap: Board Workstation Plugin Rebuild

## Overview

Brownfield rebuild of 16 fixed Next.js 15 pages into a composable plugin-host workspace. The dependency chain is strict: the grid shell must exist before data hooks, data hooks before plugins, plugins before the command palette and workspace presets, and everything before decommissioning the legacy inbox dashboard. Five phases follow that chain directly. P0 safety-critical plugins (HALT Control, Approval Queue) ship in Phase 3 before any other plugins and before any legacy page is removed.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Shell Scaffold** - Build the plugin grid harness with error boundaries, workspace schema, and SSE safety foundation (completed 2026-04-06)
- [ ] **Phase 2: Data Provider Layer** - Build all 10 typed SWR hooks, 3 mutation hooks, and real-time SSE invalidation
- [ ] **Phase 3: Core Plugins** - Build all 12 plugins (P0 safety-critical first, then P1/P2/P3)
- [ ] **Phase 4: Command Palette, Presets, and Mobile** - Add keyboard navigation, workspace presets, and mobile breakpoint behavior
- [ ] **Phase 5: Decommission and Deploy** - Verify feature parity, remove legacy dashboard, redirect domain, ship to Railway

## Phase Details

### Phase 1: Shell Scaffold
**Goal**: The plugin grid harness renders correctly in production with no hydration errors, each plugin slot is crash-isolated via error boundaries, and the workspace schema is versioned from day one
**Depends on**: Nothing (first phase)
**Requirements**: SHELL-01, SHELL-02, SHELL-03, SHELL-04, SHELL-05, SHELL-06, SHELL-07, SHELL-08, SHELL-09
**Success Criteria** (what must be TRUE):
  1. Board member opens the new dashboard URL and sees a drag/resize grid with a stub plugin — no hydration errors, no blank screen
  2. Board member can drag and resize a plugin pane and the layout serializes to JSON and restores exactly on page reload
  3. A plugin that throws a render error shows an error card with retry — adjacent plugins continue working
  4. Shell loads in under 2s on desktop and under 3s on mobile
  5. board.workspaces Postgres table exists with schemaVersion field; migrateWorkspace() function exists before any layout is saved
**Plans**: 3 plans
Plans:
- [x] 01-01-PLAN.md — Foundation: deps, plugin types, registry, error boundary, DB setup, DDL
- [x] 01-02-PLAN.md — Grid shell: PluginShell, GridArea, PluginPane, stub plugins, layout swap
- [x] 01-03-PLAN.md — Workspace persistence: workspaces lib, API route, auto-save/load, human verify
**UI hint**: yes

### Phase 2: Data Provider Layer
**Goal**: All plugins have typed, tested data access through SWR hooks with real-time SSE invalidation and a mandatory polling fallback — no plugin ever writes directly to Postgres
**Depends on**: Phase 1
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07, DATA-08, DATA-09, DATA-10
**Success Criteria** (what must be TRUE):
  1. Any plugin calling a data hook receives { data, loading, error, refetch } with data matching a direct API call (100% accuracy)
  2. A write action (approve draft, reject draft, toggle HALT) POSTs to the existing port 3001 API — never touches Postgres directly
  3. SSE connects, disconnects, and reconnects automatically with exponential backoff; real-time update appears in dashboard within 3s of brain state change
  4. If SSE is disconnected, REST polling at 30s interval keeps data current — HALT status never goes stale
**Plans**: 3 plans
Plans:
- [x] 01-01-PLAN.md — Foundation: deps, plugin types, registry, error boundary, DB setup, DDL
- [x] 01-02-PLAN.md — Grid shell: PluginShell, GridArea, PluginPane, stub plugins, layout swap
- [ ] 01-03-PLAN.md — Workspace persistence: workspaces lib, API route, auto-save/load, human verify

### Phase 3: Core Plugins
**Goal**: All 12 plugins are built and functional with feature parity to the 16 pages they replace — HALT Control and Approval Queue ship first and are reviewed before any other plugin
**Depends on**: Phase 2
**Requirements**: PLG-01, PLG-02, PLG-03, PLG-04, PLG-05, PLG-06, PLG-07, PLG-08, PLG-09, PLG-10, PLG-11, PLG-12, PLG-13, PLG-14, PLG-15, PLG-16, PLG-17, PSTD-01, PSTD-02, PSTD-03, PSTD-04, PSTD-05
**Success Criteria** (what must be TRUE):
  1. Board member can trigger HALT and resume from HALT Control plugin via direct REST POST — HALT is never gated on SSE connection state
  2. Board member can approve, reject, and edit a draft from the Approval Queue plugin at 375px mobile width without horizontal scrolling
  3. All 12 plugins render correctly at default size and when resized; each handles loading state (skeleton) and error state (error card with retry)
  4. Every plugin's boilerplate is under 50 lines; each plugin manifest declares id, name, version, category, dataDependencies, defaultSize, mobileSupported
  5. Feature parity matrix signed off — every function from all 16 replaced pages is present in the new plugins
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Foundation: deps, plugin types, registry, error boundary, DB setup, DDL
- [ ] 01-02-PLAN.md — Grid shell: PluginShell, GridArea, PluginPane, stub plugins, layout swap
- [ ] 01-03-PLAN.md — Workspace persistence: workspaces lib, API route, auto-save/load, human verify
**UI hint**: yes

### Phase 4: Command Palette, Presets, and Mobile
**Goal**: Board members navigate the entire workspace by keyboard, switch between 5 preset layouts, and use the dashboard fully on mobile
**Depends on**: Phase 3
**Requirements**: CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, WKSP-01, WKSP-02, WKSP-03, WKSP-04, WKSP-05, WKSP-06, MOBL-01, MOBL-02, MOBL-03
**Success Criteria** (what must be TRUE):
  1. Cmd+K opens the command palette in under 100ms; board member can reach HALT within 2 keystrokes from any workspace
  2. Board member saves a custom layout, reloads the page, and the exact grid layout and per-plugin configs restore
  3. Board member selects a preset (Daily Ops, Pipeline, Governance, Command, Cost Review) and that layout loads without overwriting their personal saved workspace
  4. At 375px viewport width, the shell switches to single-plugin full-screen; board member swipes or taps to navigate between active plugins; drag/resize are disabled
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Foundation: deps, plugin types, registry, error boundary, DB setup, DDL
- [ ] 01-02-PLAN.md — Grid shell: PluginShell, GridArea, PluginPane, stub plugins, layout swap
- [ ] 01-03-PLAN.md — Workspace persistence: workspaces lib, API route, auto-save/load, human verify
**UI hint**: yes

### Phase 5: Decommission and Deploy
**Goal**: The new plugin dashboard is live in production, the legacy inbox dashboard is removed, and inbox.staqs.io redirects to board.staqs.io
**Depends on**: Phase 4
**Requirements**: DECOM-01, DECOM-02, DECOM-03, DECOM-04, DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, DEPLOY-05
**Success Criteria** (what must be TRUE):
  1. board.staqs.io serves the plugin dashboard on Railway; all 12 plugins load and function in production
  2. Board member approves a real draft end-to-end through the new dashboard; board member triggers and resumes HALT through the new dashboard
  3. SSE updates are visible within 3s of brain state change in production
  4. inbox.staqs.io redirects to board.staqs.io; inbox-dashboard service is removed from compose.yml and compose.prod.yml; autobot-inbox/dashboard/ directory is removed from the repo
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Foundation: deps, plugin types, registry, error boundary, DB setup, DDL
- [ ] 01-02-PLAN.md — Grid shell: PluginShell, GridArea, PluginPane, stub plugins, layout swap
- [ ] 01-03-PLAN.md — Workspace persistence: workspaces lib, API route, auto-save/load, human verify

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Shell Scaffold | 3/3 | Complete   | 2026-04-06 |
| 2. Data Provider Layer | 0/TBD | Not started | - |
| 3. Core Plugins | 0/TBD | Not started | - |
| 4. Command Palette, Presets, and Mobile | 0/TBD | Not started | - |
| 5. Decommission and Deploy | 0/TBD | Not started | - |

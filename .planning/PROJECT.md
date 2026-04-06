# Board Workstation Plugin Rebuild

## What This Is

A frontend rebuild of the Board Workstation (`board/src/app/`) from 16 fixed Next.js pages to a composable plugin-host workspace architecture, plus decommissioning the legacy inbox dashboard (`autobot-inbox/dashboard/`, port 3100). One codebase, one deployment, one port. The plugin shell consumes the existing autobot-inbox API (port 3001) — the brain connection is already built, we're replacing the frontend that renders it.

## Core Value

The board's operational control surface (approve drafts, trigger HALT, monitor agents, review costs) works reliably through composable plugins that board members can arrange to their workflow — and every future feature drops in as a plugin instead of restructuring a monolith.

## Requirements

### Validated

- ✓ Board Workstation running at board.staqs.io (port 3200) — existing
- ✓ NextAuth GitHub OAuth (BOARD_MEMBERS: ecgang, ConsultingFuture4200) — existing
- ✓ 16 fixed pages serving board operations — existing (being replaced)
- ✓ autobot-inbox API at port 3001 with all endpoints — existing (untouched)
- ✓ Redis pub/sub event relay — existing
- ✓ Legacy inbox dashboard at port 3100 — existing (being decommissioned)

### Active

- [ ] Plugin shell with react-grid-layout (drag/resize/reorder grid panes)
- [ ] Plugin lifecycle (register/activate/deactivate) with error boundaries
- [ ] Command palette (Cmd+K) with fuzzy search over workspaces, plugins, drafts
- [ ] Workspace persistence to Postgres (save/restore layouts + plugin configs)
- [ ] 10 typed data provider hooks (REST + SSE real-time updates via Redis)
- [ ] 12 core plugins replacing all 16 existing pages
- [ ] Approval Queue plugin with approve/reject/edit (P0 — most interactive, mobile-critical)
- [ ] HALT Control plugin (P0 — safety-critical)
- [ ] 5 workspace presets (Daily Ops, Pipeline, Governance, Command, Cost Review)
- [ ] Mobile optimization (single-plugin full-screen at <768px, swipe navigation)
- [ ] Legacy inbox dashboard decommissioned (service removed, domain redirected)
- [ ] Railway production deployment verified

### Out of Scope

- New API layer or database — brain connection already exists (PRD §1)
- Runtime plugin loading (dynamic imports from URL) — all plugins compile-time (PRD §5.3)
- Plugin sandboxing (iframes, web workers) — plugins run in same React tree (PRD Task 1.1)
- board-query chat plugin — defer to Phase 2 (PRD OQ-4)
- Changes to agent runtime, constitutional gates G1-G8, or task graph — untouched (PRD §1)
- Vercel deployment (dashboard.consultingfutures.com) — pending board decision BD-3

## Context

- **Existing codebase:** `board/` is a Next.js 15 App Router project with TypeScript, already deployed to Railway at board.staqs.io
- **Existing API:** autobot-inbox at port 3001 — 18 agents, G1-G8 gates, Postgres (96 tables, 5 schemas), Neo4j, Redis, RAG pipeline
- **Three data paths:** REST reads, REST+guardCheck writes, Redis→SSE real-time updates — all existing infrastructure
- **New dependencies:** `react-grid-layout` (layout engine, MIT, 19K+ stars) and `cmdk` (command palette, MIT, Vercel-maintained). Both <50KB gzipped.
- **Design principles:** D1 read-only by default, D2 infrastructure enforces writes, D3 every action logged, D4 boring stack, D5 keyboard-first, D6 plugin crash isolation
- **Kill criteria defined:** Shell+Approval >5 days = abort, >200ms render latency = abort, >50 lines boilerplate per plugin = abort, >5s SSE latency vs polling = abort, any workflow slower than before = abort
- **Open questions:** OQ-2 (board/ vs ./dashboard directory mapping needs Eric), OQ-1 (Vercel redirect), OQ-3 (per-member workspaces — recommended)

## Constraints

- **Framework**: Next.js 15 App Router — already in use, no migration
- **Language**: TypeScript — existing board codebase
- **Runtime**: Node.js >= 20.0.0, ES modules throughout
- **Database**: Supabase (Postgres + pgvector) — one new table (board.workspaces), no new schema
- **Auth**: NextAuth GitHub OAuth — already configured
- **Hosting**: Railway — board decision, no change
- **Package manager**: npm — repo-wide constraint
- **Timeline**: 10-14 days build effort
- **Budget**: $0 incremental infrastructure — net savings from eliminating inbox-dashboard service
- **Spec alignment**: SPEC §2 (board interaction), §8 (dashboard/observability), §9 (kill switch UI)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| react-grid-layout for layout engine | Battle-tested (Grafana, Datadog, Jupyter), MIT, 19K+ stars | — Pending |
| cmdk for command palette | Tiny bundle, keyboard-first, Vercel-maintained | — Pending |
| First-party plugins only (compile-time) | Simpler, no security boundary needed, all plugins are ours | — Pending |
| Per-member workspaces, shared presets | Simplest correct answer (PRD OQ-3 recommendation) | — Pending |
| SSE with REST polling fallback | SSE may be unreliable on Railway; polling is the safety net | — Pending |
| Plugin crash isolation via React error boundaries | Crashing plugin shows error card, doesn't take down workspace | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-05 after initialization*

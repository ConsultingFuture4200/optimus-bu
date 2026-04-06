---
phase: 01-shell-scaffold
plan: "03"
subsystem: board-workstation
tags: [workspace-persistence, api-routes, auto-save, grid-layout]
dependency_graph:
  requires: ["01-02"]
  provides: ["workspace-persistence", "auto-save-load", "workspaces-api"]
  affects: ["board/src/components/GridArea.tsx"]
tech_stack:
  added: []
  patterns:
    - "Debounce hook (useDebounce) for batching rapid layout changes before API save"
    - "isInitialLoad ref guard to skip auto-save before workspace is loaded from server"
    - "Non-blocking workspace load — grid renders with default, swaps on fetch resolve"
    - "Upsert via ON CONFLICT (member_id, name) for idempotent saves"
    - "getSession() wrapper from @/lib/auth for API route auth (next-auth v4)"
key_files:
  created:
    - board/src/lib/workspaces.ts
    - board/src/app/api/workspaces/route.ts
  modified:
    - board/src/components/GridArea.tsx
decisions:
  - "Used getSession() wrapper from @/lib/auth instead of direct getServerSession(authOptions) — matches existing ops/route.ts pattern"
  - "Layout type in WorkspaceLayout.items is Layout (readonly LayoutItem[]) not LayoutItem[] — consistent with GridArea state type"
  - "isInitialLoad.current set to false in .finally() of load fetch — ensures auto-save never fires with stale default before server layout resolves"
  - "migrateWorkspace() called on PUT (save) as well as GET (load) — forward-compatibility on both paths"
metrics:
  duration_seconds: 520
  completed_date: "2026-04-06"
  tasks_completed: 2
  tasks_total: 3
  files_changed: 3
requirements_closed:
  - SHELL-06
  - SHELL-08
  - SHELL-09
---

# Phase 01 Plan 03: Workspace Persistence Summary

**One-liner:** Workspace persistence via Postgres upsert with debounced auto-save (2500ms) and non-blocking on-mount load using the board's existing session auth pattern.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create workspaces library and API route | c87cfc9 | board/src/lib/workspaces.ts, board/src/app/api/workspaces/route.ts |
| 2 | Wire auto-save and auto-load into GridArea | a4d8bcc | board/src/components/GridArea.tsx |
| 3 | Human verification of shell scaffold | — | checkpoint:human-verify (pending) |

## What Was Built

**board/src/lib/workspaces.ts** — Workspace persistence library:
- `WorkspaceLayout` type: `{ schemaVersion, items: Layout, pluginConfigs }`
- `DAILY_OPS_PRESET` — first-visit default (today-brief, approval-queue, agent-status)
- `migrateWorkspace(raw)` — version migration gate, runs on every load (currently v1 baseline, extension point for future migrations)
- `getWorkspace(memberId, name)` — SELECT with preset fallback
- `saveWorkspace(memberId, name, layout)` — INSERT ... ON CONFLICT upsert
- All SQL parameterized with `$1, $2, ...` (P4 compliant, no string interpolation)

**board/src/app/api/workspaces/route.ts** — REST API:
- `GET /api/workspaces?name=Daily+Ops` — loads workspace, returns WorkspaceLayout JSON
- `PUT /api/workspaces` — saves workspace (runs migrateWorkspace on save body)
- Both routes check `getSession()` and return `401` before any DB access (P1/P2)
- `member_id` is always `session.user.name` — client cannot supply it

**board/src/components/GridArea.tsx** — Modified for persistence:
- `useDebounce` hook (2500ms) — batches drag/resize events, prevents excessive saves
- `useEffect` on mount: `GET /api/workspaces` → `setLayout(data.items)` on success
- `useEffect` on `debouncedLayout`: `PUT /api/workspaces` with full WorkspaceLayout payload
- `isInitialLoad` ref: blocks auto-save until after the initial load fetch resolves
- Both fetch paths have `.catch()` with `console.warn` — no user-visible errors (Phase 1)
- Grid renders default layout immediately (non-blocking SHELL-08 performance requirement)

## Verification

- `npm run build` — passes (no TypeScript errors, no build errors)
- `npx tsc --noEmit` — no errors in any of the 3 files
- All acceptance criteria manually verified via grep

## Deviations from Plan

**1. [Rule 1 - Consistency] Used `getSession()` wrapper instead of direct `getServerSession(authOptions)`**
- Found during: Task 1
- Issue: Plan showed `getServerSession(authOptions)` directly, but existing ops/route.ts uses the `getSession()` wrapper from @/lib/auth
- Fix: Used `import { getSession } from '@/lib/auth'` — matches established pattern, reduces import surface
- Files modified: board/src/app/api/workspaces/route.ts
- Commit: c87cfc9

No other deviations. Plan executed as written.

## Known Stubs

None introduced in this plan. The workspace API and auto-save/load are fully wired to real Postgres via `query()`. The stub plugins from Plan 01-02 remain intentional stubs — they will be replaced by real plugins in Phase 2.

## Checkpoint Pending

Task 3 is a `checkpoint:human-verify` gate. The board member needs to:
1. Run `cd board && npm run dev` (port 3200)
2. Verify 3 stub plugin panes in Daily Ops layout
3. Verify drag/resize works
4. Verify layout persists after reload (requires DATABASE_URL + board.workspaces table)
5. Verify no hydration errors in browser console
6. Verify shell loads under 2 seconds

## Self-Check: PASSED

- board/src/lib/workspaces.ts: FOUND
- board/src/app/api/workspaces/route.ts: FOUND
- board/src/components/GridArea.tsx: FOUND
- Commit c87cfc9: FOUND
- Commit a4d8bcc: FOUND

---
phase: 01-shell-scaffold
plan: 01
subsystem: ui
tags: [react-grid-layout, pg, typescript, plugin-system, postgres]

# Dependency graph
requires: []
provides:
  - Plugin type contract (PluginManifest, PluginProps, OptimusPlugin interfaces)
  - Plugin registry (registerPlugin, getPlugin, getAllPlugins, getPluginIds)
  - PluginErrorBoundary class component with usePluginError hook
  - Postgres Pool (db.ts) for board API routes
  - board.workspaces DDL (001-board-schema.sql)
  - react-grid-layout and pg installed in board/
affects:
  - 01-02
  - 01-03
  - all plugin implementations in phase 1

# Tech tracking
tech-stack:
  added:
    - react-grid-layout (drag/resize grid layout engine)
    - pg (Postgres client for board API routes)
    - "@types/pg"
  patterns:
    - Plugin type contract via OptimusPlugin interface — all plugins implement against this
    - Compile-time plugin registry using Map<string, OptimusPlugin> — no runtime URL loading
    - Class component error boundary wrapping async error context for per-pane crash isolation
    - Raw pg Pool with parameterized queries (P4 boring infrastructure, P1 deny by default)

key-files:
  created:
    - board/src/lib/plugin-types.ts
    - board/src/lib/plugin-registry.ts
    - board/src/components/PluginErrorBoundary.tsx
    - board/src/lib/db.ts
    - board/sql/001-board-schema.sql
  modified:
    - board/package.json
    - board/src/app/globals.css

key-decisions:
  - "Plugin registry is compile-time only (Map in module scope) — no dynamic URL loading per SHELL-02"
  - "PluginErrorBoundary uses AsyncErrorWrapper inner component to bridge class boundary with context-based async error triggering"
  - "member_id in board.workspaces is TEXT (GitHub username), not a FK — no cross-schema foreign keys per CLAUDE.md P2"
  - "react-grid-layout CSS imported at top of globals.css before @tailwind directives"

patterns-established:
  - "Plugin contract: all plugins export a manifest + component matching OptimusPlugin interface"
  - "Error boundary: PluginErrorBoundary wraps each plugin pane; usePluginError hook for async errors"
  - "DB access: import { query } from @/lib/db — raw pg, parameterized queries only"

requirements-completed:
  - SHELL-02
  - SHELL-03
  - SHELL-04
  - SHELL-05

# Metrics
duration: 15min
completed: 2026-04-06
---

# Phase 01-shell-scaffold Plan 01: Foundation Types and Infrastructure Summary

**Plugin type contract (PluginManifest/PluginProps/OptimusPlugin), compile-time registry, per-pane PluginErrorBoundary with usePluginError hook, pg Pool, and board.workspaces DDL — all foundational scaffolding for the plugin host**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-06T00:00:00Z
- **Completed:** 2026-04-06T00:15:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Installed react-grid-layout and pg; added CSS imports to globals.css
- Created full plugin type contract with PluginManifest, PluginProps, OptimusPlugin interfaces including onActivate/onDeactivate lifecycle hooks (SHELL-03)
- Created compile-time plugin registry with register/get/getAll/getIds functions
- Created PluginErrorBoundary class component with exact UI-SPEC error card design (role=alert, retry, collapsible details), plus usePluginError hook for async error triggering via context (SHELL-05)
- Created db.ts with pg Pool for board API routes (no ORM, raw parameterized queries per P4)
- Created board/sql/001-board-schema.sql with board.workspaces table including all D-13 columns

## Task Commits

Each task was committed atomically:

1. **Task 1: Install deps, plugin type contract, and plugin registry** - `20f156d` (feat)
2. **Task 2: PluginErrorBoundary, board db connection, and workspace DDL** - `cc211ca` (feat)

## Files Created/Modified
- `board/package.json` - Added react-grid-layout, pg, @types/pg dependencies
- `board/src/app/globals.css` - Added @import for react-grid-layout and react-resizable CSS at top
- `board/src/lib/plugin-types.ts` - PluginManifest, PluginProps, OptimusPlugin interfaces
- `board/src/lib/plugin-registry.ts` - Compile-time Map-based plugin registry
- `board/src/components/PluginErrorBoundary.tsx` - Class error boundary with error card UI and usePluginError hook
- `board/src/lib/db.ts` - pg Pool configured with DATABASE_URL, query helper
- `board/sql/001-board-schema.sql` - board.workspaces DDL with all D-13 columns

## Decisions Made
- Plugin registry is compile-time only using a module-level Map — no runtime dynamic loading per SHELL-02
- PluginErrorBoundary uses an inner `AsyncErrorWrapper` functional component to bridge the class boundary with React context, enabling the `usePluginError` hook pattern for async error triggering without window.onerror
- board.workspaces.member_id is TEXT (GitHub username from NextAuth), not a foreign key — enforces no cross-schema foreign keys per CLAUDE.md constraint
- react-grid-layout CSS @imports placed before @tailwind directives in globals.css to ensure correct cascade ordering

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None — no external service configuration required for this plan. The DATABASE_URL env var must be set before the board API routes using db.ts can connect, but this is pre-existing infrastructure.

## Next Phase Readiness
- Plugin type contract is exported and stable — Plans 01-02 and 01-03 can import from plugin-types.ts
- Plugin registry is ready to receive registerPlugin() calls from stub plugins in Plan 01-02
- PluginErrorBoundary is ready to wrap plugin panes in Plan 01-02
- board.workspaces DDL is ready to apply to Supabase for workspace persistence in Plan 01-03
- TypeScript passes with no errors (`npx tsc --noEmit` clean)

## Self-Check: PASSED

- FOUND: board/src/lib/plugin-types.ts
- FOUND: board/src/lib/plugin-registry.ts
- FOUND: board/src/components/PluginErrorBoundary.tsx
- FOUND: board/src/lib/db.ts
- FOUND: board/sql/001-board-schema.sql
- FOUND: commit 20f156d
- FOUND: commit cc211ca

---
*Phase: 01-shell-scaffold*
*Completed: 2026-04-06*

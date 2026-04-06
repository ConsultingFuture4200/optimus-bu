# Phase 1: Shell Scaffold - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the plugin grid harness that replaces the current 3-panel BoardShell layout. The shell renders a drag/resize grid via react-grid-layout v2, wraps each plugin slot in a crash-isolated error boundary, persists workspace layouts to Postgres, and renders hydration-safe in Next.js 15. This phase delivers the empty shell with a stub plugin — real plugins come in Phase 3.

Requirements: SHELL-01 through SHELL-09.

</domain>

<decisions>
## Implementation Decisions

### Shell Architecture
- **D-01:** Replace BoardShell and PanelLayout entirely with a new PluginShell component. BoardShell's 3-panel react-resizable-panels layout is retired.
- **D-02:** SideNav remains as a fixed sidebar outside the grid (not a plugin). It sits to the left of the GridArea.
- **D-03:** ChatPanel becomes a grid plugin — draggable, resizable, closeable. No longer a fixed panel.
- **D-04:** HeaderBar stays fixed above the grid. Contains branding, auth, connection status. Grid lives below it.
- **D-05:** Layout hierarchy: `layout.tsx → HeaderBar + PluginShell (SideNav + GridArea)`. Existing provider stack (SessionProvider → ApiKeyProvider → EventStreamProvider → ChatSessionProvider → PageContextProvider) is preserved in layout.tsx.

### Grid Configuration
- **D-06:** 12-column grid layout (standard dashboard grid).
- **D-07:** 30px row height.
- **D-08:** No-overlap mode with auto-push — dragging a plugin pushes adjacent plugins out of the way.
- **D-09:** Placeholder highlight only during drag — no visible grid lines or snap indicators.
- **D-10:** Default first-visit layout loads the "Daily Ops" preset: Today Brief (6 cols) + Approval Queue (6 cols) top row, Agent Status (12 cols) bottom row. In Phase 1, these are stub placeholders since real plugins don't exist yet.

### Workspace Persistence
- **D-11:** board.workspaces table lives in the existing Supabase Postgres instance under a new `board` schema. No new database.
- **D-12:** Single JSONB `layout` column containing the full serialized react-grid-layout state (positions, sizes, plugin IDs, per-plugin configs).
- **D-13:** Table schema: `id UUID PK, member_id TEXT NOT NULL, name TEXT NOT NULL, layout JSONB NOT NULL, schema_version INT DEFAULT 1, is_preset BOOL DEFAULT false, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(member_id, name)`.
- **D-14:** Debounced auto-save on every layout change (2-3 second debounce after drag/resize). Board member never manually saves.
- **D-15:** `migrateWorkspace()` function exists before any layout is saved. Uses `schema_version` field to handle future schema evolution.

### Error Boundaries
- **D-16:** Each plugin pane gets its own React error boundary. A crash in one plugin shows an error card — adjacent plugins continue working.
- **D-17:** Error card shows: plugin name, "Something went wrong" message, Retry button, collapsible Details section with error message. Pane stays at its current size.
- **D-18:** Error boundaries catch render-time crashes only. Async errors (failed fetches, SSE disconnects) are handled by the data layer (Phase 2) — they return `{ error }` state and the plugin shows inline error UI, NOT the error boundary.

### Claude's Discretion
- Responsive breakpoints configuration for react-grid-layout (mobile handled in Phase 4)
- Grid gap/margin sizing between plugin panes
- Exact debounce timing for auto-save (2-3s range)
- `migrateWorkspace()` implementation details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Governance
- `SPEC.md` §2 — Board interaction model, how board members control the system
- `SPEC.md` §8 — Dashboard and observability requirements
- `SPEC.md` §9 — Kill switch UI (HALT Control must be reachable — affects shell design)
- `CONSTITUTION.md` — Design principles P1-P6 that govern all architectural decisions

### Project Definition
- `.planning/REQUIREMENTS.md` — SHELL-01 through SHELL-09 define Phase 1 acceptance criteria
- `.planning/ROADMAP.md` — Phase 1 success criteria (5 verification points)

### Existing Code
- `board/src/components/BoardShell.tsx` — Current 3-panel layout being replaced
- `board/src/components/PanelLayout.tsx` — Current react-resizable-panels layout being replaced
- `board/src/app/layout.tsx` — Root layout with provider stack (preserve this structure)
- `board/src/components/EventStreamProvider.tsx` — SSE context already wired (grid shell plugs into this)
- `board/src/hooks/useEventStream.ts` — Existing SSE hook
- `board/package.json` — Current dependencies (react-grid-layout NOT yet installed)

### Technology
- `CLAUDE.md` "Technology Stack" section — react-grid-layout v2.2.3 API guidance, SSR boundary pattern, version compatibility notes

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **EventStreamProvider** (`board/src/components/EventStreamProvider.tsx`): SSE connection with heartbeat counters — grid shell mounts inside this provider, no changes needed
- **SessionProvider** (`board/src/components/SessionProvider.tsx`): NextAuth session wrapper — already in layout.tsx
- **HeaderBar** (`board/src/components/HeaderBar.tsx`): Top bar with branding/auth — stays as-is above the grid
- **SideNav** (`board/src/components/SideNav.tsx`): Navigation sidebar — moves from BoardShell child to PluginShell sibling
- **useEventStream hook** (`board/src/hooks/useEventStream.ts`): SSE subscription hook — available for real-time grid updates

### Established Patterns
- **'use client' directive**: All interactive components use client-side rendering boundary
- **Provider nesting**: layout.tsx wraps children in SessionProvider → ApiKeyProvider → EventStreamProvider → ChatSessionProvider → PageContextProvider
- **Tailwind CSS**: All styling via utility classes, no CSS modules
- **react-resizable-panels**: Currently used for 3-panel layout — will be replaced but the pattern of Group/Panel/Separator shows how the team structures layout components

### Integration Points
- **layout.tsx**: PluginShell replaces BoardShell at the same position in the component tree
- **Next.js App Router**: Existing route structure (`/today`, `/drafts`, `/pipeline`, etc.) remains active during migration — grid shell is a new workspace view, not a replacement of all routes yet
- **Supabase Postgres**: New `board` schema + `workspaces` table added via migration — uses existing database connection

</code_context>

<specifics>
## Specific Ideas

- Daily Ops preset as default first-visit layout gives board members an immediately functional dashboard
- react-grid-layout v2's hooks API (`useContainerWidth`, `useGridLayout`) used exclusively — no legacy WidthProvider HOC
- `next/dynamic` with `ssr: false` for the grid shell to prevent hydration mismatch (ResizeObserver is browser-only)
- `mounted` guard pattern as additional safety for React 19 runtime (per CLAUDE.md technology notes)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-shell-scaffold*
*Context gathered: 2026-04-06*

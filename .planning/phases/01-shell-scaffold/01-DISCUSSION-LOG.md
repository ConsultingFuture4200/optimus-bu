# Phase 1: Shell Scaffold - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-06
**Phase:** 01-shell-scaffold
**Areas discussed:** Shell-to-BoardShell transition, Grid layout defaults, Workspace persistence shape, Error boundary UX

---

## Shell-to-BoardShell Transition

| Option | Description | Selected |
|--------|-------------|----------|
| Replace BoardShell entirely | New PluginShell replaces BoardShell. SideNav becomes sidebar within new shell. ChatPanel becomes a plugin. Clean break from 3-panel model. | ✓ |
| Nest grid inside BoardShell | Keep 3-panel structure, replace center panel with grid. SideNav and ChatPanel stay as fixed flanking panels. | |
| Grid owns everything | Grid is entire viewport below HeaderBar. SideNav, ChatPanel all become plugins. | |

**User's choice:** Replace BoardShell entirely
**Notes:** Clean break from the 3-panel model.

### Follow-up: ChatPanel

| Option | Description | Selected |
|--------|-------------|----------|
| Becomes a plugin | ChatPanel becomes a grid plugin — draggable, resizable, closeable. | ✓ |
| Fixed right panel | Keep as fixed panel outside grid, always visible. | |
| Remove it | Drop entirely, add back as plugin in Phase 3 if needed. | |

**User's choice:** Becomes a plugin

### Follow-up: HeaderBar

| Option | Description | Selected |
|--------|-------------|----------|
| Stay fixed above | Fixed element at top, always visible. Grid lives below it. | ✓ |
| Absorb into grid | Header content moves into grid or SideNav. Full viewport to grid. | |

**User's choice:** Stay fixed above

---

## Grid Layout Defaults

### Column Count

| Option | Description | Selected |
|--------|-------------|----------|
| 12 columns | Standard dashboard grid. Plugins snap to 1/12th increments. | ✓ |
| 24 columns | Finer granularity, harder to align visually. | |
| You decide | Claude picks based on plugin sizes. | |

**User's choice:** 12 columns

### Default Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Single centered stub plugin | One placeholder pane, minimal first impression. | |
| Daily Ops preset auto-loaded | First visit loads Daily Ops preset (Today Brief + Approvals + Agent Status). Immediately functional. | ✓ |
| Empty grid with add button | Completely empty with prominent add button. | |

**User's choice:** Daily Ops preset auto-loaded

### Overlap Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| No overlap, auto-push | Standard react-grid-layout behavior. Dragging pushes others out of way. | ✓ |
| Free positioning with overlap | Allow overlapping plugins. More flexible, potentially confusing. | |
| You decide | Claude picks standard approach. | |

**User's choice:** No overlap, auto-push

### Row Height

| Option | Description | Selected |
|--------|-------------|----------|
| 30px rows | Standard for dashboard grids. Good granularity. | ✓ |
| You decide | Claude picks sensible default. | |
| 60px rows | Coarser grid, fewer snap points. | |

**User's choice:** 30px rows

### Drag Visual Feedback

| Option | Description | Selected |
|--------|-------------|----------|
| Placeholder highlight only | Ghost outline where plugin will land. No grid lines. Clean. | ✓ |
| Grid lines visible during drag | Show column/row lines while dragging. Hidden otherwise. | |
| You decide | Claude picks standard approach. | |

**User's choice:** Placeholder highlight only

---

## Workspace Persistence Shape

### Database Location

| Option | Description | Selected |
|--------|-------------|----------|
| Existing Supabase Postgres, new 'board' schema | Add board schema to existing instance. One table. No new infra. | ✓ |
| Existing Postgres, public schema | Put in public schema. Simpler but less organized. | |
| Separate database | New Postgres instance. Maximum isolation, more cost/complexity. | |

**User's choice:** Existing Supabase Postgres, new 'board' schema

### Storage Format

| Option | Description | Selected |
|--------|-------------|----------|
| Single JSONB column for full layout | One layout JSONB column with schemaVersion. Simple round-trip. | ✓ |
| Separate tables for layout + plugin config | Normalized approach. More relational but JOIN complexity. | |
| You decide | Claude picks simplest for round-trip fidelity. | |

**User's choice:** Single JSONB column

### Auto-save Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Debounced auto-save on every change | Save to Postgres after 2-3s inactivity. Always current. | ✓ |
| Manual save only | Click to save. Changes lost on refresh if not saved. | |
| Auto-save to localStorage, manual to Postgres | Two-tier persistence approach. | |

**User's choice:** Debounced auto-save on every change

---

## Error Boundary UX

### Crash Display

| Option | Description | Selected |
|--------|-------------|----------|
| Error card with retry + collapse | Styled card with plugin name, message, Retry button, collapsible Details. | ✓ |
| Minimal error badge | Small red badge in header. Pane goes blank. Click to retry. | |
| Auto-retry then error card | Auto-retry once, then show error card on second failure. | |

**User's choice:** Error card with retry + collapsible details

### Async Error Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Data layer handles its own errors | Async errors handled by data hooks (returns { error }). Error boundary for render crashes only. | ✓ |
| Unified error boundary | All errors funnel through error boundary. Single fetch failure kills plugin UI. | |
| You decide | Claude picks based on error hierarchy. | |

**User's choice:** Data layer handles its own errors (render boundary only)

---

## Claude's Discretion

- Responsive breakpoints configuration
- Grid gap/margin sizing
- Exact debounce timing (2-3s range)
- migrateWorkspace() implementation details

## Deferred Ideas

None — discussion stayed within phase scope

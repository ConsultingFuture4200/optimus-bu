# Phase 1: Shell Scaffold - Research

**Researched:** 2026-04-06
**Domain:** Next.js 15 App Router · react-grid-layout v2 · React error boundaries · Postgres DDL · TypeScript plugin architecture
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Shell Architecture**
- D-01: Replace BoardShell and PanelLayout entirely with a new PluginShell component. BoardShell's 3-panel react-resizable-panels layout is retired.
- D-02: SideNav remains as a fixed sidebar outside the grid (not a plugin). It sits to the left of the GridArea.
- D-03: ChatPanel becomes a grid plugin — draggable, resizable, closeable. No longer a fixed panel.
- D-04: HeaderBar stays fixed above the grid. Contains branding, auth, connection status. Grid lives below it.
- D-05: Layout hierarchy: `layout.tsx → HeaderBar + PluginShell (SideNav + GridArea)`. Existing provider stack (SessionProvider → ApiKeyProvider → EventStreamProvider → ChatSessionProvider → PageContextProvider) is preserved in layout.tsx.

**Grid Configuration**
- D-06: 12-column grid layout (standard dashboard grid).
- D-07: 30px row height.
- D-08: No-overlap mode with auto-push — dragging a plugin pushes adjacent plugins out of the way.
- D-09: Placeholder highlight only during drag — no visible grid lines or snap indicators.
- D-10: Default first-visit layout loads the "Daily Ops" preset: Today Brief (6 cols) + Approval Queue (6 cols) top row, Agent Status (12 cols) bottom row. In Phase 1, these are stub placeholders since real plugins don't exist yet.

**Workspace Persistence**
- D-11: board.workspaces table lives in the existing Supabase Postgres instance under a new `board` schema. No new database.
- D-12: Single JSONB `layout` column containing the full serialized react-grid-layout state (positions, sizes, plugin IDs, per-plugin configs).
- D-13: Table schema: `id UUID PK, member_id TEXT NOT NULL, name TEXT NOT NULL, layout JSONB NOT NULL, schema_version INT DEFAULT 1, is_preset BOOL DEFAULT false, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(member_id, name)`.
- D-14: Debounced auto-save on every layout change (2-3 second debounce after drag/resize). Board member never manually saves.
- D-15: `migrateWorkspace()` function exists before any layout is saved. Uses `schema_version` field to handle future schema evolution.

**Error Boundaries**
- D-16: Each plugin pane gets its own React error boundary. A crash in one plugin shows an error card — adjacent plugins continue working.
- D-17: Error card shows: plugin name, "Something went wrong" message, Retry button, collapsible Details section with error message. Pane stays at its current size.
- D-18: Error boundaries catch render-time crashes only. Async errors (failed fetches, SSE disconnects) are handled by the data layer (Phase 2) — they return `{ error }` state and the plugin shows inline error UI, NOT the error boundary.

### Claude's Discretion
- Responsive breakpoints configuration for react-grid-layout (mobile handled in Phase 4)
- Grid gap/margin sizing between plugin panes
- Exact debounce timing for auto-save (2-3s range)
- `migrateWorkspace()` implementation details

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope

</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHELL-01 | Plugin shell renders draggable/resizable grid panes via react-grid-layout | react-grid-layout v2 hooks API: `useGridLayout`, `useContainerWidth` — verified from npm registry (v2.2.3 latest) |
| SHELL-02 | Plugin registry loads all plugins at build time (compile-time imports, no runtime loading) | TypeScript Map-based registry, static imports — standard pattern; no dynamic URL loading |
| SHELL-03 | Plugin lifecycle calls onActivate() when pane opens and onDeactivate() when closed | React `useEffect` in grid item lifecycle; call on mount/unmount of plugin component |
| SHELL-04 | React error boundary per plugin pane — crash shows error card with retry, does not affect adjacent plugins | Class component ErrorBoundary pattern; React 19 compatible; confirmed standard approach |
| SHELL-05 | Error boundaries handle async errors via useErrorBoundary hook (not just render errors) | `react-error-boundary` library pattern; or custom hook that calls `setState` with error to trigger boundary |
| SHELL-06 | Layout serializes to JSON and restores from JSON exactly (round-trip fidelity) | react-grid-layout Layout array is plain JSON; serialize on change, parse on restore |
| SHELL-07 | Grid shell uses `ssr: false` / dynamic import with mounted guard to prevent hydration mismatch | `next/dynamic` with `ssr: false`; `mounted` state guard — confirmed pattern for ResizeObserver-dependent code in Next.js 15 |
| SHELL-08 | Shell loads in < 2s on desktop, < 3s on mobile | Code-split grid shell via `next/dynamic`; stub plugins have no data deps; CSS from react-grid-layout is small |
| SHELL-09 | Plugin activation time < 500ms per plugin | Stub plugins render immediately (no data fetch in Phase 1); measure in browser DevTools |

</phase_requirements>

---

## Summary

Phase 1 builds the grid harness that replaces the existing `BoardShell` + `PanelLayout` 3-panel layout. The deliverable is a `PluginShell` component that renders a drag/resize grid with crash-isolated plugin panes, persists layouts to Postgres, and renders without hydration errors in Next.js 15.

The primary technical challenges are: (1) the SSR/client boundary for react-grid-layout v2's ResizeObserver dependency, (2) wiring workspace persistence when `board/` has no direct Postgres connection today, and (3) defining the plugin API contract that all future phases will build against.

React-grid-layout v2.2.3 is confirmed latest as of 2026-04-06 (npm registry verified). The v2 API is hooks-based (`useContainerWidth`, `useGridLayout`) — the legacy `WidthProvider` HOC was removed. The existing board codebase uses React 19.0.0 and Next.js 15.2.0; react-grid-layout v2's peer deps declare `>= 16.3.0` with no upper bound, so installation proceeds without `--legacy-peer-deps`.

**Primary recommendation:** Build `PluginShell` as a `next/dynamic`-wrapped client component with `ssr: false`. Use the react-grid-layout v2 hooks API exclusively. Add a direct Postgres connection to `board/src/lib/db.ts` (add `pg` to board/package.json) for the workspace API route — this is simpler and more reliable than routing workspace persistence through the ops API at port 3001.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react-grid-layout | ^2.2.3 | Drag/resize/reorder grid layout engine | Locked decision. v2 is hooks-based TypeScript rewrite (Dec 2025). Peer deps `>= 16.3.0`. Battle-tested in Grafana, Datadog, Jupyter. |
| next/dynamic | built-in (Next.js ^15.2.0) | Client-only rendering boundary for grid shell | Required — ResizeObserver and `window` access cause hydration mismatch in SSR |
| react (class component) | ^19.0.0 | Error boundary implementation | React error boundaries still require class components in React 19 (no hooks alternative for componentDidCatch) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pg | ^8.13.x | Direct Postgres connection in board/ API routes | Needed for workspace persistence API route — board/ has no db connection today |
| react-resizable-panels | ^4.9.0 | Already in board/package.json | Keep for SideNav fixed split if needed; do NOT use for plugin grid |
| use-debounce | ^10.x or custom | Debounce auto-save of layout JSON | Any debounce utility; can be custom 5-line hook to avoid new dep |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct Postgres in board/ | Route workspace through ops API (port 3001) | Adds a new ops API endpoint to autobot-inbox scope, couples frontend-only workspace state to the agent backend. Direct Postgres is simpler for board-owned data. |
| Class component ErrorBoundary | React 19 future error boundary API | React 19 does not yet expose a hooks-based componentDidCatch equivalent — class component is required today. |
| Custom debounce hook | use-debounce library | For a single 3-line debounce, adding a dependency is unnecessary. Custom hook preferred. |

**Installation (from board/ directory):**
```bash
npm install react-grid-layout
npm install pg
npm install --save-dev @types/react-grid-layout @types/pg
```

**CSS (required — add to board/src/app/globals.css):**
```css
@import 'react-grid-layout/css/styles.css';
@import 'react-resizable/css/styles.css';
```

**Version verification:** Confirmed via `npm view react-grid-layout version` → `2.2.3` (2026-04-06).

---

## Architecture Patterns

### Recommended Project Structure
```
board/src/
├── components/
│   ├── PluginShell.tsx          # new — replaces BoardShell; next/dynamic wrapper
│   ├── GridArea.tsx             # new — react-grid-layout grid; 'use client'; ssr:false
│   ├── PluginPane.tsx           # new — single grid item + ErrorBoundary wrapper
│   ├── PluginErrorBoundary.tsx  # new — class component error boundary
│   ├── SideNav.tsx              # existing — unchanged, moved outside grid
│   ├── HeaderBar.tsx            # existing — unchanged
│   └── BoardShell.tsx           # existing — TO BE RETIRED (replaced by PluginShell)
├── plugins/
│   └── stubs/
│       ├── TodayBriefStub.tsx   # Phase 1 placeholder — satisfies Daily Ops preset
│       ├── ApprovalQueueStub.tsx
│       └── AgentStatusStub.tsx
├── lib/
│   ├── plugin-registry.ts       # new — compile-time plugin Map
│   ├── plugin-types.ts          # new — PluginManifest, OptimusPlugin, PluginProps interfaces
│   ├── workspaces.ts            # new — migrateWorkspace(), CRUD against board.workspaces
│   ├── db.ts                    # new — pg Pool for board/ (workspace table only)
│   └── [existing libs]
└── app/
    ├── api/
    │   └── workspaces/
    │       └── route.ts         # new — GET/POST/PUT workspace layouts
    ├── layout.tsx               # existing — swap BoardShell → PluginShell
    └── workspace/
        └── page.tsx             # new — the plugin workspace view
```

### Pattern 1: SSR-Safe Grid Shell (SHELL-07)

**What:** Use `next/dynamic` with `ssr: false` to prevent hydration mismatch. The grid shell imports react-grid-layout only in the browser.

**When to use:** Any component that uses ResizeObserver, window dimensions, or browser-only APIs.

**Example:**
```typescript
// board/src/components/PluginShell.tsx
// Source: CLAUDE.md technology notes + Next.js docs pattern

import dynamic from 'next/dynamic';
import SideNav from '@/components/SideNav';

const GridArea = dynamic(() => import('./GridArea'), {
  ssr: false,
  loading: () => <div className="flex-1 bg-neutral-900 animate-pulse" />,
});

export default function PluginShell() {
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <SideNav />
      <GridArea />
    </div>
  );
}
```

```typescript
// board/src/components/GridArea.tsx
// Source: react-grid-layout v2 hooks API

'use client';

import { useState, useEffect, useRef } from 'react';
import { useContainerWidth, useGridLayout } from 'react-grid-layout';
import type { Layout } from 'react-grid-layout';

export default function GridArea() {
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // mounted guard — additional safety for React 19 runtime
  useEffect(() => { setMounted(true); }, []);

  const { width } = useContainerWidth(containerRef);

  if (!mounted) return null;

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      {/* react-grid-layout v2 grid goes here */}
    </div>
  );
}
```

### Pattern 2: React Error Boundary Per Plugin Pane (SHELL-04)

**What:** Class component wrapping each plugin slot. A render-time throw in a plugin is caught here, shown as an error card. Adjacent plugins are unaffected.

**When to use:** Every PluginPane gets exactly one ErrorBoundary.

**Example:**
```typescript
// board/src/components/PluginErrorBoundary.tsx
// Source: React docs — class component ErrorBoundary pattern

import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  pluginName: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

export class PluginErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Future: log to audit endpoint
    console.error(`[PluginErrorBoundary] ${this.props.pluginName}:`, error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col gap-2 p-4 bg-neutral-900 border border-red-800/40 rounded-lg h-full">
        <div className="font-medium text-red-400 text-sm">{this.props.pluginName}</div>
        <div className="text-neutral-400 text-sm">Something went wrong</div>
        <button
          className="text-xs text-emerald-400 underline w-fit"
          onClick={() => this.setState({ hasError: false, error: null })}
        >
          Retry
        </button>
        <button
          className="text-xs text-neutral-500 w-fit"
          onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
        >
          {this.state.showDetails ? 'Hide' : 'Details'}
        </button>
        {this.state.showDetails && (
          <pre className="text-xs text-red-300 overflow-auto max-h-32 bg-neutral-950 p-2 rounded">
            {this.state.error?.message}
          </pre>
        )}
      </div>
    );
  }
}
```

### Pattern 3: Plugin Types Contract (SHELL-02, SHELL-03)

**What:** TypeScript interfaces that define the plugin API. All future plugins implement `OptimusPlugin`. This is the contract Phase 3 and beyond depends on.

**When to use:** Define in Phase 1. Do not change the interface shape without a version bump.

**Example:**
```typescript
// board/src/lib/plugin-types.ts

export interface PluginManifest {
  id: string;                 // e.g., 'optimus.approval-queue'
  name: string;               // e.g., 'Approval Queue'
  version: string;            // semver
  category: 'workflow' | 'analytics' | 'system' | 'governance' | 'ops';
  dataDependencies: string[];
  writeCapabilities?: string[];
  defaultSize: { w: number; h: number };  // 12-col grid units
  minSize?: { w: number; h: number };
  mobileSupported: boolean;
}

export interface PluginProps {
  config: Record<string, unknown>;
  size: { w: number; h: number };   // current pane dimensions in grid units
}

export interface OptimusPlugin {
  manifest: PluginManifest;
  component: React.ComponentType<PluginProps>;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void;
}
```

```typescript
// board/src/lib/plugin-registry.ts
import type { OptimusPlugin } from './plugin-types';

// Compile-time registry — all plugins imported statically
const registry = new Map<string, OptimusPlugin>();

export function registerPlugin(plugin: OptimusPlugin): void {
  registry.set(plugin.manifest.id, plugin);
}

export function getPlugin(id: string): OptimusPlugin | undefined {
  return registry.get(id);
}

export function getAllPlugins(): OptimusPlugin[] {
  return Array.from(registry.values());
}
```

### Pattern 4: Workspace Persistence API (SHELL-06, D-11 through D-15)

**What:** Next.js API route at `board/src/app/api/workspaces/route.ts` backed by a direct `pg` Pool. Handles GET/POST/PUT for `board.workspaces` table. `migrateWorkspace()` runs on read to upgrade old schema versions.

**When to use:** Auto-save triggers on layout change (debounced 2-3s). Load on workspace switch.

**Example:**
```typescript
// board/src/lib/workspaces.ts

export interface WorkspaceLayout {
  schemaVersion: number;       // D-15: must exist before first save
  items: GridLayoutItem[];     // react-grid-layout Layout entries + plugin IDs
  pluginConfigs: Record<string, unknown>;
}

export function migrateWorkspace(raw: unknown): WorkspaceLayout {
  const data = raw as Partial<WorkspaceLayout>;
  const version = data.schemaVersion ?? 1;

  // Future migrations: if (version < 2) { ... }
  // Phase 1: v1 is baseline, no migration needed yet
  return {
    schemaVersion: 1,
    items: data.items ?? [],
    pluginConfigs: data.pluginConfigs ?? {},
  };
}
```

```sql
-- board/sql/001-board-schema.sql
-- New board schema + workspaces table
-- Runs against the same Supabase instance as autobot-inbox migrations

CREATE SCHEMA IF NOT EXISTS board;

CREATE TABLE IF NOT EXISTS board.workspaces (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      TEXT        NOT NULL,               -- GitHub username (from NextAuth)
  name           TEXT        NOT NULL,
  layout         JSONB       NOT NULL,               -- WorkspaceLayout JSON
  schema_version INT         NOT NULL DEFAULT 1,     -- D-15: schemaVersion field
  is_preset      BOOL        NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, name)
);

-- Preset workspaces are shared (member_id = 'system')
-- Board member workspaces have member_id = github_username
```

### Pattern 5: Layout Auto-Save with Debounce (D-14)

```typescript
// Custom debounce hook — no new dependency needed
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// In GridArea.tsx:
const debouncedLayout = useDebounce(currentLayout, 2500); // D-14: 2-3s range

useEffect(() => {
  if (!debouncedLayout || !workspaceName) return;
  saveWorkspace(workspaceName, debouncedLayout);
}, [debouncedLayout, workspaceName]);
```

### Anti-Patterns to Avoid

- **WidthProvider HOC:** Removed in react-grid-layout v2. Use `useContainerWidth` hook instead. If you see `import { WidthProvider } from 'react-grid-layout'`, it imports from the legacy wrapper — do not use it for new code.
- **`data-grid` prop pattern:** Removed in v2 core. Use explicit `layout` prop with the Layout array.
- **Importing react-grid-layout without `ssr: false`:** ResizeObserver is browser-only. Without the dynamic import guard, Next.js will throw `ReferenceError: ResizeObserver is not defined` during SSR.
- **`suppressHydrationWarning` as a fix:** Not a fix for grid hydration issues. Use `next/dynamic` + `mounted` guard properly.
- **Direct Postgres writes from plugins:** Plugins must not write to Postgres directly. All writes go through API routes, which enforce authentication (P1, P2). The workspace API route is the only board-owned Postgres writer.
- **Routing workspace state through ops API (port 3001):** The ops API is the agent brain's API; workspace layout is frontend-only state. Add a direct `pg` connection to `board/` for this purpose.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Drag/resize grid layout | Custom drag + collision detection | react-grid-layout v2 | Layout serialization, breakpoints, push-on-overlap, row height math — thousands of edge cases. Grafana spent years on this. |
| Plugin crash isolation | try/catch in render | React ErrorBoundary (class component) | React render errors cannot be caught with try/catch — they propagate up the fiber tree. Only componentDidCatch intercepts them. |
| Grid container width measurement | `window.innerWidth` or `ResizeObserver` manually | `useContainerWidth` from react-grid-layout v2 | Handles edge cases: initial mount, element not yet painted, container inside flex/grid. |
| Debounce | setTimeout inline | Custom 3-line hook (above) | Simple enough not to need a library. A library adds a dep for 3 lines. |

**Key insight:** react-grid-layout v2's value is not just dragging — it's the complete state machine for a grid: collision detection, auto-push, responsive breakpoints, and serializable layout state. Building any part of this from scratch consumes the phase budget before a single plugin exists.

---

## Critical Finding: Database Access Architecture

**Context:** `board/` has no `pg` dependency and no direct Postgres connection today. All current data access proxies through the autobot-inbox API at port 3001 (`board/src/app/api/ops/route.ts`).

**Decision required for D-11 (workspace persistence):** Two options:

| Option | What | Tradeoff |
|--------|------|---------|
| **A: Direct Postgres in board/** (recommended) | Add `pg` to board/package.json. Create `board/src/lib/db.ts` with a Pool. Create `board/src/app/api/workspaces/route.ts`. | Board owns its own data. No autobot-inbox change needed. Requires `DATABASE_URL` in board/ env (same value as autobot-inbox). |
| **B: Add workspace endpoints to autobot-inbox API** | New routes in `autobot-inbox/src/api-routes/` that CRUD `board.workspaces`. Board proxies through `/api/ops`. | Keeps all Postgres access in one service. But couples board-only UI state to the agent backend. Violates separation of concerns. |

**Research conclusion:** Option A is correct. The PRD (§8) explicitly shows `board.workspaces` as a frontend-owned table with no agent involvement. The `DATABASE_URL` is already available to the board Railway service (it's the same Supabase instance). Adding `pg` to board/ and a workspace API route is the P4-compliant (boring infrastructure) approach.

**Migration location:** The `board` schema DDL should live in `board/sql/001-board-schema.sql` (new directory), not in `autobot-inbox/sql/`. The existing `autobot-inbox/sql/` migration runner does not need to know about board's schema.

---

## Common Pitfalls

### Pitfall 1: Hydration Mismatch from Grid Shell
**What goes wrong:** react-grid-layout imports ResizeObserver and measures container width synchronously at the module level. In Next.js 15 App Router, server renders the component to HTML, then React hydrates it in the browser. If the grid renders on the server, the layout positions are different (no container width), causing a hydration mismatch or console error.

**Why it happens:** ResizeObserver is a browser API. It does not exist in the Node.js server render environment.

**How to avoid:** Wrap GridArea in `next/dynamic` with `ssr: false`. Additionally use a `mounted` state guard to skip rendering until after first client-side effect.

**Warning signs:** "Hydration failed because the server-rendered HTML didn't match" in the console. Grid items jumping on first paint.

### Pitfall 2: react-grid-layout v2 API Confusion with v1 Docs
**What goes wrong:** Most Stack Overflow answers, blog posts, and GitHub issues reference react-grid-layout v1 API (`WidthProvider` HOC, `data-grid` prop, `onLayoutChange` prop at the component level). v2 changed the API entirely to hooks.

**Why it happens:** v2 was released December 2025. Most documentation online is for v1.

**How to avoid:** Use only the v2 hooks API: `useContainerWidth`, `useGridLayout`, `useResponsiveLayout`. Do not import `WidthProvider`. Check `CLAUDE.md` Technology Stack section for the canonical guidance.

**Warning signs:** TypeScript errors importing `WidthProvider`. Props like `data-grid` not recognized. The CLAUDE.md "What NOT to Use" section lists these explicitly.

### Pitfall 3: Plugin API Contract Drift
**What goes wrong:** If `PluginManifest`, `OptimusPlugin`, or `PluginProps` interfaces change shape between Phase 1 and Phase 3 (when real plugins are built), every plugin needs to be updated.

**Why it happens:** Phase 1 defines the contract with stub plugins only. It's tempting to "simplify" the interface for stubs and fix it later.

**How to avoid:** Define the full `PluginManifest` and `OptimusPlugin` interfaces in Phase 1 exactly as they will be used in Phase 3. Stub plugins implement the full interface. The interface is locked when the first non-stub plugin is built.

**Warning signs:** Stub plugins have `manifest: { id: 'stub' }` without the full required fields. `onActivate` missing from the interface.

### Pitfall 4: Missing CSS Import for react-grid-layout
**What goes wrong:** Grid items render but resize handles are invisible, or the drag placeholder does not appear. The grid technically works but the UX is broken.

**Why it happens:** react-grid-layout requires two CSS files: `react-grid-layout/css/styles.css` and `react-resizable/css/styles.css`. They are not auto-imported.

**How to avoid:** Add both `@import` statements to `board/src/app/globals.css` on the first day of implementation.

**Warning signs:** Grid renders but resize handles don't appear on hover. No visual placeholder during drag.

### Pitfall 5: board Schema Migration Path
**What goes wrong:** The `board.workspaces` DDL gets added to `autobot-inbox/sql/` because that's where all existing migrations live. The `npm run migrate` command in autobot-inbox runs it. Now the board schema DDL is coupled to the autobot-inbox migration runner, which the board package cannot control.

**Why it happens:** There is only one migration directory in the repo today — `autobot-inbox/sql/`. It's the path of least resistance.

**How to avoid:** Create `board/sql/` and a migration script in board/package.json (`"migrate": "node scripts/migrate.js"`). The board manages its own schema. If both services share the same Postgres, both can coexist in separate schemas with their own migration runners.

**Warning signs:** Workspace table DDL appears in `autobot-inbox/sql/028-*.sql`.

### Pitfall 6: `schema_version` Field Name Inconsistency
**What goes wrong:** The DDL decision D-13 names the field `schema_version` (snake_case), while the `WorkspaceLayout` TypeScript interface names it `schemaVersion` (camelCase). If not mapped explicitly in the API route, one or the other breaks.

**Why it happens:** SQL convention is snake_case; TypeScript convention is camelCase. Easy to mix up in the mapping layer.

**How to avoid:** Define the mapping explicitly in the workspace API route: `schema_version` in SQL maps to `schemaVersion` in TypeScript. Use a row mapper function.

---

## Code Examples

Verified patterns from existing board codebase and react-grid-layout v2:

### Next.js API Route Pattern (board/ conventions)
```typescript
// Source: board/src/app/api/ops/route.ts (existing pattern)
// board/src/app/api/workspaces/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getWorkspace, saveWorkspace } from '@/lib/workspaces';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const name = req.nextUrl.searchParams.get('name');
  const workspace = await getWorkspace(session.user.name, name ?? 'Daily Ops');
  return NextResponse.json(workspace);
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name, layout } = await req.json();
  await saveWorkspace(session.user.name, name, layout);
  return NextResponse.json({ ok: true });
}
```

### Daily Ops Default Layout (D-10)
```typescript
// D-10: Default first-visit layout for Phase 1 stub plugins
// 12-column grid, 30px row height

export const DAILY_OPS_DEFAULT_LAYOUT = [
  { i: 'optimus.today-brief',     x: 0, y: 0, w: 6, h: 8 },   // top-left 6 cols
  { i: 'optimus.approval-queue',  x: 6, y: 0, w: 6, h: 8 },   // top-right 6 cols
  { i: 'optimus.agent-status',    x: 0, y: 8, w: 12, h: 6 },  // bottom full-width
];
```

### Provider Stack Preservation (D-05)
```typescript
// Source: board/src/app/layout.tsx (existing — DO NOT CHANGE the provider order)

// Replace: <BoardShell>{children}</BoardShell>
// With:    <PluginShell />

// The PluginShell renders the workspace view independently;
// existing Next.js routes (/today, /drafts, etc.) remain active
// during the migration period.
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| react-grid-layout v1 `WidthProvider` HOC | v2 `useContainerWidth` hook | Dec 2025 (v2.0.0) | All v1 documentation is wrong for v2. Must use hooks API. |
| react-grid-layout v1 `data-grid` prop per item | v2 explicit `layout` prop array | Dec 2025 (v2.0.0) | Layout state is now externally managed by the parent. Better for serialization. |
| React error boundaries as function components | Still requires class component | React 18/19 | No hooks-based `componentDidCatch` equivalent in React 19. Class component required. |

**Deprecated/outdated:**
- `WidthProvider` (react-grid-layout v1 HOC): Removed in v2. Import path `react-grid-layout/legacy` only for migrating old code.
- `data-grid` prop pattern: Removed in v2. Use `layout` array prop.

---

## Open Questions

1. **board/ migration runner**
   - What we know: `autobot-inbox/sql/` has an existing migration runner (`npm run migrate`). `board/` has no migration infrastructure.
   - What's unclear: Should board/ get its own migration runner, or should the `board` schema DDL be added to `autobot-inbox/sql/` as migration `028-board-schema.sql`?
   - Recommendation: Create `board/sql/` with its own migration script. The `board` schema is owned by the board service, not the agent service. Planner should scope a Wave 0 task for this.

2. **react-grid-layout v2 React 19 runtime confidence**
   - What we know: CLAUDE.md notes "MEDIUM confidence on React 19 runtime — v2 is from Dec 2025, limited production reports at React 19 specifically." Peer deps are `>= 16.3.0` with no upper bound. Installation succeeds without `--legacy-peer-deps`.
   - What's unclear: Whether any React 19 Concurrent Mode interactions cause subtle bugs with the `useContainerWidth` hook's internal ResizeObserver handling.
   - Recommendation: Plan a Phase 1 Wave 0 validation task: install react-grid-layout, render a stub grid with 3 panes, drag/resize, verify no console errors, verify layout serializes correctly. Gate the rest of Phase 1 on this passing.

3. **Workspace preset seeding**
   - What we know: D-10 defines the Daily Ops default layout. PRD §8 lists 5 presets. D-13 table has `is_preset BOOL`.
   - What's unclear: Should presets be seeded as SQL INSERT statements in the migration, or hardcoded in TypeScript as fallbacks?
   - Recommendation: Hardcode presets in TypeScript as `PRESET_WORKSPACES` constant (simpler, no data migration risk). SQL seeding is fragile for JSON blobs. The planner can decide.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | board/ build | Yes | v24.13.1 | — |
| npm | package installation | Yes | 11.8.0 | — |
| react-grid-layout | SHELL-01 | Not yet installed | — (2.2.3 available) | — (no fallback; it's the locked choice) |
| pg (npm) | Workspace persistence API | Not in board/package.json | — (8.13.x available) | — (required unless Option B chosen) |
| Postgres (Supabase) | board.workspaces DDL | Available (existing service) | Supabase PG17 | — |
| TypeScript types (@types/react-grid-layout) | Type safety | Not yet installed | — | — |

**Missing dependencies with no fallback:**
- `react-grid-layout` — must be installed before grid work begins
- `pg` (in board/) — required if Option A chosen for workspace persistence

**Missing dependencies with fallback:**
- `@types/react-grid-layout` — react-grid-layout v2 ships its own TypeScript types; `@types/` package may not be needed. Verify post-install.

---

## Project Constraints (from CLAUDE.md)

Directives from `./CLAUDE.md` that the planner must verify compliance with:

| Directive | Constraint | Phase 1 Impact |
|-----------|------------|----------------|
| P1 Deny by default | Nothing permitted unless explicitly granted | Workspace API route must check `getSession()` before any read/write |
| P2 Infrastructure enforces | Security boundary is never the prompt | Auth check in API route, not in component; workspace writes server-side only |
| P3 Transparency by structure | Logging is a side effect of operating | Plugin activations and workspace saves should log to `dashboard_audit_log` (or skip if that table is Phase 2+) |
| P4 Boring infrastructure | Postgres, SQL, JWT, hash chains | pg + parameterized queries for workspace table; no ORM |
| No ORM | Raw SQL with parameterized queries | All `board.workspaces` queries use `pg` + `$1, $2` params |
| No cross-schema foreign keys | Schemas are isolated by database roles | `board.workspaces.member_id` is TEXT (GitHub username), not a FK to `agent_graph.board_members` |
| GSD Workflow Enforcement | All edits via GSD workflow | Confirmed — this research is part of the GSD workflow |
| ES modules throughout | `"type": "module"` in package.json | board/ uses TypeScript + Next.js module system; no CommonJS in new files |
| Package manager: npm | Use npm, not yarn/pnpm | All install commands use `npm install` |

**Security-critical:** Per P1 + P2, the workspace API route (`/api/workspaces`) must:
1. Call `getSession()` and return 401 if no session
2. Use `session.user.name` as the `member_id` — never trust a client-supplied member_id
3. Use parameterized queries (`$1`, `$2`) in all SQL — never string-interpolate

---

## Sources

### Primary (HIGH confidence)
- `N:/root/ClaudeFiles/optimus-clone/db-build/board/package.json` — confirmed React 19.0.0, Next.js 15.2.0, no pg, no react-grid-layout
- `N:/root/ClaudeFiles/optimus-clone/db-build/board/src/components/BoardShell.tsx` — confirmed replacement target
- `N:/root/ClaudeFiles/optimus-clone/db-build/board/src/app/layout.tsx` — confirmed provider stack to preserve
- `N:/root/ClaudeFiles/optimus-clone/db-build/board/src/app/api/ops/route.ts` — confirmed no direct Postgres; all DB access proxied through port 3001
- `N:/root/ClaudeFiles/optimus-clone/db-build/autobot-inbox/sql/001-baseline.sql` — confirmed `board` schema does not exist; existing schemas are `agent_graph`, `inbox`, `voice`, `signal`, `content`
- `npm view react-grid-layout version` → `2.2.3` (verified 2026-04-06)
- `npm view react-grid-layout peerDependencies` → `{ react: '>= 16.3.0', 'react-dom': '>= 16.3.0' }`
- `N:/root/ClaudeFiles/optimus-clone/db-build/CLAUDE.md` — Technology Stack section, design principles P1-P6

### Secondary (MEDIUM confidence)
- `N:/root/ClaudeFiles/optimus-clone/db-build/dashboard-rebuild.md` — PRD v1.0.0 with plugin API spec, workspace DDL, task breakdown
- CLAUDE.md "Standard Stack" and "What NOT to Use" sections — v2 API guidance, confirmed by npm peerDeps check

### Tertiary (LOW confidence)
- None — all critical claims verified against package.json, source code, or npm registry

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified against npm registry; peer deps verified
- Architecture: HIGH — derived directly from existing board/ source code and locked decisions in CONTEXT.md
- Pitfalls: HIGH — three pitfalls (hydration, v1/v2 confusion, missing CSS) verified from existing CLAUDE.md notes; two (migration path, schema_version casing) derived from direct code inspection
- Database architecture finding: HIGH — verified by reading every file in board/src/lib/ and board/package.json; no pg dependency present

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (react-grid-layout v2 is stable; Next.js 15 API Router pattern is stable; 30-day horizon)

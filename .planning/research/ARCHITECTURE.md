# Architecture Research

**Domain:** Plugin-based dashboard (Next.js 15 App Router)
**Researched:** 2026-04-05
**Confidence:** HIGH — existing codebase read directly; patterns verified against official docs and Next.js 15 community sources

---

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  board.staqs.io (Next.js 15, port 3200)                         │
│                                                                  │
│  RootLayout (app/layout.tsx)                                     │
│  ├── SessionProvider (NextAuth)                                  │
│  ├── EventStreamProvider  ← global SSE singleton                │
│  └── WorkspaceShell (NEW: replaces BoardShell)                  │
│      ├── CommandPalette (cmdk, Cmd+K, global)                   │
│      ├── WorkspaceCanvas  ← react-grid-layout                   │
│      │   ├── PluginSlot [key=plugin-id]                         │
│      │   │   └── ErrorBoundary                                  │
│      │   │       └── <PluginComponent />                        │
│      │   ├── PluginSlot [key=plugin-id]                         │
│      │   └── ...                                                │
│      └── WorkspaceBar (preset switcher, add-plugin, SSE badge)  │
│                                                                  │
│  Plugin Registry (compile-time, static map)                     │
│  ├── approval-queue     → ApprovalQueuePlugin                   │
│  ├── halt-control       → HaltControlPlugin                     │
│  ├── agent-monitor      → AgentMonitorPlugin                    │
│  ├── pipeline           → PipelinePlugin                        │
│  ├── cost-review        → CostReviewPlugin                      │
│  └── ... (12 total)                                             │
│                                                                  │
│  Data Provider Layer  ("use client" hooks, shared across all    │
│  plugins via import — not context)                              │
│  ├── useAgents()        REST GET /api/agents                    │
│  ├── useDrafts()        REST GET /api/drafts                    │
│  ├── useApprovals()     REST GET /api/drafts?status=pending     │
│  ├── usePipeline()      REST GET /api/pipeline                  │
│  ├── useCosts()         REST GET /api/costs                     │
│  ├── useHaltStatus()    REST GET /api/halt                      │
│  ├── useSignals()       REST GET /api/signals                   │
│  ├── useGovernance()    REST GET /api/governance                │
│  ├── useTaskGraph()     REST GET /api/tasks                     │
│  ├── useEventFeed()     SSE via useEventStream() singleton      │
│  └── [mutating hooks]   REST POST/PATCH + guardCheck writes     │
│                                                                  │
│  Workspace Persistence Layer                                     │
│  ├── useWorkspace()     local state + Postgres sync             │
│  ├── POST /api/workspaces  save layout + plugin config          │
│  └── GET  /api/workspaces  load on mount                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP (OPS_API_URL = port 3001)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  autobot-inbox API (port 3001)  — UNTOUCHED                     │
│  ├── REST endpoints (reads, writes + guardCheck)                │
│  └── SSE relay  /api/ops/events  (Redis pub/sub → browser)      │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Layer | Responsibility | Communicates With |
|-----------|-------|---------------|-------------------|
| `RootLayout` | App shell | HTML scaffold, global providers, auth boundary | All providers |
| `EventStreamProvider` | Global provider | SSE singleton lifecycle, global counters (pendingDrafts, pendingHitl) | `useEventStream` hook |
| `WorkspaceShell` | Shell | Renders `react-grid-layout` canvas, mounts plugins, owns workspace state | PluginSlot, CommandPalette, WorkspaceBar, useWorkspace |
| `PluginSlot` | Shell | Wraps each plugin in an ErrorBoundary; passes plugin-id as key | ErrorBoundary, PluginComponent |
| `ErrorBoundary` | Shell | Catches plugin crashes, renders error card, does not propagate up | PluginComponent |
| `CommandPalette` | Shell | Global Cmd+K, fuzzy search over workspaces/plugins/drafts | useWorkspace, useApprovals, useSignals |
| `WorkspaceBar` | Shell | Preset switcher, add-plugin button, SSE connection badge | useWorkspace, EventStreamContext |
| `PluginRegistry` | Plugin system | Static compile-time map: pluginId → Component + metadata | WorkspaceShell (consumer) |
| `[PluginComponent]` | Plugin | Renders a single operational view; calls data provider hooks directly | Data provider hooks, mutation functions |
| Data provider hooks | Data layer | Typed hooks wrapping fetch + SWR; each hook owns its URL and cache | autobot-inbox API (port 3001) |
| `useEventStream` | Data layer | Global SSE singleton; typed event dispatch by event name | EventSource `/api/ops/events`, any plugin |
| `useWorkspace` | Persistence layer | Load/save workspace layouts + plugin configs to Postgres | `POST /api/workspaces`, `GET /api/workspaces` |
| `/api/workspaces` | API route | Board-side route that reads/writes `board.workspaces` table | Postgres (Supabase) |

---

## Recommended Project Structure

```
board/src/
├── app/
│   ├── layout.tsx                    # Root: SessionProvider, EventStreamProvider, WorkspaceShell
│   ├── page.tsx                      # Redirect → /workspace
│   ├── api/
│   │   └── workspaces/
│   │       └── route.ts             # GET/POST workspace persistence (board-side Postgres)
│   └── workspace/
│       └── page.tsx                 # Workspace canvas (client component entry)
│
├── components/
│   ├── shell/
│   │   ├── WorkspaceShell.tsx        # react-grid-layout canvas, plugin mounting
│   │   ├── PluginSlot.tsx            # ErrorBoundary wrapper per grid cell
│   │   ├── WorkspaceBar.tsx          # Preset switcher, add-plugin, SSE badge
│   │   └── CommandPalette.tsx        # cmdk Cmd+K global palette
│   └── [legacy components kept]      # SessionProvider, EventStreamProvider, HeaderBar
│
├── plugins/
│   ├── registry.ts                   # Static map: pluginId → { component, meta }
│   ├── types.ts                      # PluginMeta, PluginProps interfaces
│   ├── approval-queue/
│   │   └── index.tsx                 # ApprovalQueuePlugin
│   ├── halt-control/
│   │   └── index.tsx                 # HaltControlPlugin
│   ├── agent-monitor/
│   │   └── index.tsx
│   ├── pipeline/
│   │   └── index.tsx
│   ├── cost-review/
│   │   └── index.tsx
│   ├── signals/
│   │   └── index.tsx
│   ├── governance/
│   │   └── index.tsx
│   ├── task-graph/
│   │   └── index.tsx
│   ├── knowledge-base/
│   │   └── index.tsx
│   ├── campaigns/
│   │   └── index.tsx
│   ├── drafts/
│   │   └── index.tsx
│   └── activity-feed/
│       └── index.tsx
│
├── hooks/
│   ├── useEventStream.ts             # EXISTING — global SSE singleton (keep as-is)
│   ├── useWorkspace.ts               # NEW — workspace layout + config persistence
│   ├── data/
│   │   ├── useAgents.ts              # GET /api/agents
│   │   ├── useDrafts.ts              # GET /api/drafts
│   │   ├── useApprovals.ts           # GET /api/drafts?status=pending
│   │   ├── usePipeline.ts            # GET /api/pipeline
│   │   ├── useCosts.ts               # GET /api/costs
│   │   ├── useHaltStatus.ts          # GET /api/halt
│   │   ├── useSignals.ts             # GET /api/signals
│   │   ├── useGovernance.ts          # GET /api/governance
│   │   ├── useTaskGraph.ts           # GET /api/tasks
│   │   └── useEventFeed.ts           # SSE wrapper for plugins
│   └── mutations/
│       ├── useApproveDraft.ts        # POST /api/drafts/:id/approve
│       ├── useRejectDraft.ts         # POST /api/drafts/:id/reject
│       └── useHaltToggle.ts          # POST /api/halt (P0 safety-critical)
│
├── contexts/
│   └── [existing contexts kept]
│
├── lib/
│   ├── api-client.ts                 # Typed fetch wrapper (OPS_API_URL base, auth headers)
│   ├── workspace-presets.ts          # 5 static preset definitions
│   └── [existing lib files]
│
└── middleware.ts                     # EXISTING — NextAuth guard (unchanged)
```

---

## Architectural Patterns

### Pattern 1: Plugin as a Typed React Component

Every plugin is a standard React component that receives no special props — it calls data provider hooks directly. The shell knows nothing about what plugins render.

```typescript
// plugins/types.ts
export interface PluginMeta {
  id: string;
  label: string;
  defaultSize: { w: number; h: number; minW?: number; minH?: number };
  mobileFullscreen: boolean; // single-plugin full-screen on <768px
}

// plugins/registry.ts
import { lazy } from "react";

export const PLUGIN_REGISTRY: Record<string, {
  component: React.LazyExoticComponent<() => JSX.Element>;
  meta: PluginMeta;
}> = {
  "approval-queue": {
    component: lazy(() => import("./approval-queue")),
    meta: { id: "approval-queue", label: "Approval Queue",
            defaultSize: { w: 6, h: 8, minW: 4, minH: 4 }, mobileFullscreen: true },
  },
  "halt-control": {
    component: lazy(() => import("./halt-control")),
    meta: { id: "halt-control", label: "HALT Control",
            defaultSize: { w: 3, h: 3, minW: 3, minH: 3 }, mobileFullscreen: true },
  },
  // ...
};
```

Note: `lazy()` is for code-splitting only — all plugins compile into the bundle. No runtime URL loading.

### Pattern 2: Plugin Slot with Error Boundary

Each grid cell wraps its plugin in an error boundary. A crash renders a contained error card — the rest of the workspace continues.

```typescript
// components/shell/PluginSlot.tsx
"use client";
import { ErrorBoundary } from "react-error-boundary";
import { Suspense } from "react";

function PluginErrorCard({ error }: { error: Error }) {
  return (
    <div className="plugin-error">
      <p>Plugin failed: {error.message}</p>
    </div>
  );
}

export function PluginSlot({ pluginId }: { pluginId: string }) {
  const entry = PLUGIN_REGISTRY[pluginId];
  if (!entry) return <div>Unknown plugin: {pluginId}</div>;

  const { component: Plugin } = entry;

  return (
    <ErrorBoundary
      FallbackComponent={({ error }) => <PluginErrorCard error={error} />}
      resetKeys={[pluginId]}
    >
      <Suspense fallback={<div className="plugin-loading" />}>
        <Plugin />
      </Suspense>
    </ErrorBoundary>
  );
}
```

### Pattern 3: Data Provider Hooks (typed, SWR-backed)

All data fetching is through typed hooks. Plugins import the hook they need — no prop drilling, no context threading.

```typescript
// hooks/data/useApprovals.ts
"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api-client";

export interface Draft {
  id: string;
  subject: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export function useApprovals() {
  const { data, error, isLoading, mutate } = useSWR<Draft[]>(
    "/api/drafts?status=pending",
    apiFetch,
    { refreshInterval: 30_000 } // polling fallback, SSE is primary
  );

  return {
    drafts: data ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
}
```

### Pattern 4: SSE Events Drive SWR Cache Invalidation

The SSE singleton (already implemented as `useEventStream`) is the primary real-time path. Plugins listen for relevant events and invalidate their SWR cache keys — not maintain separate local state.

```typescript
// plugins/approval-queue/index.tsx
"use client";
import { useSWRConfig } from "swr";
import { useEventStream } from "@/hooks/useEventStream";
import { useApprovals } from "@/hooks/data/useApprovals";

export default function ApprovalQueuePlugin() {
  const { drafts, isLoading } = useApprovals();
  const { mutate } = useSWRConfig();

  // SSE invalidation: when a draft_ready event arrives, refresh
  useEventStream("draft_ready", () => {
    mutate("/api/drafts?status=pending");
  });

  // render drafts...
}
```

This avoids maintaining duplicated state: SWR is the cache, SSE is the invalidation signal.

### Pattern 5: react-grid-layout with External State

Layout state lives in `useWorkspace`, not inside react-grid-layout. The grid is a controlled component.

```typescript
// hooks/useWorkspace.ts
"use client";
import { useState, useCallback } from "react";
import useSWR from "swr";
import type { Layout } from "react-grid-layout";

export interface WorkspaceConfig {
  id: string;
  name: string;
  layout: Layout[];
  pluginConfigs: Record<string, unknown>; // per-plugin opaque config
}

export function useWorkspace(memberId: string) {
  const { data, mutate } = useSWR<WorkspaceConfig>(
    `/api/workspaces?member=${memberId}`,
    apiFetch
  );

  const updateLayout = useCallback(async (newLayout: Layout[]) => {
    const updated = { ...data!, layout: newLayout };
    await mutate(
      fetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(updated),
      }).then(r => r.json()),
      { optimistic: true }
    );
  }, [data, mutate]);

  return { workspace: data, updateLayout };
}
```

react-grid-layout v2 receives `layout` as a prop and calls `onLayoutChange` on every drag/resize — pure external state pattern.

### Pattern 6: Command Palette as Global Overlay

cmdk mounts once at the shell level, not inside any plugin. It receives data from hooks and routes actions.

```typescript
// components/shell/CommandPalette.tsx
"use client";
import { Command } from "cmdk";
import { useApprovals } from "@/hooks/data/useApprovals";
import { WORKSPACE_PRESETS } from "@/lib/workspace-presets";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { drafts } = useApprovals();

  return (
    <Command.Dialog open={open} onOpenChange={onClose}>
      <Command.Input placeholder="Search workspaces, drafts, plugins..." />
      <Command.List>
        <Command.Group heading="Workspaces">
          {WORKSPACE_PRESETS.map(p => (
            <Command.Item key={p.id} onSelect={() => { /* switch workspace */ }}>
              {p.name}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Pending Drafts">
          {drafts.slice(0, 5).map(d => (
            <Command.Item key={d.id} onSelect={() => { /* open approval queue */ }}>
              {d.subject}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
```

---

## Data Flow

### Request Flow

```
User interaction in plugin
  │
  ├─► [read] useXxx() hook → SWR cache hit → render
  │                        → cache miss → fetch(OPS_API_URL + path) → cache → render
  │
  └─► [write] useMutationHook() → POST OPS_API_URL/path (guardCheck on API server)
                                → SWR mutate() invalidates read cache
                                → re-render
```

### State Management

There is no global client state store (no Zustand, no Redux). State is distributed:

| State Type | Owner | Mechanism |
|-----------|-------|-----------|
| Server data (agents, drafts, costs) | SWR cache | Per-hook, key = API URL |
| Real-time updates | SSE singleton (`useEventStream`) | Invalidates SWR keys |
| Workspace layout | `useWorkspace` + Postgres | SWR with optimistic updates |
| SSE connection status + global counters | `EventStreamProvider` (existing) | React context |
| Command palette open/closed | `WorkspaceShell` | useState, no context needed |
| Plugin-level ephemeral state | Each plugin component | useState / useReducer |

### Key Data Flows

**Flow A: Approval Queue — read path**
```
ApprovalQueuePlugin mounts
→ useApprovals() → SWR checks cache
→ fetch GET /api/drafts?status=pending → port 3001
→ data renders in plugin
→ SSE "draft_ready" arrives → mutate("/api/drafts?status=pending")
→ SWR refetches → plugin re-renders with new draft
```

**Flow B: Draft Approval — write path**
```
Board member clicks "Approve" in ApprovalQueuePlugin
→ useApproveDraft(id) → POST /api/drafts/:id/approve → port 3001
→ API runs guardCheck (G1-G8, existing infrastructure)
→ 200 OK → SWR mutate() → optimistic update in UI
→ SSE "campaign_approved" arrives → secondary confirmation refresh
```

**Flow C: HALT — safety-critical write path**
```
Board member activates HaltControlPlugin HALT button
→ useHaltToggle() → POST /api/halt → port 3001
→ guardCheck: autonomy level check, board auth
→ Response + SSE "halt_triggered" → UI reflects halt state
→ All agent plugins show halted indicator via useHaltStatus() SSE invalidation
```

**Flow D: Workspace persistence**
```
Board member drags plugin to new position in react-grid-layout
→ onLayoutChange fires → useWorkspace.updateLayout(newLayout)
→ Optimistic local update (grid re-renders immediately)
→ POST /api/workspaces with serialized layout → board-side Postgres
→ On next login: GET /api/workspaces → restore exact layout
```

**Flow E: SSE reconnection (existing pattern, keep)**
```
SSE connection drops (Railway timeout or network)
→ globalSource.onerror fires
→ exponential backoff reconnect (1s → 2s → 4s → ... → 30s max)
→ Reconnect to /api/ops/events
→ SWR polling (refreshInterval: 30_000) acts as fallback during gap
```

---

## Anti-Patterns

### Anti-Pattern 1: Global Context for Plugin Data

**What:** Putting all domain data (drafts, agents, costs) into a single React context tree.

**Why bad:** Every plugin triggers re-render of every other plugin when any data changes. Context is appropriate for session-scoped singletons (auth, SSE status), not domain data.

**Instead:** Each plugin calls its own typed SWR hook. SWR's per-key caching deduplicates requests — multiple plugins calling `useAgents()` hit the same cache.

### Anti-Pattern 2: Plugin Manages Its Own SSE Connection

**What:** Each plugin creates its own `EventSource` instance.

**Why bad:** Each plugin would open a separate SSE connection to the same endpoint — browser limits (6 connections per origin for HTTP/1.1) would cause starvation with 12 plugins.

**Instead:** The existing `useEventStream` singleton pattern (already in the codebase) is the correct approach — one `EventSource`, shared via module-level listeners.

### Anti-Pattern 3: Storing Layout in react-grid-layout Internal State

**What:** Treating `react-grid-layout` as the source of truth for layout.

**Why bad:** Layout cannot be persisted to Postgres, preset-switching cannot work, and per-member workspaces are impossible.

**Instead:** `useWorkspace` owns layout state. react-grid-layout is a controlled component receiving `layout` as a prop.

### Anti-Pattern 4: Next.js Server Actions for Plugin Writes

**What:** Using Server Actions (`"use server"`) for approve/reject/halt mutations.

**Why bad:** guardCheck lives in the port 3001 API, not in the Next.js app. Server Actions would create a leaky second enforcement path and bypass existing G1-G8 gate infrastructure.

**Instead:** All mutations go through `fetch(OPS_API_URL + path)` directly, letting the existing API enforce all gates.

### Anti-Pattern 5: SSE Route Handler in Next.js App

**What:** Building an `/api/events/route.ts` in the Next.js app that subscribes to Redis itself.

**Why bad:** This duplicates the existing Redis relay in port 3001 and adds a second hop. The existing `/api/ops/events` on port 3001 already does this correctly. The Next.js app is a consumer, not a relay.

**Instead:** `EventSource` points to `OPS_API_URL + "/api/ops/events"` (proxied through Next.js `rewrites` if same-origin cookies are needed, or hit directly in cross-origin with auth headers).

### Anti-Pattern 6: NextResponse for SSE (if a proxy route is needed)

**What:** Using `NextResponse` to proxy SSE from port 3001 through a Next.js route.

**Why bad:** `NextResponse` buffers the stream, breaking SSE delivery. This has been a known Next.js issue.

**Instead:** If a proxy route is needed (for auth header injection), use `new Response(readableStream, headers)` (standard Web API, not NextResponse) with `X-Accel-Buffering: no` header to prevent nginx buffering on Railway.

---

## Integration Points

### Existing Code: Reuse Without Change

| Existing | Status | Notes |
|---------|--------|-------|
| `hooks/useEventStream.ts` | Keep exactly | Global SSE singleton is correct. Plugins import this directly. |
| `components/EventStreamProvider.tsx` | Keep exactly | Global counters + status. Mount in RootLayout. |
| `components/SessionProvider.tsx` | Keep exactly | NextAuth wrapper. |
| `middleware.ts` | Keep exactly | Auth guard. |
| `app/api/auth/` | Keep exactly | GitHub OAuth. |

### Existing Code: Replace

| Existing | Replacement | Reason |
|---------|-------------|--------|
| `components/BoardShell.tsx` | `WorkspaceShell.tsx` | Fixed sidebar nav → plugin grid canvas |
| `components/NavBar.tsx` | `WorkspaceBar.tsx` | Page links → preset switcher + plugin add |
| `components/HeaderBar.tsx` | Integrate into WorkspaceBar or keep minimal | Reduce header height for screen real estate |
| `app/[page]/` (16 pages) | `plugins/[name]/index.tsx` (12 plugins) | Fixed pages → composable plugins |

### New Integrations

| New Component | Integrates With | Notes |
|---------------|-----------------|-------|
| `react-grid-layout` | `WorkspaceShell`, `useWorkspace` | Controlled component; layout state external |
| `cmdk` | `WorkspaceShell` (global keyboard listener), data hooks | Fuzzy search, global actions |
| `react-error-boundary` | `PluginSlot` | Plugin crash isolation (D6) |
| `swr` | All data provider hooks | Deduplication, polling fallback, optimistic updates |
| `board.workspaces` table | `/api/workspaces route`, `useWorkspace` | One new Postgres table; no new schema |

### Mobile Breakpoint

At `< 768px`: `react-grid-layout` breakpoint switches to single-column. `WorkspaceShell` renders one plugin at a time with a swipe gesture or bottom-nav to switch. `mobileFullscreen: true` plugins (Approval Queue, HALT Control) take full viewport.

---

## Build Order (Dependency Chain)

The component dependency chain determines phase ordering:

```
1. lib/api-client.ts           (no dependencies — fetch wrapper, auth headers)
   └── 2. hooks/data/*         (depends on api-client)
       ├── 3. hooks/mutations/* (depends on api-client)
       ├── 4. hooks/useWorkspace (depends on api-client + Postgres table)
       └── 5. plugins/*         (depends on data hooks + mutation hooks)
           └── 6. PluginSlot    (depends on plugin registry)
               └── 7. WorkspaceShell (depends on PluginSlot + react-grid-layout + useWorkspace)
                   ├── 8. CommandPalette (depends on WorkspaceShell mounting + data hooks)
                   └── 9. WorkspaceBar  (depends on WorkspaceShell + presets)
```

**Phase implication:** You cannot build plugins (step 5) before data hooks (step 2-3). The shell (step 7) must exist before the command palette (step 8) can be wired. The correct phase structure is:

- **Phase 1:** Shell scaffolding — WorkspaceShell, PluginSlot, ErrorBoundary, registry, one stub plugin to prove the harness
- **Phase 2:** Data layer — api-client, all 10 data hooks, all mutation hooks
- **Phase 3:** Core plugins — ApprovalQueue (P0), HaltControl (P0), then remaining 10 plugins
- **Phase 4:** Command palette, workspace persistence, presets, mobile breakpoints
- **Phase 5:** Legacy decommission — remove inbox-dashboard service, redirect domain

Phases 1 and 2 can partially overlap (api-client can be built before the shell), but plugins need both shell + data layer before they're shippable.

---

## Sources

- Next.js 15 App Router architecture patterns: https://dev.to/teguh_coding/nextjs-app-router-the-patterns-that-actually-matter-in-2026-146
- SSE in Next.js 15 App Router: https://damianhodgkiss.com/tutorials/real-time-updates-sse-nextjs
- SSE buffering fix (NextResponse vs Response, X-Accel-Buffering): https://medium.com/@oyetoketoby80/fixing-slow-sse-server-sent-events-streaming-in-next-js-and-vercel-99f42fbdb996
- react-grid-layout v2 TypeScript RFC and hooks API: https://github.com/react-grid-layout/react-grid-layout/blob/master/rfcs/0001-v2-typescript-rewrite.md
- react-grid-layout GitHub: https://github.com/react-grid-layout/react-grid-layout
- cmdk / shadcn Command: https://www.shadcn.io/ui/command
- Workspace-based multi-panel architecture in Next.js: https://medium.com/@ruhi.chandra14/building-multi-panel-interfaces-in-next-js-using-a-workspace-based-architecture-4209aefff972
- react-error-boundary TypeScript pattern: https://react-typescript-cheatsheet.netlify.app/docs/basic/getting-started/error_boundaries/
- Existing codebase: `board/src/hooks/useEventStream.ts`, `board/src/components/EventStreamProvider.tsx`, `board/src/app/layout.tsx` (read directly — HIGH confidence)

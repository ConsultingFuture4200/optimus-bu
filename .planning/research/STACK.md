# Stack Research

**Domain:** Plugin-based dashboard architecture (Next.js 15 brownfield rebuild)
**Researched:** 2026-04-05
**Confidence:** HIGH for core libraries. MEDIUM for react-grid-layout v2 React 19 runtime behavior (insufficient production reports at this version combination).

---

## Existing Stack (Verified from board/package.json)

The live codebase is already pinned to these versions. Every new dependency must be compatible with them:

| Technology | Current Version | Notes |
|------------|----------------|-------|
| Next.js | ^15.2.0 | App Router |
| React | ^19.0.0 | Already React 19, not 18 |
| react-dom | ^19.0.0 | |
| TypeScript | ^5.7.0 | |
| next-auth | ^4.24.11 | v4, NOT v5 — see notes |
| Tailwind CSS | ^3.4.17 | v3, not v4 |
| ioredis | ^5.10.0 | Redis pub/sub already wired |

---

## Recommended Stack — New Dependencies

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|----------------|
| react-grid-layout | ^2.2.3 | Drag/resize/reorder grid layout engine | v2 is a complete TypeScript rewrite (Dec 2025). Peer deps declare `>= 16.3.0` (no upper bound), so React 19 installs without `--legacy-peer-deps`. v2 API is hooks-based (`useContainerWidth`, `useGridLayout`, `useResponsiveLayout`) — aligned with React 19 functional paradigm. Battle-tested in Grafana, Datadog, Jupyter. The only library that gives you both drag AND resize AND responsive breakpoints out of the box. Alternatives require composing multiple primitives and writing layout serialization yourself. |
| cmdk | ^1.1.1 | Command palette (Cmd+K) | Vercel-maintained. v1.1.0+ uses React's built-in `useSyncExternalStore` (no shim). Peer deps explicitly allow `^18 \|\| ^19 \|\| ^19.0.0-rc`. The React 19 type conflict that affected early v1.0.x was fixed in v1.0.4 and fully resolved by v1.1.0. Used by Linear, Raycast, shadcn/ui. Unstyled — no style conflicts with existing Tailwind setup. |
| recharts | ^3.8.1 | Charts (agent metrics, cost review, pipeline) | Latest v3.x has explicit React 19 peer dep support. Well-established pattern for Next.js App Router: wrap chart components in `'use client'` boundary, push boundary as far down the tree as possible. Direct replacement for any chart code in the existing 16 pages. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| react-resizable-panels | ^4.9.0 | Panel splitting within a workspace | Already in board/package.json. Use for fixed split-pane layouts (e.g., side-by-side plugins at fixed ratios) where react-grid-layout's free-form grid is overkill. |
| @xyflow/react | ^12.10.1 | Task graph visualization | Already in board/package.json. Use for the Pipeline / agent graph plugin only — do not use as a general layout primitive. |
| ioredis | ^5.10.0 | Redis pub/sub → SSE relay | Already in board/package.json. The SSE data path (Redis → Route Handler → EventSource) is already wired. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| TypeScript ^5.7.0 | Type safety | Already configured. react-grid-layout v2 ships full TypeScript types — no `@types/` package needed. cmdk ships its own types. |
| Tailwind CSS ^3.4.17 | Utility styling | Already configured. All new plugin UI uses Tailwind utility classes — no CSS Modules for plugin internals. |
| next/dynamic with `ssr: false` | Client-only rendering boundary | Use for react-grid-layout grid shell. Required to prevent hydration mismatch (ResizeObserver is browser-only). |

---

## Installation

```bash
# From board/ directory
npm install react-grid-layout@^2.2.3 cmdk@^1.1.1 recharts@^3.8.1
```

No `--legacy-peer-deps` required. All three packages declare peer dep ranges that include React 19.

```bash
# CSS — react-grid-layout requires its own stylesheet
# Add to your root layout or global CSS:
# import 'react-grid-layout/css/styles.css';
# import 'react-resizable/css/styles.css';
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Grid layout | react-grid-layout v2 | dnd-kit | dnd-kit is drag-only (no resize). Building resize, collision detection, layout serialization, and breakpoints on top of dnd-kit would cost more than building the plugins themselves. Good for sortable lists; wrong tool for resizable dashboard panes. |
| Grid layout | react-grid-layout v2 | gridstack.js | jQuery dependency. Not a React-first library. Adds complexity to the SSR/hydration boundary. |
| Grid layout | react-grid-layout v2 | react-grid-layout-19 (fork) | Community fork with unclear maintenance status. Unnecessary now that the official v2.2.3 has `>= 16.3.0` peer deps and v2 is a full hooks rewrite. |
| Command palette | cmdk | kbar | No active maintenance since 2022. cmdk is Vercel-maintained and actively used by shadcn/ui ecosystem. |
| Command palette | cmdk | react-cmdk | Opinionated styling that conflicts with existing Tailwind setup. Smaller community. |
| Charts | recharts | Victory | Smaller ecosystem, fewer Next.js examples, less actively maintained. |
| Charts | recharts | Chart.js (react-chartjs-2) | Non-React-native rendering model. SSR complexity. recharts is built on D3 with React primitives — better fit. |
| Auth | next-auth v4 (existing) | next-auth v5 (Auth.js) | v5 is still beta (5.0.0-beta.25 as of April 2026). Migrating auth mid-project violates kill criterion for unexpected complexity. Existing v4 + GitHub OAuth works. Leave it. |

---

## What NOT to Use

| Library | Reason |
|---------|--------|
| WidthProvider (react-grid-layout v1 HOC) | Removed in v2. Use `useContainerWidth` hook instead. DO NOT import from `react-grid-layout/legacy` unless migrating old code. |
| `data-grid` prop pattern | Removed in v2 core. Available only via legacy wrapper. All new plugin grid code must use the explicit `layout` prop. |
| react-beautiful-dnd | Archived by Atlassian. No React 19 support. |
| react-dnd | Maintenance slowdown; lacks resize; requires custom collision detection. |
| next-auth v5 (beta) | Not installed. Do not upgrade during this milestone. |
| Tailwind CSS v4 | Not installed (board uses v3). Do not upgrade during this milestone — breaking changes in config format. |
| Global CSS for plugin styles | Violates plugin isolation. Each plugin owns its Tailwind classes; no global stylesheet side effects. |
| `suppressHydrationWarning` as a crutch | Not a fix. Use `next/dynamic` with `ssr: false` as the proper boundary for browser-only grid rendering. |

---

## Version Compatibility

| Library | React 18 | React 19 | Next.js 15 App Router | Notes |
|---------|----------|----------|----------------------|-------|
| react-grid-layout ^2.2.3 | Yes | Yes (peer dep `>= 16.3.0`, no upper bound) | Requires `'use client'` + `ssr: false` dynamic import for grid shell | MEDIUM confidence on React 19 runtime — v2 is from Dec 2025, limited production reports at React 19 specifically. Use `useContainerWidth` with `mounted` guard. |
| cmdk ^1.1.1 | Yes | Explicit: `^18 \|\| ^19` | Requires `'use client'` | HIGH confidence. v1.1.0 replaced shim with React built-in. React 19 type conflict fixed in v1.0.4. |
| recharts ^3.8.1 | Yes | Yes (v2.15+ adds React 19 peer dep) | Requires `'use client'` | HIGH confidence. Widely used pattern in Next.js 15 ecosystem. |
| next-auth ^4.24.11 | Yes | Yes (installed) | Supported via `/api/auth/[...nextauth]` route handler | Already working in production. |
| @xyflow/react ^12.10.1 | Yes | Yes (installed) | Requires `'use client'` | Already working in production. |

### The SSR/Client Boundary Pattern

Every interactive UI library in this stack requires client-side rendering. The correct pattern for Next.js 15 App Router:

```typescript
// shell/WorkspaceGrid.tsx
'use client';
import dynamic from 'next/dynamic';
import { useContainerWidth } from 'react-grid-layout';

// For the grid shell itself, SSR is actively harmful (ResizeObserver unavailable)
// useContainerWidth returns mounted=false on server; only render grid after mount:
const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1280 });

return (
  <div ref={containerRef}>
    {mounted && <ReactGridLayout width={width} layout={layout} ... />}
  </div>
);
```

Push `'use client'` boundaries as far down the component tree as possible. Server Components can render plugin chrome (titles, borders, loading states). Only the interactive internals need `'use client'`.

### Railway SSE Constraints

SSE connections on Railway terminate after 15 minutes maximum. The existing Redis → SSE relay must implement client-side reconnection (EventSource's built-in auto-reconnect handles this automatically). If SSE connection latency exceeds the 5s kill criterion, the polling fallback path (REST `/api/...` on interval) is the defined escape hatch — it is already in scope per PRD.

---

## Sources

- react-grid-layout GitHub repository: https://github.com/react-grid-layout/react-grid-layout
- react-grid-layout CHANGELOG (v2.x): https://github.com/react-grid-layout/react-grid-layout/blob/master/CHANGELOG.md
- react-grid-layout package.json (peer deps verified): `peerDependencies: { "react": ">= 16.3.0" }`
- cmdk GitHub releases: https://github.com/pacocoursey/cmdk/releases
- cmdk package.json (peer deps verified): `peerDependencies: { "react": "^18 || ^19 || ^19.0.0-rc" }`
- shadcn-ui React 19 cmdk bug (fixed in v1.0.4): https://github.com/shadcn-ui/ui/issues/6200
- recharts React 19 support issue: https://github.com/recharts/recharts/issues/4558
- Railway SSE vs WebSockets guide: https://docs.railway.com/guides/sse-vs-websockets
- board/package.json (existing deps, verified): React 19, Next.js 15.2, next-auth v4, Tailwind v3
- ilert: Why react-grid-layout for dashboards: https://www.ilert.com/blog/building-interactive-dashboards-why-react-grid-layout-was-our-best-choice

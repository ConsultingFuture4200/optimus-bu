# Pitfalls Research

**Domain:** Plugin-based dashboard rebuild (Next.js 15 + react-grid-layout + SSE)
**Researched:** 2026-04-05
**Confidence:** HIGH (Railway SSE limits confirmed from official docs; rgl hydration/touch issues confirmed from GitHub issues; Next.js patterns from official docs and verified community sources)

---

## Critical Pitfalls

These cause rewrites, safety incidents, or total feature loss.

---

### CP-1: react-grid-layout breaks on SSR — hydration mismatch crashes the shell

**What goes wrong:** react-grid-layout uses `window` and computes pixel widths at mount time. When Next.js App Router renders the grid on the server, the layout positions do not match what the client computes after mount. React throws a hydration mismatch, which in Next.js 15 / React 19 is a hard error that crashes the entire component tree — taking down the whole workspace shell, not just one plugin.

**Why it happens:** `WidthProvider` (legacy) and `useContainerWidth` (v2) both measure the DOM container width using `ResizeObserver`. There is no DOM on the server. The initial `width` defaults to `1280px`, which almost never matches the real container width, causing mismatched `transform: translate()` values between server HTML and first client render.

**How to avoid:**
- Import the grid shell exclusively with `dynamic(() => import('./WorkspaceShell'), { ssr: false })`. This is the one legitimate `ssr: false` case in this codebase — the grid is purely a client layout surface.
- Do not use `WidthProvider` HOC from the legacy path. Use `useContainerWidth` from the v2 API and attach `containerRef` to the outer div.
- Keep all plugin content components as server components where possible; only the grid container needs the `'use client'` boundary.

**Warning signs:**
- "Hydration failed" errors in the browser console on first load
- Layout items appear in wrong positions for one frame then snap
- The entire workspace page goes blank instead of showing a shell

**Phase to address:** Phase 1 (shell scaffold). Get this right before building any plugins.

---

### CP-2: Railway silently drops SSE connections — HALT button becomes unresponsive

**What goes wrong:** Railway's load balancer enforces a **15-minute maximum HTTP connection duration** for both SSE and WebSocket connections. The `EventSource` API auto-reconnects, but during the reconnect window (which can be 1–30 seconds depending on the retry interval), real-time agent status updates stop flowing. If the HALT control plugin is driven by SSE and the connection dropped silently, a board member pressing HALT may see stale state.

Additionally, Railway has documented a secondary limit: connections are dropped after approximately **1 MB of transferred data**, suspected to be at the gateway/load balancer layer. This is separate from the 15-minute cap and can happen much sooner on high-volume event streams.

On top of Railway's limits, intermediate proxies (corporate networks, VPNs) may buffer the entire SSE response until the connection closes — meaning no events arrive until disconnect, at which point all events arrive at once. This is the "production SSE is still not ready" failure mode described in post-mortems.

**Why it happens:** Railway's infrastructure enforces HTTP duration limits that are appropriate for normal request-response cycles but break long-lived streaming connections. Proxy buffering is a separate, uncontrollable network-layer issue.

**How to avoid:**
- Implement mandatory client-side reconnect with exponential backoff. The native `EventSource` auto-reconnects but does not provide backoff — use `reconnecting-eventsource` or a custom implementation.
- Send a server-side heartbeat comment (`": keep-alive\n\n"`) every 15–20 seconds. This (a) keeps the connection alive through idle periods and (b) forces proxies to flush their buffers rather than accumulate data.
- Set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` headers on the SSE Route Handler response. The `no-transform` directive signals proxies not to buffer.
- Include event IDs and handle `Last-Event-ID` on reconnect so replayed events are not missed.
- For P0 safety features (HALT, approval state), **always poll as a fallback**. SSE drives the live display; a 10-second REST poll is the safety net. Never make HALT depend solely on SSE state being current.
- The SSE Route Handler in Next.js App Router must return the `Response` immediately before starting async work — chunks buffered until `res.end()` is a known issue with the Pages Router API routes; use Route Handlers (`app/api/.../route.ts`) instead.

**Warning signs:**
- Agent status stops updating without a visible error
- SSE connection shows "connected" in DevTools but no events arrive
- Events arrive in large batches rather than individually

**Phase to address:** Phase 1 (data provider hooks). Build reconnect + heartbeat + fallback polling from day one. Do not defer to "polish phase."

---

### CP-3: Layout persistence schema has no version field — old layouts silently corrupt new plugin configs

**What goes wrong:** The `board.workspaces` table stores a JSON layout blob. When a plugin is renamed, removed, or its config shape changes, existing persisted workspaces reference plugin IDs that no longer exist or carry config keys that the plugin no longer accepts. The grid renders blank panels where plugins should be, or worse, silently loads stale config that causes confusing behavior.

**Why it happens:** Teams add a `layout` JSONB column and persist `{ items: [...] }` without a `schemaVersion` field. When they rename a plugin from `"inbox-triage"` to `"approval-queue"`, every saved workspace now has orphaned item references. There is no migration path because there is no version to migrate from.

**How to avoid:**
- Include a `schemaVersion: number` field at the root of every persisted workspace JSON from day one. Start at `1`.
- Write a `migrateWorkspace(raw, currentVersion)` function that transforms old shapes forward. Even if v1→v2 is a no-op, the function must exist.
- When deserializing a workspace, filter out any plugin items whose `type` is not in the current registry. Render a recoverable "plugin not found" placeholder instead of crashing.
- Store plugin configs as `{ pluginType: string, version: number, config: object }` per item, not a flat blob.

**Warning signs:**
- Board member's saved workspace loads with blank or missing panels
- No error thrown — just empty grid cells
- A plugin rename in code silently invalidates all saved layouts containing it

**Phase to address:** Phase 1 (workspace persistence schema). Schema versioning is free to add at creation time and extremely expensive to retrofit.

---

### CP-4: Error boundaries do not catch async errors or event handler failures

**What goes wrong:** React error boundaries only catch errors that occur during render, in lifecycle methods, and in constructors. They do not catch errors from `useEffect`, async data fetches, event handlers, or promise rejections. A plugin that crashes during a button click (e.g., an approval action throwing a network error) will bubble up uncaught, potentially crashing the entire workspace rather than just showing the plugin's error card.

**Why it happens:** The design principle D6 (plugin crash isolation) is correct, but error boundaries alone do not fulfill it. Developers wrap a plugin in `<ErrorBoundary>` and assume it is isolated — but the boundary only covers render-time errors.

**How to avoid:**
- Wrap all plugin async operations in try/catch with explicit error state.
- Use `react-error-boundary` (not a hand-rolled class component) — it provides `useErrorBoundary()` hook, which lets async code manually trigger the boundary's fallback UI via `showBoundary(error)`.
- Each plugin's data provider hook must catch fetch errors and return `{ data: null, error: Error }` — never throw from a hook unconditionally.
- Never place the error boundary above the grid shell. One boundary per plugin slot, not one boundary for the workspace.

**Warning signs:**
- A button click in one plugin causes the entire workspace to go blank
- Console shows uncaught promise rejection instead of a contained error card
- The error boundary fallback never appears, even when plugins clearly crash

**Phase to address:** Phase 1 (plugin lifecycle). Establish the `useErrorBoundary` pattern in the plugin host contract before any plugin is built.

---

### CP-5: HALT control is gated behind the SSE-driven state read — safety-critical action depends on real-time data accuracy

**What goes wrong:** If the HALT plugin only shows the HALT button when agent status is "running" (as read from SSE), and the SSE connection has silently dropped, the HALT button disappears or is disabled — exactly when it may be needed most.

**Why it happens:** Developers conflate "display state" with "action precondition." SSE-driven state is appropriate for display ("3 agents running"). It is not appropriate as the sole gate for safety-critical writes.

**How to avoid:**
- The HALT button must be always-visible and always-enabled regardless of SSE connection state.
- The HALT action must be a direct REST POST that goes through the existing guardCheck infrastructure — it does not depend on SSE state.
- SSE state informs the display (badge counts, agent status) but never disables the kill switch.
- Show a visible "disconnected" indicator when SSE drops, but keep the HALT button functional.

**Warning signs:**
- HALT button grayed out or absent during SSE reconnect windows
- HALT action calls a local state derived from SSE rather than calling the API directly

**Phase to address:** Phase 1 (HALT plugin). Must be reviewed explicitly before HALT plugin ships.

---

## Technical Debt Patterns

| Pattern | How It Starts | Where It Ends |
|---------|--------------|---------------|
| `'use client'` creep | One plugin needs a hook, parent gets marked `'use client'` | Entire plugin tree is client-rendered, SSR gains disappear |
| Flat plugin registry object | `const plugins = { approval: ApprovalPlugin }` hardcoded in one file | Every new plugin requires editing the registry file, PRs conflict |
| Workspace JSON stored as opaque blob | `JSON.stringify(layout)` into one column | Cannot query, migrate, or validate individual plugin configs |
| Width hardcoded as `1280` | Forgot to attach `containerRef` from `useContainerWidth` | Grid renders with wrong column widths until window resize |
| SSE connection managed in component | `new EventSource(...)` inside a `useEffect` | Multiple connections opened on re-render, Railway connection limit hit |

---

## Integration Gotchas

| Area | Gotcha | Mitigation |
|------|--------|------------|
| react-grid-layout v2 API | `WidthProvider` HOC no longer the canonical path — now `useContainerWidth` hook. Legacy HOC still works but deprecated | Use v2 hook API from the start |
| Next.js Route Handler + SSE | `res.write()` buffering pattern from Pages Router does not work — must use `ReadableStream` with `Response` | Use `new Response(new ReadableStream(...))` pattern in App Router Route Handlers |
| cmdk `Command.Dialog` | `open` prop must be `false` on the server or SSR throws hydration error | Initialize open state as `false`; never derive from server-rendered context |
| react-grid-layout + mobile touch | `touch-action: none` is added to all draggable items, which blocks page scroll on mobile — even when drag mode is off | Set `isDraggable={false}` on mobile breakpoint (`<768px`) and remove `touch-action: none` via CSS override |
| Responsive breakpoint layouts | `ResponsiveGridLayout` stores separate layout arrays per breakpoint — if you only save the `lg` layout and restore it, mobile layouts are missing and RGL falls back to interpolation, which is often wrong | Persist all breakpoint layouts from `onLayoutChange(layout, allLayouts)` — use `allLayouts`, not `layout` |
| Plugin context provider placement | Wrapping the entire `<html>` or `<body>` in a plugin context provider forces the whole document to be client-rendered | Scope providers to the workspace route segment only; keep root layout as server component |
| Redis → SSE fan-out | If the Next.js API route that relays Redis pub/sub events crashes, all SSE clients lose events with no visibility | Add a health check endpoint; log SSE relay errors explicitly; fall back to polling |

---

## Performance Traps

| Trap | Trigger | Impact | Prevention |
|------|---------|--------|------------|
| Layout recalc on every plugin state update | Plugin state stored in grid-level state instead of per-plugin state | Every agent status update re-renders all 12 plugins | Keep plugin data state inside each plugin; pass only layout props to the grid |
| `onLayoutChange` writes to Postgres on every drag event | Debouncing not applied to the persistence callback | Database hammered during drag operations; Railway connection pool exhausted | Debounce layout persistence by 500–1000ms; write on drag stop, not drag move |
| WidthProvider / `useContainerWidth` on window resize | Not using `ResizeObserver` on container — falling back to window resize event | Entire grid recalculates on any window resize, including unrelated browser chrome changes | Ensure `containerRef` is attached; `useContainerWidth` uses `ResizeObserver` on the element, not `window` |
| All plugins subscribe to SSE stream simultaneously | 12 plugins each opening their own `EventSource` | 12 connections to Railway; browser 6-connection HTTP/1.1 limit blocks other fetches | One SSE connection at the workspace level; broadcast to plugins via React context or Zustand |
| SSE event fan-out via re-render | SSE message triggers state update in a high-level context, all plugins re-render | Frame drops visible when high-frequency events arrive | Use `useSyncExternalStore` or Zustand for SSE state; avoid `useState` in the SSE context provider |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Plugin configs stored in `localStorage` rather than Postgres | Config visible to any injected script; no server-side validation | Per-project requirement: persist to `board.workspaces` table through the existing auth session |
| SSE endpoint unauthenticated | Any user can subscribe to agent event stream | Validate NextAuth session in the SSE Route Handler before opening the stream; 401 on missing session |
| Plugin config `JSON.parse`d without validation | Stale or tampered workspace JSON causes unexpected plugin behavior | Validate deserialized config against a Zod schema per plugin type before passing as props |
| HALT endpoint callable without guardCheck | Safety-critical action bypasses constitutional gate G8 | HALT REST call goes through existing `guardCheck()` infrastructure — never a direct DB update |

---

## UX Pitfalls

| Pitfall | How It Manifests | Prevention |
|---------|-----------------|------------|
| Layout "pops" on load | Grid renders in wrong positions for 100–200ms until `useContainerWidth` measures the container, then jumps to final positions | Show a skeleton/placeholder during mount; use `measureBeforeMount: true` if available, or delay grid render until width is measured |
| Mobile: drag handle conflicts with scroll | User tries to scroll the page on mobile, but the draggable grid item intercepts the touch event | Disable drag/resize entirely at `<768px`; render single-plugin full-screen with swipe navigation as specified |
| Command palette not indexed at launch | Board member presses Cmd+K expecting to find plugins but the index is empty until workspaces load | Build the command index from the static plugin registry, not from loaded workspace state — plugins are always available even before a workspace is loaded |
| Workspace preset "Daily Ops" doesn't match the user's last manual layout | Switching to a preset silently overwrites the user's saved layout | Treat presets as read-only templates; applying a preset creates a new workspace, it does not overwrite the current one |
| Existing page features missing after migration | A workflow that worked on the 16 fixed pages is absent or broken in the plugin version | Maintain an explicit feature parity matrix (one row per existing page function) with sign-off before decommissioning any legacy page |

---

## "Looks Done But Isn't" Checklist

These are items that appear complete in development but fail in production or under edge conditions:

- [ ] Grid renders correctly in production but breaks on Railway because SSE heartbeat is missing and connection drops after 2 minutes
- [ ] Workspace persistence works in development but `schemaVersion` field absent — first plugin rename will corrupt all saved layouts
- [ ] HALT plugin shows correct state locally but depends on SSE; drops to stale state under Railway 15-minute reconnect
- [ ] Error boundaries wrap all plugins in development but async errors in approval action handlers go untrapped
- [ ] Mobile layout appears correct at 375px emulation but draggable touch-action blocks scroll on real iOS Safari
- [ ] SSE receives all events in development (localhost, no proxy) but events arrive in batches on corporate network
- [ ] Layout saves correctly on drag stop but `onLayoutChange` fires for `lg` breakpoint only — `sm` layout is not persisted, mobile layout reverts to interpolated default
- [ ] Command palette searches plugins but does not search drafts — board member expects to find draft approvals by Cmd+K
- [ ] Legacy inbox dashboard decommissioned but domain redirect not configured — `inbox.staqs.io` returns 404 instead of redirecting to `board.staqs.io`
- [ ] Plugin `'use client'` boundary set correctly but parent layout component also has `'use client'` for an unrelated reason — server component gains disappear silently
- [ ] react-grid-layout imported without `ssr: false` — hydration errors are intermittent (only fail when server-rendered width differs from client), making them easy to miss in happy-path testing

---

## Pitfall-to-Phase Mapping

| Phase Topic | Pitfall | Mitigation |
|-------------|---------|------------|
| Shell scaffold (Phase 1) | CP-1: Hydration crash | `dynamic({ ssr: false })` on grid shell before any other work |
| Shell scaffold (Phase 1) | CP-3: No schemaVersion | Add `schemaVersion: 1` to workspace schema DDL in the same migration that creates the table |
| Data provider hooks (Phase 1) | CP-2: SSE drops silently | Heartbeat + reconnect + polling fallback baked into the data provider hook contract |
| Plugin lifecycle (Phase 1) | CP-4: Boundary gaps | `react-error-boundary` + `useErrorBoundary` in plugin host contract |
| HALT plugin (Phase 1) | CP-5: HALT gated on SSE state | Always-visible button; direct REST POST; explicit review gate before ship |
| Mobile optimization | Touch/scroll conflict | `isDraggable={false}` at `<768px`; validate on real iOS Safari, not emulation |
| Plugin migration (all phases) | Feature parity | Maintain explicit parity matrix; do not decommission a legacy page until all its functions are verified in the new plugin |
| Workspace presets | Preset overwrites layout | Presets as read-only templates; applying preset creates new workspace |
| Decommission legacy dashboard | Domain redirect missed | Redirect config verified in Railway before legacy service is removed |

---

## Sources

- Railway SSE/WebSocket documentation: [Choose Between SSE and WebSockets — Railway Guides](https://docs.railway.com/guides/sse-vs-websockets)
- Railway SSE 1MB transfer limit (community report): [Are there limits on total transfer size over SSE? — Railway Help Station](https://station.railway.com/questions/are-there-limits-on-total-transfer-size-3c991de1)
- SSE proxy buffering post-mortem: [Server Sent Events are still not production ready after a decade — DEV Community](https://dev.to/miketalbot/server-sent-events-are-still-not-production-ready-after-a-decade-a-lesson-for-me-a-warning-for-you-2gie)
- Next.js SSE Route Handler buffering issue: [Server-Sent Events don't work in Next API routes — vercel/next.js Discussion #48427](https://github.com/vercel/next.js/discussions/48427)
- Nginx proxy buffering for SSE: [Surviving SSE Behind Nginx Proxy Manager — Medium](https://medium.com/@dsherwin/surviving-sse-behind-nginx-proxy-manager-npm-a-real-world-deep-dive-69c5a6e8b8e5)
- react-grid-layout hydration / SSR: [How to Fix Hydration Mismatch Errors in Next.js — OneUptime](https://oneuptime.com/blog/post/2026-01-24-fix-hydration-mismatch-errors-nextjs/view)
- react-grid-layout performance at scale: [Performance with large number of items — GitHub Issue #1069](https://github.com/STRML/react-grid-layout/issues/1069)
- react-grid-layout v2 `useContainerWidth` and `WidthProvider` deprecation: [react-grid-layout GitHub](https://github.com/react-grid-layout/react-grid-layout)
- react-grid-layout mobile touch-action conflict: [touch-action: none is added to items — GitHub Issue #637](https://github.com/react-grid-layout/react-grid-layout/issues/637)
- react-grid-layout localStorage layout reset bug (schemaVersion lesson): [Layouts stored in local storage are being reset every reload — GitHub Issue #902](https://github.com/STRML/react-grid-layout/issues/902)
- Next.js App Router `'use client'` overuse: [Next.js App Router Patterns That Actually Work — DevGlory](https://devglory.com/blog/next-js-15-app-router-patterns-that-actually-work)
- Error boundary async gap: [React Error Boundaries — React legacy docs](https://legacy.reactjs.org/docs/error-boundaries.html)
- react-error-boundary `useErrorBoundary` hook: [Error Handling in React with react-error-boundary — Certificates.dev](https://certificates.dev/blog/error-handling-in-react-with-react-error-boundary)
- cmdk SSR `open` prop fix: [shadcnstudio/shadcn-cmdk-search — GitHub](https://github.com/shadcnstudio/shadcn-cmdk-search)
- Dashboard schema versioning complexity: [Dashboard Schema Versioning — Perses Discussion #1186](https://github.com/perses/perses/discussions/1186)
- SSE HTTP/2 and 6-connection browser limit: [Server-Sent Events don't work in Next API routes — vercel/next.js Discussion #48427](https://github.com/vercel/next.js/discussions/48427)

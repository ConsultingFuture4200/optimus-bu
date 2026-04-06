# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Repository:** [`staqsIO/optimus`](https://github.com/staqsIO/optimus) — consolidated monorepo (March 2026). Previously two separate repos (`staqsIO/autobot-inbox` and `staqsIO/autobot-spec`), unified via subtree merge.

## What Is Optimus

Optimus is a **governed agent organization** — a fully agent-staffed technology company where every operational role is an AI agent, governed by a human board of directors (Dustin and Eric). Agents coordinate through a Postgres task graph. Every action is logged to a public event archive. The board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

Optimus builds and operates software products. **autobot-inbox** is the first product — an AI-powered inbox management system. The distinction matters: Optimus is the company; autobot-inbox is a product the company builds.

**AutoBot** is the long-term goal: an autonomous constitutional agent organization where the human board is replaced by a constitutional layer. AutoBot cannot exist until Optimus proves agent governance works under human supervision.

### Governing Documents

**`SPEC.md`** (v1.0.0) is the canonical architecture specification. Design decisions and implementation patterns should align with this document. When the spec is silent on a topic, use pragmatic judgment — flag significant gaps for board review rather than blocking on spec coverage.

**`CONSTITUTION.md`** contains the prescriptive governance constraints extracted from SPEC.md — design principles (P1-P6), Lethal Trifecta assessment, Kill Switch architecture, AutoBot Constitution, legal compliance, and exclusions. This is the audit reference document used by the governance intake system's automated classifier. The full SPEC.md v1.0.0 is archived at `spec/archive/SPEC-v1.0.0.md`.

### Design Principles (§0) — Non-Negotiable

These govern every architectural decision. Cite by number when relevant.

- **P1. Deny by default.** Nothing is permitted unless explicitly granted.
- **P2. Infrastructure enforces; prompts advise.** The enforcement boundary is never the prompt.
- **P3. Transparency by structure, not by effort.** Logging is a side effect of operating, not a feature agents choose to provide.
- **P4. Boring infrastructure.** Postgres, SQL, JWT, hash chains. Novelty is for the organizational model, not the plumbing.
- **P5. Measure before you trust.** Capability gates pass on data, not calendar dates.
- **P6. Familiar interfaces for humans.** The system adapts to humans, not the reverse.

## Workspace Structure

```
optimus/
├── SPEC.md                    # Canonical architecture specification (v1.0.0, read-only source of truth)
├── CONSTITUTION.md            # Prescriptive governance constraints (audit reference)
├── CLAUDE.md                  # This file — repo-wide guidance for Claude Code
├── lib/                       # Org-level infrastructure (shared across all products)
│   ├── runtime/               # Agent loop, state machine, guard checks, event bus, context loader
│   ├── adapters/              # Channel-agnostic I/O (email, Slack, Telegram, webhook)
│   ├── graph/                 # Task graph + Neo4j knowledge graph operations
│   ├── comms/                 # Communication Gateway (outbound release tiers)
│   ├── rag/                   # RAG pipeline (chunker, embedder, retriever, normalizers)
│   ├── audit/                 # 3-tier audit system
│   ├── llm/                   # LLM provider abstraction
│   └── db.js                  # Database connection (Postgres/PGlite)
├── agents/                    # Org-level agents (channel-agnostic, reusable across products)
│   ├── executor-intake.js     # Message classification
│   ├── executor-coder.js      # Code generation → PRs
│   ├── executor-ticket.js     # Linear + GitHub issue creation
│   ├── executor-blueprint.js  # Architecture blueprints
│   ├── executor-redesign.js   # UI redesign pipeline
│   ├── executor-research.js   # Web research + synthesis
│   ├── reviewer.js            # Gate checks, quality assurance
│   ├── architect.js           # Daily analysis, briefings
│   ├── claw-workshop/         # Linear-issue-driven implementation
│   ├── claw-campaigner/       # Multi-step campaign execution
│   └── research/              # Deep research handler
├── autobot-inbox/             # First product: AI inbox management (JavaScript/Node.js)
│   ├── CLAUDE.md              # Product-specific implementation guidance
│   ├── src/agents/            # Inbox-specific agents (orchestrator, triage, responder, strategist)
│   ├── src/gmail/             # Gmail API integration (product-specific)
│   ├── src/voice/             # Voice learning system (product-specific)
│   ├── src/signal/            # Signal extraction + briefings
│   ├── config/                # Agent configs (agents.json), routing rules, gate definitions
│   ├── sql/                   # DDL migrations (001 baseline through 013)
│   ├── dashboard/             # Legacy inbox dashboard (port 3100)
│   └── docs/                  # Internal and external documentation
├── spec/                      # Architecture specification workspace (Markdown only)
│   ├── CLAUDE.md              # Spec workflow conventions
│   ├── archive/               # Versioned spec snapshots (SPEC-v1.0.0.md)
│   ├── conversation/          # Immutable historical conversation records
│   └── reviews/               # Agent review transcripts
├── board/                     # Board Workstation (PRIMARY): Next.js 15 (port 3200, board.staqs.io)
│   └── src/app/               # Today, Drafts, Signals, Pipeline, Workstation, Governance, etc.
└── [future products]/         # Additional products Optimus builds
```

**Three-layer architecture:**
- `lib/` — Org-level infrastructure (task graph, runtime, adapters, guardrails, RAG)
- `agents/` — Org-level agents (channel-agnostic, reusable across products)
- `autobot-inbox/` — Product code (inbox-specific agents, Gmail/voice/signal, config)

Re-export shims in `autobot-inbox/src/` maintain backward-compatible import paths for all moved code.

## Optimus Architecture (SPEC §2–§5)

### Agent Tiers

Optimus agents are organized in a strict hierarchy. Each tier has explicit capabilities and constraints enforced by infrastructure (P2), not prompts. Every agent in `config/agents.json` has `tier` and `subTier` fields mapping to this hierarchy.

| Tier | Sub-Tiers | Model(s) | Role | Key Constraints |
|------|-----------|----------|------|-----------------|
| Strategist | core | Gemini 2.5 Pro | Priority scoring, strategy recommendations | Suggest mode (Phase 1). Cannot deploy or modify infrastructure. |
| Architect | core, exploration | Gemini 2.5 Pro, Sonnet | Technical analysis, autonomous codebase exploration | Cannot assign tasks to executors directly. |
| Orchestrator | core, workshop, campaign | DeepSeek, Sonnet | Pipeline coordination, Linear-driven implementation, campaigns | Explicit `can_assign_to` list (no globs). Cannot create DIRECTIVEs. |
| Reviewer | core | Sonnet | Gate checks, quality assurance | Read-only on executor work. 1 round of feedback then escalate. |
| Executor | intake, triage, responder, ticketing, engineering, research | Haiku, Sonnet | Classification, drafting, code generation, research | Cannot initiate tasks, cannot read other executors' work. |
| Utility | query | DeepSeek | Board question answering | No agent communication except configured target. |
| External | nemoclaw | Gemini 2.5 Pro | Board member agent instances | API-only interaction. No task graph write access. |

### Task Graph (§3)

The Postgres task graph (`agent_graph` schema) is the single source of truth for all agent coordination. No email, no message queue — structured work items with typed DAG edges, atomic state transitions, and immutable audit logging.

Work item states: `created → assigned → in_progress → review → completed`. Terminal states: `completed`, `cancelled`. Failed tasks retry up to 3 times, then escalate.

### Guardrail Enforcement (§5)

The orchestration layer enforces all guardrails — agents do not self-police. `guardCheck()` and `transition_state()` execute as a single atomic Postgres transaction.

**Currently implemented:** Constitutional gates G1-G8 enforced via DB constraints and `lib/runtime/guard-check.js` — budget pre-authorization, commitment detection, voice tone matching, autonomy level checks, rate limiting, prompt injection screening (Model Armor).

**Target architecture (per SPEC §5):** JWT-scoped agent identity, Postgres RLS for agent data isolation, tool allow-lists, content sanitization on all context loads, tool integrity verification (hash check before invocation).

### Current Phase

**Phase 1 (Optimus MVP) — in progress.** autobot-inbox is live: 18 agents across 7 tiers, 5 channels (Gmail, Slack, Telegram, Drive, webhooks), constitutional gates G1-G8, RAG knowledge base (863 docs), CLI + Next.js dashboard + Board Workstation. See SPEC §14 for remaining deliverables and exit criteria.

## Running Locally

**Docker Compose is the recommended way to run the full stack** — it handles Postgres (pgvector), Redis, and all services with hot reload.

```bash
cp .env.example .env        # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d        # start everything
docker compose logs -f      # follow logs
```

| Port | Service | Railway Domain |
|------|---------|----------------|
| 5432 | Postgres (pgvector) | — |
| 6379 | Redis | — |
| 3001 | autobot-inbox API | preview.staqs.io |
| 3100 | autobot-inbox dashboard (legacy) | inbox.staqs.io |
| 3200 | Board Workstation (PRIMARY) | board.staqs.io |
| 3000 | Docs site | — |

## Product: autobot-inbox

See `autobot-inbox/CLAUDE.md` for product-specific implementation details including build commands, environment variables, database schemas, constitutional gates (G1–G7), and agent pipeline configuration.

### Quick Reference (without Docker)

```bash
cd autobot-inbox

# Runtime
npm start              # Start agent runtime (poll loop)
npm run dev            # Watch mode
npm run cli            # Interactive CLI

# Database
npm run migrate        # Run SQL migrations
npm run seed           # Seed initial config

# Testing
npm test               # Unit tests
npm run test:integration

# Dashboard
cd dashboard && npm run dev   # Next.js 15 on port 3100
```

Node >= 20.0.0. Package manager: npm. ES modules throughout (`"type": "module"`).

## Code Conventions (Repo-Wide)

These apply to all code in the monorepo, derived from the spec's design principles:

- **Parameterized queries only** — never interpolate strings into SQL (P1, P2)
- **No ORM** — raw SQL with parameterized queries (P4)
- **Boring dependencies** — pg, googleapis, @anthropic-ai/sdk. Nothing exotic. (P4)
- **Events via pg_notify** — no external message queue (P4)
- **Append-only audit** — state_transitions and all audit tables are immutable, hash-chained (P3)
- **Infrastructure enforcement** — security boundaries are database roles, JWT scoping, and schema constraints, never prompt instructions (P2)
- **No cross-schema foreign keys** — schemas are isolated by database roles (SPEC §12)

## Working in autobot-spec

The `spec/` sub-project is a design workspace, not code. `SPEC.md` is the single source of truth. Conversation entries in `conversation/` are immutable historical records — never modify after commit. Changes to the spec require both board members' review.

## Board Communication

When producing artifacts for board review:

- **Dustin** — Lead with what you're recommending, then why, then how. Frame trade-offs as board decisions. Flag costs, risks, and timeline implications proactively. Don't simplify — teach.
- **Eric** — Speak peer-to-peer technically. Reference specific spec sections. When you disagree with a decision, say so directly with reasoning.
- **Both** — Never present as final anything involving: budget, security boundaries, legal/compliance, external communication, or phased execution plan changes. Surface blockers immediately.

## Documentation Agents (Scribe & Herald)

Scribe (internal/engineering docs) and Herald (external/board-facing docs) are independent — run in parallel when both triggered.

### Scribe Triggers

| Change Type | Target File(s) |
|-------------|----------------|
| New SQL migration | `autobot-inbox/docs/internal/database-architecture.md` |
| New module or directory under `src/` | `autobot-inbox/docs/internal/system-architecture.md` |
| Architecture decision | New ADR in `autobot-inbox/docs/internal/adrs/NNN-*.md` |
| Agent added, removed, or reconfigured | `autobot-inbox/docs/internal/agent-pipeline.md` |
| Constitutional gate changed | `autobot-inbox/docs/internal/constitutional-gates.md` |
| Cost model change | `autobot-inbox/docs/internal/cost-model.md` |
| Spec-level architecture decision | New ADR in `spec/decisions/NNN-*.md`, update `SPEC.md` |

### Herald Triggers

| Change Type | Target File(s) |
|-------------|----------------|
| Feature shipped or milestone | `autobot-inbox/docs/external/changelog.md` |
| Product capability changed | `autobot-inbox/docs/external/product-overview.md` |
| CLI command changed | `autobot-inbox/docs/external/cli-guide.md` |
| Dashboard page changed | `autobot-inbox/docs/external/dashboard-guide.md` |

ADRs follow the template in `autobot-inbox/docs/internal/adrs/README.md`. Herald uses [Keep a Changelog](https://keepachangelog.com/) format — board audience, describe operational changes, not code changes.

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Board Workstation Plugin Rebuild**

A frontend rebuild of the Board Workstation (`board/src/app/`) from 16 fixed Next.js pages to a composable plugin-host workspace architecture, plus decommissioning the legacy inbox dashboard (`autobot-inbox/dashboard/`, port 3100). One codebase, one deployment, one port. The plugin shell consumes the existing autobot-inbox API (port 3001) — the brain connection is already built, we're replacing the frontend that renders it.

**Core Value:** The board's operational control surface (approve drafts, trigger HALT, monitor agents, review costs) works reliably through composable plugins that board members can arrange to their workflow — and every future feature drops in as a plugin instead of restructuring a monolith.

### Constraints

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
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Existing Stack (Verified from board/package.json)
| Technology | Current Version | Notes |
|------------|----------------|-------|
| Next.js | ^15.2.0 | App Router |
| React | ^19.0.0 | Already React 19, not 18 |
| react-dom | ^19.0.0 | |
| TypeScript | ^5.7.0 | |
| next-auth | ^4.24.11 | v4, NOT v5 — see notes |
| Tailwind CSS | ^3.4.17 | v3, not v4 |
| ioredis | ^5.10.0 | Redis pub/sub already wired |
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
## Installation
# From board/ directory
# CSS — react-grid-layout requires its own stylesheet
# Add to your root layout or global CSS:
# import 'react-grid-layout/css/styles.css';
# import 'react-resizable/css/styles.css';
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
## Version Compatibility
| Library | React 18 | React 19 | Next.js 15 App Router | Notes |
|---------|----------|----------|----------------------|-------|
| react-grid-layout ^2.2.3 | Yes | Yes (peer dep `>= 16.3.0`, no upper bound) | Requires `'use client'` + `ssr: false` dynamic import for grid shell | MEDIUM confidence on React 19 runtime — v2 is from Dec 2025, limited production reports at React 19 specifically. Use `useContainerWidth` with `mounted` guard. |
| cmdk ^1.1.1 | Yes | Explicit: `^18 \|\| ^19` | Requires `'use client'` | HIGH confidence. v1.1.0 replaced shim with React built-in. React 19 type conflict fixed in v1.0.4. |
| recharts ^3.8.1 | Yes | Yes (v2.15+ adds React 19 peer dep) | Requires `'use client'` | HIGH confidence. Widely used pattern in Next.js 15 ecosystem. |
| next-auth ^4.24.11 | Yes | Yes (installed) | Supported via `/api/auth/[...nextauth]` route handler | Already working in production. |
| @xyflow/react ^12.10.1 | Yes | Yes (installed) | Requires `'use client'` | Already working in production. |
### The SSR/Client Boundary Pattern
### Railway SSE Constraints
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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

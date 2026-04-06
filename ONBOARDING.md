# Contributor Onboarding

Welcome to Optimus. This document gets new contributors oriented — what the project is, where things live, and how to start contributing.

## What Is Optimus

Optimus is a governed agent organization where a human board (Eric, Dustin) oversees AI agents that perform operational tasks. The first running instance is **AutoBot-Inbox**: it manages Eric's work inbox using six Claude-powered agents coordinated through a Postgres task graph.

Six design principles govern all decisions:

| # | Principle | Meaning |
|---|-----------|---------|
| P1 | Deny by default | No agent has any capability unless explicitly granted |
| P2 | Infrastructure enforces; prompts advise | Rules enforced by DB constraints, not prompt instructions |
| P3 | Transparency by structure | Every state transition logged automatically |
| P4 | Boring infrastructure | Postgres, SQL, hash chains, JWT — nothing exotic |
| P5 | Measure before you trust | Capability gates, not calendar gates |
| P6 | Familiar interfaces for humans | System adapts to humans, not vice versa |

For the full architecture specification, see [`autobot-spec/SPEC.md`](autobot-spec/SPEC.md).

## Current State

| Phase | What | Status |
|-------|------|--------|
| **1** | Eric's inbox pipeline (6 agents, constitutional gates, voice system) | In progress |
| **1.5** | Dustin's LinkedIn content automation (3 new agents, LinkedIn posting) | Planned — issues [#22](https://github.com/staqsIO/optimus/issues/22)-[#27](https://github.com/staqsIO/optimus/issues/27) |
| **2** | Repeatable install process (docs + setup script) | Not started |
| **3+** | Goal-directed work items, outbound pipeline, strategic autonomy | Future |

## Contributors

| Person | Role | Focus |
|--------|------|-------|
| **Eric** | Co-founder | Infrastructure, implementation, data governance |
| **Dustin** | Co-founder | Governance design, constitutional architecture, LinkedIn content |
| **Steve** | Engineer | Implementation (joining) |
| **Alex** | Engineer | Implementation (joining) |
| **Mike** | Biz dev / Finance | Business operations, capitalization, non-technical |

## Browsing Documentation

All project docs are browsable locally via the docs site:

```bash
cd docs-site && npm install && npm run dev
```

This starts a Next.js site that renders all docs from across the monorepo.

## Repository Structure

This is a monorepo with two sub-projects:

```
ONBOARDING.md          ← You are here
CLAUDE.md              ← AI agent instructions (also a good architecture overview)
autobot-inbox/         ← Production implementation (JavaScript/Node.js)
autobot-spec/          ← Architecture specification (Markdown only, no code)
dashboard/             ← Board dashboard (Next.js 15, separate package)
docs-site/             ← Documentation site (Next.js)
```

## Project Board and Issues

All work is tracked on the [Optimus Roadmap](https://github.com/orgs/staqsIO/projects/2) project board on GitHub.

### Issue Labels

| Label | Meaning |
|-------|---------|
| `phase-1` / `phase-1.5` / `phase-2` / `phase-3` | Which phase the work belongs to |
| `blocker` | Blocks forward progress |
| `needs-board-decision` | Requires Eric + Dustin alignment |
| `board-decision` | Requires explicit board approval before merge |
| `spec-gap` | Spec section not yet implemented or inconsistent |
| `adr` | Architecture Decision Record |
| `good first issue` | Good for newcomers |
| `content-automation` | LinkedIn content generation pipeline (Phase 1.5) |
| `security` | Touches auth, JWT, RLS, sanitization, tool integrity, or HALT |

### Decisions Awaiting Board

| # | Issue | What's Needed |
|---|-------|---------------|
| [#32](https://github.com/staqsIO/optimus/issues/32) | Phase 3 budget cap contradiction | Board decision on budget strategy |
| [#41](https://github.com/staqsIO/optimus/issues/41) | Initial capitalization adequacy | $10-15K may only cover 2.5-4 months |

---

## For Non-Technical Contributors (Mike)

You don't need to write code to contribute. Here's what matters for you:

### Reading the Project

- **[`autobot-spec/SPEC.md`](autobot-spec/SPEC.md)** — the canonical architecture specification. Start here to understand what we're building.
- **[`autobot-inbox/docs/external/product-overview.md`](autobot-inbox/docs/external/product-overview.md)** — what the product does operationally.
- **[`autobot-inbox/docs/external/changelog.md`](autobot-inbox/docs/external/changelog.md)** — what has shipped and when.
- **Board decisions** — issues [#32](https://github.com/staqsIO/optimus/issues/32) and [#41](https://github.com/staqsIO/optimus/issues/41) above need business input.

### Participating via GitHub

You can comment on any issue or PR directly on GitHub — no local setup required. Browse the repo at [github.com/staqsIO/optimus](https://github.com/staqsIO/optimus).

If you want to propose text changes (e.g., to spec documents), GitHub's web editor works: click any `.md` file, click the pencil icon, make your edit, and submit a pull request — all in the browser.

### What to Focus On

- Review board decisions that need input ([#32](https://github.com/staqsIO/optimus/issues/32), [#41](https://github.com/staqsIO/optimus/issues/41))
- Read the product overview and changelog to understand current capabilities
- Comment on issues where business context or finance perspective is needed (look for `cost-model` and `needs-board-decision` labels)

---

## For Engineers (Steve, Alex)

### Dev Environment Setup

Follow the full setup guide: [`autobot-inbox/docs/external/getting-started.md`](autobot-inbox/docs/external/getting-started.md)

Quick summary of what you'll need: Node.js 20+, Docker (for local Postgres), Gmail OAuth credentials, Anthropic API key.

### Key Commands

```bash
# In autobot-inbox/
npm start              # Start agent runtime (poll loop)
npm run dev            # Watch mode with auto-restart
npm run cli            # Interactive CLI
npm run demo           # Demo mode with synthetic emails (no Gmail needed)
npm test               # Unit tests
npm run test:integration  # Integration tests
npm run migrate        # Run SQL migrations (sql/000-027)

# Dashboard (separate package)
cd dashboard && npm run dev   # Next.js dev server on port 3100
```

### Architecture Quick-Map

**Six agents** run in sequence on each inbound email, coordinated via a Postgres task DAG:

1. **Orchestrator** (Sonnet) — polls Gmail, creates work items
2. **Strategist** (Opus) — scores priority, recommends strategy
3. **Executor-Triage** (Haiku) — classifies: action_required, needs_response, fyi, noise
4. **Executor-Responder** (Haiku) — drafts replies using voice profile
5. **Reviewer** (Sonnet) — enforces constitutional gates G1-G7
6. **Architect** (Sonnet) — daily pipeline analysis and optimization

**Five database schemas** (Supabase/PGlite, no cross-schema FKs): `agent_graph`, `inbox`, `voice`, `signal`, `content`.

**Adapter pattern**: Channel I/O abstracted via `InputAdapter`/`OutputAdapter` interfaces in `src/adapters/`. Adding a new channel means implementing these interfaces.

**Config-driven agents**: Agent selection is driven by `config/agents.json`, not hardcoded imports. Adding a new agent means adding a config entry and a handler in `src/agents/`.

### Files to Read First

| File | Why |
|------|-----|
| `src/runtime/agent-loop.js` | Core claim-execute-transition loop — the heartbeat of the system |
| `src/runtime/state-machine.js` | Task graph state transitions |
| `src/runtime/guard-check.js` | Constitutional gates G1-G7 enforcement |
| `config/agents.json` | Agent configuration (models, roles, routing) |
| `src/adapters/` | Channel abstraction layer |
| `sql/` | Migrations 000-027, the DDL source of truth |

### Git Workflow

- Branch from `main`, PR back into `main`
- Atomic commits — one logical change per commit
- No force-push to `main`
- PRs get reviewed before merge

### How to Add a New Agent

1. Add an entry to `config/agents.json` with model, role, and routing config
2. Create a handler in `src/agents/` (follow the pattern of existing agents)
3. Add a migration if the agent needs new DB tables
4. The generic `AgentLoop` (claim-execute-transition) handles the rest

### How to Add a New Channel

1. Implement `InputAdapter` and `OutputAdapter` interfaces in `src/adapters/`
2. Register the adapter in `src/adapters/registry.js`
3. See existing adapters (email, slack) for the pattern

### Spec vs. Implementation

- **`autobot-spec/SPEC.md`** is the architecture specification — what the system *should* do
- **`autobot-inbox/`** is the implementation — what the system *actually* does
- When implementation diverges from spec, either update the spec (if the divergence is intentional) or fix the code
- Spec changes require both collaborators' review
- For spec collaboration workflow details, see [`autobot-spec/ONBOARDING.md`](autobot-spec/ONBOARDING.md)

### Finding Your First Issue

Look for issues labeled [`good first issue`](https://github.com/staqsIO/optimus/labels/good%20first%20issue) or browse the [project board](https://github.com/orgs/staqsIO/projects/2). Phase 1 issues are the current priority.

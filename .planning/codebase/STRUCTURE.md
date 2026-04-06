# Codebase Structure

**Analysis Date:** 2026-04-01

## Directory Layout

```
optimus-clone/
├── .planning/               # GSD agent output (auto-generated planning docs)
├── .github/                 # GitHub workflows (CI, labeling)
├── agents/                  # Agent prompts and definitions (config-as-code)
│   ├── architect/
│   ├── orchestrator-eng/
│   ├── strategist/          # Strategist prompts with examples
│   └── [15 agent dirs]/
├── autobot-inbox/           # Primary product: AI inbox management (Node.js)
│   ├── src/                 # Application source code
│   ├── dashboard/           # Next.js 15 inbox dashboard (port 3100)
│   ├── sql/                 # Database DDL (001-baseline.sql squashed)
│   ├── config/              # JSON configs (agents.json, routing, gates, rules)
│   ├── docs/                # Internal (ADRs, runbooks) and external docs
│   ├── test/                # Unit + integration tests
│   ├── fixtures/            # Test fixtures (demo emails, etc.)
│   └── tools/               # MCP-compatible tool definitions
├── autobot-spec/            # Specification workspace (Markdown only)
│   ├── SPEC.md              # Canonical architecture specification (read-only)
│   ├── conversation/        # Immutable historical decision records
│   ├── decisions/           # ADRs for spec-level architecture
│   └── agents/              # Agent role definitions
├── dashboard/               # Board Workstation (Next.js 15, port 3200)
│   ├── src/app/             # Next.js App Router pages
│   ├── src/lib/             # Utility functions
│   └── docs/                # Workstation docs
├── docs-site/               # Public documentation site (Markdown)
├── products/                # Future product codebases (placeholder)
├── tools/                   # Shared utilities and scripts
├── CLAUDE.md                # Repo-wide guidance for Claude Code
├── SPEC.md                  # [When present] Main spec document
├── compose.yml              # Docker Compose dev stack
├── package.json             # Monorepo root package
└── .env.example             # Environment template
```

## Directory Purposes

**autobot-inbox/src/**
- Purpose: Core agent runtime and business logic
- Contains: Agent handlers, API routes, adapters, infrastructure modules
- Key files: `index.js` (entry point), `db.js` (database layer), `api.js` (REST server)

**autobot-inbox/src/runtime/**
- Purpose: Coordination infrastructure (event loop, task graph, guardrails)
- Contains: agent-loop.js, state-machine.js, guard-check.js, event-bus.js, context-loader.js
- Key files: `infrastructure.js` (audit), `phase-manager.js`, `autonomy-controller.js`

**autobot-inbox/src/agents/**
- Purpose: Agent implementations (orchestrator, strategist, reviewers, executors)
- Contains: 10+ agent handler files, specialized subdirs (claw-campaigner, research)
- Key files: `orchestrator.js`, `executor-triage.js`, `executor-responder.js`, `reviewer.js`

**autobot-inbox/src/adapters/**
- Purpose: Multi-channel I/O abstraction
- Contains: InputAdapter, OutputAdapter interfaces; email, outlook, slack, telegram, webhook adapters
- Key files: `registry.js` (singleton), `input-adapter.js` (interface), `email-adapter.js`, `slack-adapter.js`

**autobot-inbox/src/api-routes/**
- Purpose: REST endpoint handlers for dashboard/workstation
- Contains: Routes for activity, audit, campaigns, finance, governance, pipeline, etc.
- Key files: `activity.js`, `pipeline.js`, `governance.js`, `public-archive.js`

**autobot-inbox/src/gmail/**
- Purpose: Gmail API integration (polling, auth, sent mail analysis)
- Contains: Gmail client, OAuth, poller, sent-analyzer, contacts sync
- Key files: `poller.js` (60s poll loop), `auth.js`, `sent-analyzer.js`

**autobot-inbox/src/voice/**
- Purpose: Voice profile learning system
- Contains: Profile builder, embeddings (pgvector), edit tracker (append-only)
- Key files: `profile-builder.js`, `embeddings.js`, `edit-tracker.js`

**autobot-inbox/src/signal/**
- Purpose: Signal extraction and briefing generation
- Contains: Signal extractor, priority scorer, relationship graph, contact tracking
- Key files: `extractor.js`, `priority-scorer.js`, `relationship-graph.js`

**autobot-inbox/src/audit/**
- Purpose: Observability and data integrity verification
- Contains: Tier 1/2/3 audits, deterministic checks, AI-powered analysis
- Key files: `tier1-deterministic.js`, `tier2-ai-auditor.js`, `tier3-cross-model.js`

**autobot-inbox/src/graph/**
- Purpose: Knowledge graph and pattern extraction
- Contains: Neo4j client, pattern extractor, spec graph queries, sync utilities
- Key files: `pattern-extractor.js`, `client.js`, `spec-queries.js`

**autobot-inbox/src/finance/**
- Purpose: Budget tracking and cost enforcement
- Contains: Financial ledger, cost recording, Phase 1 metrics
- Key files: `financial-script.js` (LLM cost sync)

**autobot-inbox/src/comms/**
- Purpose: Message dispatch to channels
- Contains: Sender (dispatcher), response buffering, scheduled sending
- Key files: `sender.js` (approveViaDispatcher, sendViaDispatcher)

**autobot-inbox/sql/**
- Purpose: Database schema (DDL source of truth)
- Contains: Single squashed migration with all schemas, tables, indexes, functions
- Key files: `001-baseline.sql` (squashed from migrations 001-012)

**autobot-inbox/config/**
- Purpose: JSON-based configuration (source of truth for deployments)
- Contains: agents.json (agent registry), gates.json, routing.json, email-rules.json, webhook-sources.json
- Key files: `agents.json` (master agent list with models, system prompts, capabilities)

**autobot-inbox/dashboard/**
- Purpose: Inbox management dashboard (Next.js 15)
- Contains: Pages (drafts, metrics, settings, audit), API routes (proxy to main API)
- Key files: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/drafts/page.tsx`

**autobot-inbox/docs/internal/**
- Purpose: Engineering documentation (ADRs, runbooks, architecture)
- Contains: Numbered ADRs (001-NNN), system architecture, database schema, agent pipeline, constitutional gates
- Key files: `adrs/README.md` (ADR template), `system-architecture.md`, `database-architecture.md`

**autobot-inbox/docs/external/**
- Purpose: Product documentation (changelog, user guides, public product overview)
- Contains: Changelog (Keep a Changelog format), CLI guide, dashboard guide, product overview
- Key files: `changelog.md`, `product-overview.md`

**autobot-spec/**
- Purpose: Specification workspace (design, not implementation)
- Contains: SPEC.md (canonical), immutable conversation history, design decisions, agent role specs
- Key files: `SPEC.md` (read-only), `conversation/` (immutable records)

**dashboard/**
- Purpose: Board Workstation (port 3200)
- Contains: Next.js 15 App Router, strategic operations UI, system control pages
- Key files: `src/app/workstation/page.tsx`, `src/app/activity/page.tsx`, API routes in `src/app/api/`

**agents/**
- Purpose: Agent prompts and definitions (config-as-code)
- Contains: Directories for each agent tier/role with prompt markdown and JSON configs
- Key files: Agent-specific directories (architect, strategist, orchestrator-eng, etc.)

**tools/**
- Purpose: Shared utilities and helper scripts
- Contains: MCP tool definitions, shared libraries, scripts for migrations/seed
- Key files: Varies per tool

## Key File Locations

**Entry Points:**
- `autobot-inbox/src/index.js`: Main agent runtime startup (npm start)
- `autobot-inbox/src/api.js`: REST API server initialization
- `autobot-inbox/dashboard/src/app/layout.tsx`: Inbox dashboard entry
- `dashboard/src/app/layout.tsx`: Board workstation entry
- `autobot-inbox/src/cli/commands/`: CLI commands (approve, briefing, inbox, stats)

**Configuration:**
- `autobot-inbox/config/agents.json`: Master agent registry + model configs
- `autobot-inbox/config/gates.json`: Constitutional gate thresholds (G1-G7)
- `autobot-inbox/config/routing.json`: Message routing rules by account/channel
- `autobot-inbox/config/email-rules.json`: Email filtering and triage rules
- `autobot-inbox/.env.example`: Environment variable template

**Core Logic:**
- `autobot-inbox/src/runtime/agent-loop.js`: Raw event loop (spec §4)
- `autobot-inbox/src/runtime/state-machine.js`: State transitions + hash chaining
- `autobot-inbox/src/runtime/guard-check.js`: Constitutional gate enforcement (G1-G7)
- `autobot-inbox/src/runtime/context-loader.js`: Tiered context assembly
- `autobot-inbox/src/db.js`: Database abstraction (pg + PGlite)

**Testing:**
- `autobot-inbox/test/unit/`: Unit tests for modules
- `autobot-inbox/test/integration/`: Integration tests with real DB
- `autobot-inbox/fixtures/`: Demo emails, contact data, test payloads

## Naming Conventions

**Files:**
- Executables (agents, API routes): kebab-case (executor-triage.js, public-archive.js)
- Modules/utilities: kebab-case (context-loader.js, priority-scorer.js)
- Classes/exports: camelCase exported, PascalCase for constructors (AgentLoop, InputAdapter)
- Tests: `.test.js` or `.spec.js` suffix

**Directories:**
- Feature areas: kebab-case (claw-campaigner/, executor-research/)
- Layer/domain: descriptive singular (agents, adapters, voice, signal, graph)

**Database:**
- Schemas: lowercase_with_underscore (agent_graph, inbox, voice, signal, content)
- Tables: lowercase_with_underscore (work_items, state_transitions, action_proposals)
- Columns: lowercase_with_underscore (created_at, from_address, config_hash)

**Variables/Functions:**
- Functions: camelCase (handleTask, transitionState, claimWorkItem)
- Constants: UPPER_CASE (VALID_SIGNAL_TYPES, CACHE_TTL_MS, PROCESS_ROLE)
- Classes: PascalCase (AgentLoop, InputAdapter, Reaper)

## Where to Add New Code

**New Agent:**
1. Create handler file in `autobot-inbox/src/agents/executor-[name].js`
2. Import AgentLoop from runtime, export `[name]Loop` function
3. Register in `autobot-inbox/config/agents.json` with model, system_prompt, tools_allowed
4. Import loop in `autobot-inbox/src/index.js`, add to agentRegistry
5. Add agent-specific tests in `autobot-inbox/test/unit/agents/`

**New API Endpoint:**
1. Create route handler file in `autobot-inbox/src/api-routes/[feature].js`
2. Export `register[Feature]Routes(server)` function
3. Import and call in `autobot-inbox/src/api.js` alongside other route registrations
4. Test via curl or dashboard

**New Channel Adapter:**
1. Create file in `autobot-inbox/src/adapters/[platform]-adapter.js`
2. Implement InputAdapter interface (getMessageBody, getThreadHistory, etc.)
3. Optionally implement OutputAdapter (send)
4. Call `registerAdapter('[platform]', adapter)` in `autobot-inbox/src/index.js`
5. Reference provider name in message routing config

**New Database Schema/Table:**
1. Create numbered migration in `autobot-inbox/sql/` (001-baseline is squashed; add new as 002-feature.sql)
2. Run `npm run migrate` to apply
3. Update schema count in `autobot-inbox/CLAUDE.md`
4. Document in `autobot-inbox/docs/internal/database-architecture.md`

**New Utility Module:**
1. Create in appropriate domain directory (`src/signal/`, `src/voice/`, `src/graph/`, etc.)
2. Export named functions (camelCase)
3. Import in handlers/orchestrator as needed
4. Add unit tests in `autobot-inbox/test/unit/[domain]/`

**New Page (Dashboard):**
1. Create file in `dashboard/src/app/[route]/page.tsx`
2. Optionally add API route in `dashboard/src/app/api/[endpoint]/route.ts`
3. Import UI components from `src/components/`
4. Connect to backend via fetch to main API (3001) or internal API routes

**New Agent Prompt/Definition:**
1. Create directory in `agents/[tier]-[role]/` (e.g., agents/executor-marketing/)
2. Add `[role].md` (prompt markdown)
3. Add JSON config if needed
4. Reference in `agents/AGENTS.md` index

## Special Directories

**autobot-inbox/data/pglite/**
- Purpose: PGlite in-process database directory (demo mode only)
- Generated: Yes (automatically created by PGlite on first run)
- Committed: No (git-ignored for development)

**autobot-inbox/.next/, dashboard/.next/**
- Purpose: Next.js build output
- Generated: Yes (npm run build)
- Committed: No (git-ignored)

**autobot-inbox/node_modules/, dashboard/node_modules/**
- Purpose: npm dependencies
- Generated: Yes (npm install)
- Committed: No (git-ignored, use npm ci in CI)

**.planning/codebase/**
- Purpose: GSD agent-generated planning documents (ARCHITECTURE.md, STRUCTURE.md, TESTING.md, etc.)
- Generated: Yes (via /gsd:map-codebase)
- Committed: Yes (stored for future phase planning)

---

*Structure analysis: 2026-04-01*

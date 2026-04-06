# Architecture

**Analysis Date:** 2026-04-01

## Pattern Overview

**Overall:** Event-driven agent coordination with task graph DAG, constitutional guardrail enforcement, and multi-channel adapter abstraction.

**Key Characteristics:**
- No framework — raw event loop with Postgres as coordination backbone
- Task graph stored in `agent_graph` schema (work items, edges, state transitions)
- Guardrail checks executed atomically with state transitions (P2 infrastructure enforcement)
- Multi-channel I/O abstracted via adapter registry (Gmail, Outlook, Slack, Telegram, webhooks)
- Content fetching centralized in context-loader to prevent provider leakage
- Voice profiles derived from sent mail corpus with pgvector embeddings

## Layers

**Coordination Layer:**
- Purpose: Route work items through agent pipeline, maintain task DAG, enforce state machine
- Location: `autobot-inbox/src/runtime/agent-loop.js`, `autobot-inbox/src/runtime/state-machine.js`
- Contains: Agent event loops, work item claiming, state transitions, hash-chained audit
- Depends on: Postgres task graph schema (`agent_graph.*`), event bus
- Used by: All agent handlers

**Agent Layer:**
- Purpose: Business logic execution — triage, response drafting, review, ticket creation
- Location: `autobot-inbox/src/agents/` (orchestrator, strategist, executor-triage, executor-responder, reviewer, architect, executor-ticket, executor-coder, executor-research, executor-redesign, executor-blueprint)
- Contains: Individual agent loop functions, handler implementations
- Depends on: Coordination layer (AgentLoop), context-loader, database, specialized modules (voice, signal, finance, etc.)
- Used by: index.js startup sequence

**Infrastructure/Guardrail Layer:**
- Purpose: Enforce constitutional gates, track state transitions, manage escalation
- Location: `autobot-inbox/src/runtime/guard-check.js`, `autobot-inbox/src/runtime/constitutional-engine.js`, `autobot-inbox/src/runtime/capability-gates.js`
- Contains: Gate enforcement (G1-G7), ledger operations, autonomy controller, dead-man-switch
- Depends on: Work items schema, state transitions schema, finance schema
- Used by: state-machine.js (transitionState), agent handlers for capability queries

**I/O Adapter Layer:**
- Purpose: Abstract channel differences (Gmail, Outlook, Slack, Telegram) from business logic
- Location: `autobot-inbox/src/adapters/` (registry, input-adapter, output-adapter, email-adapter, outlook-adapter, slack-adapter, webhook-adapter, telegram-adapter)
- Contains: Channel-specific fetch/send implementations, adapter registry, InputAdapter/OutputAdapter interfaces
- Depends on: Gmail/Outlook/Slack/Telegram client libraries
- Used by: context-loader (for body fetching), sender (for output), message routing

**Content Retrieval Layer:**
- Purpose: Load agent context (email body, message threads, etc.) without leaking provider specifics to handlers
- Location: `autobot-inbox/src/runtime/context-loader.js`
- Contains: Tiered context assembly (message metadata, emailBody, thread history), provider-agnostic body fetching
- Depends on: Adapter registry (getAdapterForMessage), database queries
- Used by: agent-loop before handler execution

**Knowledge/Signal Layer:**
- Purpose: Extract signals (commitments, deadlines, decisions, etc.), build voice profiles, maintain contact graph
- Location: `autobot-inbox/src/signal/`, `autobot-inbox/src/voice/`, `autobot-inbox/src/graph/`
- Contains: Signal extractor, priority scorer, voice profile builder, pgvector embeddings, pattern extractor (Neo4j sync)
- Depends on: Inbox schema, voice schema, content schema, external graph database
- Used by: Executor-Triage, Executor-Responder, strategic decision agents

**API/Dashboard Layer:**
- Purpose: Expose work queues, drafts, audit logs, system controls to board workstation and inbox dashboard
- Location: `autobot-inbox/src/api.js`, `autobot-inbox/src/api-routes/`, `dashboard/src/app/`
- Contains: REST endpoints (activity, audit, campaigns, finance, governance, pipeline), Next.js 15 dashboard pages, caching layer
- Depends on: Agent graph schema, inbox schema, voice schema, signal schema
- Used by: Board workstation (port 3200), Inbox dashboard (port 3100), external dashboards

**Audit/Observability Layer:**
- Purpose: Log all state transitions, compute metrics, verify data integrity
- Location: `autobot-inbox/src/audit/`, `autobot-inbox/src/runtime/infrastructure.js`, `autobot-inbox/src/runtime/merkle-publisher.js`
- Contains: Tier 1/2/3 audits, activity step logging, event publishing, merkle proof generation, spec drift detection
- Depends on: State transitions schema, infrastructure logs, public archive
- Used by: Agent loop (health checks), API (public archive endpoint)

## Data Flow

**Ingestion:**

1. External input arrives via Gmail poller (`src/gmail/poller.js` every 60s), webhooks, or Slack listener
2. Orchestrator claims incoming task, loads context via context-loader (fetches body from provider via adapter)
3. Orchestrator creates work_item (task/subtask), edges (depends_on), transitions to `assigned`
4. Event published to event bus — wakes waiting agents

**Processing Pipeline:**

1. Executor-Triage claims triage task → extracts signals + categorizes (action_required, needs_response, fyi, noise)
2. Executor-Responder claims response task → loads voice profile, generates draft using few-shot examples
3. Reviewer claims review task → guardrail checks (G2 legal/commitment, G3 tone match ≥ 0.80, G7 precedent)
4. If review passes → draft moved to `agent_graph.action_proposals` (formerly inbox.drafts)
5. Board approves via dashboard → sender transitions to `completed`, draft queued via Comms dispatcher
6. If approval needed → work_item sent to human for decision via dashboard

**Output:**

1. Approved draft transitioned to `completed` via sendDraft API route
2. Comms dispatcher (sender.js) looks up account auth, fetches provider adapter
3. Adapter sends via Gmail API, Outlook API, Slack API, or webhooks depending on channel
4. Edit deltas recorded via voice.edit_tracker (append-only) for voice profile updates
5. State transition logged with hash chain, cost, and guardrail checks

**State Management:**

- Work item status: `created → assigned → in_progress → review → completed` (or failed/blocked/cancelled)
- All transitions stored in append-only `agent_graph.state_transitions` with hash chain
- Each transition atomic with guardrail check (spec §5) via `transitionState()` + `guardCheck()` in single DB transaction
- Agent context (RLS row-level security) enforced via `withAgentScope()` for sensitive queries

## Key Abstractions

**Work Item:**
- Purpose: Represents a unit of work in the task DAG
- Examples: `autobot-inbox/src/runtime/state-machine.js` (transitionState), agents create via `query(INSERT INTO agent_graph.work_items)`
- Pattern: Immutable metadata + mutable status field, constraints enforce valid state transitions

**Adapter:**
- Purpose: Encapsulate channel-specific I/O (Gmail, Outlook, Slack)
- Examples: `autobot-inbox/src/adapters/email-adapter.js`, `autobot-inbox/src/adapters/slack-adapter.js`
- Pattern: InputAdapter interface (getMessageBody, getThreadHistory) + OutputAdapter interface (send), registered in singleton registry

**Agent:**
- Purpose: Autonomous worker executing handler on claimed work items
- Examples: `autobot-inbox/src/agents/executor-triage.js`, `autobot-inbox/src/agents/reviewer.js`
- Pattern: `AgentLoop` wraps handler function, runs continuous event loop, manages state machine, handles RLS

**Context:**
- Purpose: Enriched data passed to agent handler
- Examples: `autobot-inbox/src/runtime/context-loader.js` assembles { email, emailBody, thread, senderContact, signals }
- Pattern: Tiered loading — always has metadata, emailBody fetched on-demand, thread history lazy-loaded

**Action Proposal:**
- Purpose: Unified draft/command across channels (email draft, Slack message, webhook command)
- Examples: `autobot-inbox/src/agents/executor-responder.js` creates, reviewer gates, sender dispatches
- Pattern: Stored in `agent_graph.action_proposals`, aliased as `inbox.drafts` view for backward compat

## Entry Points

**Runtime Loop (Port 3001):**
- Location: `autobot-inbox/src/index.js`
- Triggers: npm start (manual), docker compose up (deployment)
- Responsibilities: Initialize DB, register adapters, start all agent loops, start Gmail polling, start API server, subscribe to pg_notify events

**API Server (Port 3001, REST):**
- Location: `autobot-inbox/src/api.js` + route handlers in `autobot-inbox/src/api-routes/`
- Triggers: HTTP requests from dashboard/workstation
- Responsibilities: Serve work queues, handle approvals, manage drafts, log intents, provide audit trails, public archive

**Dashboard (Port 3100, Next.js):**
- Location: `dashboard/src/app/`
- Triggers: User navigation in browser
- Responsibilities: Display pipeline state, approve/reject drafts, manage settings, view metrics

**Board Workstation (Port 3200, Next.js):**
- Location: `autobot-inbox/dashboard/src/app/` (legacy, being migrated to top-level dashboard)
- Triggers: Board member access
- Responsibilities: Strategic operations, system halt/resume, advanced governance

**CLI (Interactive REPL):**
- Location: `autobot-inbox/src/cli/`, spawned by `npm run cli`
- Triggers: Manual user interaction
- Responsibilities: Approve/reject via readline, view inbox, check stats

## Error Handling

**Strategy:** Fail-closed with escalation. Failed work items retry up to 3 times, then escalate to human review.

**Patterns:**

- Agent loop catches all exceptions in tick(), sleeps 5s, continues (graceful degradation)
- Guard checks fail → transition blocked, work_item blocked status, admin notified
- LLM timeouts → configured per agent model, caught in handler, retried
- Database connection errors → connection pooling with backoff, PGlite fallback for demo
- JSON parse errors in context-loader → handler receives null context, returns error reason
- Adapter errors (Gmail auth failure) → caught, logged, work_item stays assigned for retry

## Cross-Cutting Concerns

**Logging:** Structured logging via console (stdout captured by Docker). Critical events emitted to event_log table via `publishEvent()` for immutable audit trail.

**Validation:** Input validation in handlers (signal types, email addresses), database constraints (CHECK clauses on statuses, data_classification), adapter interface validation at registration.

**Authentication:** Gmail/Outlook OAuth cached in `inbox.accounts` with encrypted credentials. JWT scoping via agent context (target: RLS per spec §5). Board identity verified via `ANTHROPIC_API_KEY` (Workstation runs Claude calls server-side).

**Authorization:** Deny-by-default (P1). Agent capabilities defined in `config/agents.json` (can_assign_to list). Constitutional gates enforce budget, voice tone, commitment detection. No prompt-level security (P2).

**Observability:** Tier 1 audit every 60s (lightweight health checks), Tier 2 audit daily (AI-powered), Tier 3 cross-model every 48h (requires Opus). Metrics collected to `autobot_finance.phase1_metrics`. Spec drift detected via `spec-drift-detector.js`.

---

*Architecture analysis: 2026-04-01*

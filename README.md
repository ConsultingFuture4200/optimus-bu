# Optimus

A governed agent organization where AI agents handle operations under human board oversight.

---

## What Is Optimus

Optimus is a fully agent-staffed technology organization. Every operational role — strategy, architecture, orchestration, execution, review, and exploration — is performed by an AI agent. A human board of directors (Eric, Dustin) sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents, coordinated through a Postgres task graph with no framework, no message queue, and no ORM.

The long-term trajectory is **AutoBot**: an autonomous constitutional agent organization where a constitutional layer replaces the human board for operational decisions. AutoBot cannot exist until Optimus has proven that agent governance works under human supervision. The transition is graduated and metric-gated — no capability is activated based on a calendar date.

Optimus builds and operates software products. The first running product is **autobot-inbox** — an AI-powered inbox management system. The distinction matters: Optimus is the organization; products are what it builds.

## Architecture

```
+---------------------------------------------------------------+
|                      HUMAN BOARD                               |
|  Strategy, Ethics, Budget, Legal, Oversight                    |
|  Interfaces: Dashboard, CLI, Slack, Email (P6)                 |
+----------------------------+----------------------------------+
                             |
+----------------------------v----------------------------------+
|                  ORCHESTRATION LAYER (lib/)                    |
|  Postgres task graph — single source of truth                  |
|                                                                |
|  guardCheck()          — constitutional gate enforcement        |
|  transition_state()    — atomic state + audit + event           |
|  claim_next_task()     — work dispatch (SKIP LOCKED)           |
|  Adapter registry      — channel-agnostic I/O                  |
|  Communication Gateway — inbound sanitize, outbound release    |
|  RAG pipeline          — knowledge base (863 docs, 6.6K chunks)|
+---------------------------------------------------------------+
           |              |              |              |
           v              v              v              v
    +-----------+  +------------+  +----------+  +-----------+
    | Strategist|  |Orchestrator|  | Executor |  |  Reviewer |
    | (Gemini   |  | (DeepSeek) |  | (Haiku/  |  |  (Sonnet) |
    |  2.5 Pro) |  |            |  |  Sonnet) |  |           |
    +-----------+  +-----+------+  +----------+  +-----------+
                         |
              +----------+----------+
              |          |          |
         +--------+ +--------+ +--------+
         |Workshop| |Campaign| |Explorer|
         |(Sonnet)| |(Sonnet)| |(Sonnet)|
         +--------+ +--------+ +--------+

+---------------------------------------------------------------+
|                   PUBLIC TRANSPARENCY LAYER                    |
|  Every state transition -> structured event -> public archive  |
|  Append-only, hash-chained audit log                          |
+---------------------------------------------------------------+
```

### Agent Tiers

Agents are organized in a strict hierarchy. Capabilities are enforced by infrastructure (P2), not prompts.

| Tier | Agents | Model | Role |
|------|--------|-------|------|
| Strategist | strategist | Gemini 2.5 Pro | Priority scoring, strategy recommendations (suggest mode) |
| Architect | architect, claw-explorer | Gemini 2.5 Pro / Sonnet | Daily analysis, autonomous codebase exploration |
| Orchestrator | orchestrator, claw-workshop, claw-campaigner | DeepSeek / Sonnet | Pipeline coordination, Linear-driven implementation, campaigns |
| Reviewer | reviewer | Sonnet | Gate checks: tone, commitments, precedent, scope |
| Executor | intake, triage, responder, ticket, coder, blueprint, redesign, research | Haiku / Sonnet | Classification, drafting, ticketing, code generation, research |
| Utility | board-query | DeepSeek | Board question answering |
| External | nemoclaw-ecgang, nemoclaw-ConsultingFuture4200 | Gemini 2.5 Pro | Board member agent instances (API-only interaction) |

### Constitutional Gates

Eight gates enforced at the database layer — not by prompts:

| Gate | What It Checks |
|------|----------------|
| G1 Financial | Daily LLM spend ceiling ($20 default) |
| G2 Legal | Commitment and contract language in drafts |
| G3 Reputational | Voice tone match >= 0.80 (pgvector cosine similarity) |
| G4 Autonomy | Approval requirements per autonomy level (L0/L1/L2) |
| G5 Reversibility | Draft-only constraint; flags reply-all |
| G6 Stakeholder | Per-recipient-per-day rate limit |
| G7 Precedent | Pricing, timeline, and policy commitment detection |
| G8 Injection | Model Armor prompt injection screening |

### Graduated Autonomy

| Level | Behavior | Exit Criteria |
|-------|----------|---------------|
| L0 | All drafts require human approval | 50+ drafts reviewed, <10% edit rate, 14 days |
| L1 | Auto-archive noise, auto-label FYI, auto-send routine | 90 days, <5% error |
| L2 | Full autonomy except G2-flagged | Ongoing monitoring |

## Design Principles

| # | Principle | Meaning |
|---|-----------|---------|
| P1 | Deny by default | No capability unless explicitly granted |
| P2 | Infrastructure enforces; prompts advise | DB constraints, not system prompts |
| P3 | Transparency by structure | Logging is automatic, not optional |
| P4 | Boring infrastructure | Postgres, SQL, JWT, hash chains |
| P5 | Measure before you trust | Data proves readiness, not calendar dates |
| P6 | Familiar interfaces for humans | System adapts to humans, not vice versa |

## Repository Structure

```
optimus/
  SPEC.md                    Canonical architecture specification (v1.1.0)
  CONSTITUTION.md            Prescriptive governance constraints (audit reference)
  lib/                       Org-level infrastructure
    runtime/                 Agent loop, state machine, guard checks, event bus
    adapters/                Channel-agnostic I/O (email, Slack, Telegram, webhook)
    graph/                   Task graph operations (Neo4j knowledge graph)
    comms/                   Communication Gateway (outbound release tiers)
    rag/                     RAG pipeline (chunker, embedder, retriever)
    audit/                   3-tier audit system (deterministic, AI, cross-model)
    llm/                     LLM provider abstraction
    db.js                    Database connection (Postgres/PGlite)
  agents/                    Org-level agents (channel-agnostic, reusable)
    executor-intake.js       Message classification
    executor-coder.js        Code generation → PRs
    executor-ticket.js       Linear + GitHub issue creation
    reviewer.js              Gate checks, quality assurance
    architect.js             Daily analysis, briefings
    claw-workshop/           Linear-issue-driven implementation
    claw-campaigner/         Multi-step campaign execution
    ...                      + blueprint, redesign, research
  autobot-inbox/             Product: AI inbox management
    src/agents/              Inbox-specific agents (orchestrator, triage, responder, strategist)
    src/gmail/               Gmail API integration
    src/voice/               Voice learning system (pgvector embeddings)
    src/signal/              Signal extraction + briefings
    config/                  Agent configs, routing rules, gate definitions
    sql/                     DDL migrations (source of truth)
  spec/                      Architecture specification workspace
    SPEC.md                  Single source of truth (v1.1.0)
    conversation/            Immutable design decision records
    decisions/               Architecture Decision Records
  board/                     Board Workstation (port 3200, board.staqs.io)
```

## Products

### autobot-inbox

The first Optimus product. Manages production work inboxes using 18 agents that poll channels, classify messages, score priorities, draft replies in the user's learned voice, and enforce 8 constitutional gates before any draft reaches a human.

Currently operates at autonomy level L0 (partial L1 for noise/FYI). Two Gmail accounts active (eric@staqs.io, jamie@staqs.io). Channels: Email, Slack, Google Drive, Telegram, webhooks.

See `autobot-inbox/CLAUDE.md` for development details.

## Quick Start

```bash
git clone https://github.com/staqsIO/optimus.git
cd optimus

# Install dependencies (root + lib + product)
npm install

# Configure
cp autobot-inbox/.env.example autobot-inbox/.env
# Set ANTHROPIC_API_KEY at minimum

# Run with Docker (recommended)
docker compose up -d

# Or run directly
cd autobot-inbox && npm start
```

**Demo mode** (no Gmail credentials needed):
```bash
cd autobot-inbox && npm run demo
```

**Requirements:** Node >= 20.0.0, npm. ES modules throughout (`"type": "module"`).

| Port | Service |
|------|---------|
| 5432 | Postgres (pgvector) |
| 6379 | Redis |
| 3001 | autobot-inbox API |
| 3100 | Inbox dashboard (legacy) |
| 3200 | Board Workstation (primary) |

## Specification

The full architecture is documented in `spec/SPEC.md` (v1.0.0). It describes:

- Agent tiers with explicit capabilities and constraints (S2)
- Postgres task graph as single coordination source (S3)
- Agent runtime loop with pre/post guardrail checks (S4)
- Constitutional gates G1-G8 with infrastructure enforcement (S5)
- Communication Gateway with risk-tiered release (S7)
- Four-phase activation path from Optimus (governed) to AutoBot (autonomous)
- Strategy Evaluation Protocol for product decisions (S19)
- Legal compliance architecture (S17)

Changes to the spec require both board members' review.

## Status

- **Phase 1**: Pipeline running live. 18 agents deployed. 8 constitutional gates enforced.
- **Spec version**: v1.0.0
- **Database**: Supabase (5 schemas, pgvector, 96 tables)
- **Channels**: Email (Gmail, Outlook), Slack, Telegram, Google Drive, Webhooks
- **Knowledge base**: 863 documents, 6,663 chunks (RAG pipeline)
- **Dashboard**: Next.js 15, 16 pages (board.staqs.io)

## License

UNLICENSED. This is a private repository.

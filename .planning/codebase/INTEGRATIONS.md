# External Integrations

**Analysis Date:** 2026-04-01

## APIs & External Services

**Email Channels:**
- Gmail (Google Workspace) - Primary inbox
  - SDK/Client: `googleapis` v144.0.0
  - Auth: OAuth2 with refresh token (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER_EMAIL`)
  - Implementation: `src/gmail/` directory (poller, client, auth, sender modules)
  - Features: Incremental polling via history ID (60s default), draft creation, label management, thread tracking
  - File: `src/gmail/poller.js` handles multi-account sequential polling with 2s stagger

- Outlook (Microsoft 365) - Secondary email
  - SDK/Client: `@azure/msal-node` v5.0.5
  - Auth: Azure AD OAuth2
  - Implementation: `src/adapters/outlook-adapter.js` bridges to `src/outlook/` modules
  - Features: Draft creation, send via SMTP/Graph API

- Slack - Messaging channel
  - SDK/Client: `@slack/bolt` v4.6.0
  - Auth: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
  - Implementation: `src/slack/client.js` and `src/slack/listener.js`
  - Mode: Socket Mode (MVP) — no public webhook URL required
  - Note: Events API planned for production

- Telegram - Messaging channel
  - SDK/Client: `node-telegram-bot-api` v0.67.0
  - Auth: `TELEGRAM_BOT_TOKEN`
  - Implementation: `src/telegram/client.js`

**AI Provider:**
- Anthropic Claude API
  - SDK: `@anthropic-ai/sdk` v0.39.0, `@anthropic-ai/claude-agent-sdk` v0.2.69
  - Auth: `ANTHROPIC_API_KEY` (mandatory)
  - Agents: Orchestrator (Sonnet), Strategist (Opus), Executors (Haiku), Reviewer (Sonnet), Architect (Sonnet)
  - Daily budget enforcement: `DAILY_BUDGET_USD` (default $20/day, gate G1)

**Issue Tracking:**
- Linear - Issue and ticket management
  - Client: Custom GraphQL fetch wrapper (no SDK, P4 boring infrastructure)
  - Auth: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`
  - Implementation: `src/linear/client.js` thin wrapper around `https://api.linear.app/graphql`
  - Usage: Executor-Ticket agent creates issues from client feedback

- GitHub - Code repository + issue tracking
  - Auth: GitHub App installation token (preferred) or `GITHUB_TOKEN` PAT fallback
  - Implementation: `src/github/pr-creator.js`, `src/github/issues.js`, `src/github/issue-monitor.js`
  - Features: Issue monitoring (webhook), PR creation via Git Trees API (blob→tree→commit→branch→PR), code search
  - Webhook: `src/github/issue-webhook.js` listens for repo events

**Documentation & Knowledge:**
- Google Drive - Document ingestion
  - SDK/Client: `googleapis` v144.0.0
  - Auth: Shares Google Service Account with Gmail integration
  - Implementation: `src/drive/folder-watcher.js` polls watched folders, ingests docs as webhook messages
  - Feature: Automata-driven document processing pipeline

## Data Storage

**Databases:**

**Postgres (pgvector):**
- Primary production database
- Connection: `DATABASE_URL` env var (postgresql://...)
- Client: `pg` v8.19.0 (connection pool, max 25 connections, 2min idle timeout)
- Schemas: 5 isolated (no cross-schema FKs per P2):
  - `agent_graph` - Task DAG, work items, state transitions, action proposals (unified draft storage)
  - `inbox` - Email metadata (never stores body), triage results, signals
  - `voice` - Sent email corpus with pgvector embeddings, profiles, edit deltas (append-only)
  - `signal` - Contacts, topics, briefings
  - `content` - Topic queue, reference posts, content drafts
- Extensions: `pgvector` (embeddings), `pg_trgm` (fuzzy text matching)
- Migrations: `sql/001-baseline.sql` (squashed from 001-012)

**PGlite (In-Process):**
- Fallback when `DATABASE_URL` unset
- Location: `data/pglite/` directory
- Client: `@electric-sql/pglite` v0.2.17
- Use case: Demo mode, local dev without Docker
- Same schema as Postgres, same extensions via JS config

**Neo4j:**
- Graph database for knowledge graph and relationship reasoning
- Connection: `NEO4J_URI` (bolt://neo4j:7687), `NEO4J_USER`, `NEO4J_PASSWORD`
- Client: `neo4j-driver` v5.28.3
- Docker: `neo4j:5-community` image
- Usage: Relationship extraction from emails, contact graph, topic clustering

**Redis:**
- Caching and session store
- Connection: `REDIS_URL` env var
- Client: `ioredis` v5.10.0 (board workstation only, dashboard cache invalidation)
- Docker: `redis:7-alpine` image

**File Storage:**
- S3 (optional) - Cloud storage for documents and content
  - SDK: `@aws-sdk/client-s3` v3.1006.0
  - Use case: Long-term content storage, backup, archive
- Local filesystem (fallback) - For demo/dev
  - Location: `data/` directory
  - Usage: Demo emails, local file uploads (Electron app)

## Authentication & Identity

**OAuth2 Providers:**
- GitHub OAuth (board workstation login)
  - Client: `GITHUB_ID`, `GITHUB_SECRET`
  - Callback: `http://localhost:3200/api/auth/callback/github` (dev), `https://board.yourdomain.com/api/auth/callback/github` (prod)
  - Framework: `next-auth` v4.24.11
  - Board members: Whitelist in `BOARD_MEMBERS` env var

- Google OAuth (Gmail setup)
  - Client: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
  - Callback: Custom setup flow in `src/gmail/auth.js`

- Microsoft/Azure OAuth (Outlook setup)
  - Client: `@azure/msal-node` v5.0.5
  - Implementation: `src/outlook/auth.js`

**Session Management:**
- NextAuth for board workstation (GitHub OAuth)
  - Secret: `NEXTAUTH_SECRET` (64+ chars)
  - Session encryption: AES-256-GCM via `API_KEY_ENCRYPTION_SECRET` (32 hex chars)
  - Stored credentials: Encrypted in Redis, decrypted on request

**Custom JWT/API Auth:**
- API Secret for dashboard-to-autobot-inbox calls
  - Key: `API_SECRET` env var
  - Implementation: HMAC verification in `src/api.js`

## Monitoring & Observability

**Error Tracking:**
- Not configured - Errors logged to console/stdout
- Infrastructure: Logs captured by Docker compose, accessible via `docker compose logs -f`

**Logs:**
- Console logging via `console.log()`, `console.error()`, `console.warn()`
- Structured logging in `src/audit/` modules
- Append-only audit tables: `agent_graph.state_transitions`, `agent_graph.action_proposals`
- Event bus: `src/runtime/event-bus.js` uses `pg_notify` for inter-service communication (P4: boring infrastructure, no external queue)

**Financial Tracking:**
- LLM spend calculation: `src/finance/financial-script.js` (token counting, cost aggregation)
- Gate G1 enforcement: Budget pre-check via `src/runtime/guard-check.js`
- Daily budget cap: `DAILY_BUDGET_USD` (default $20)

**Compliance & Audit:**
- Constitutional gates (G1-G7) enforced via DB constraints and `guard-check.js`
- Tier 2 AI Auditor: `src/audit/tier2-ai-auditor.js` (cross-check accuracy)
- Tier 3 Cross-Model Audit: `src/audit/tier3-cross-model.js` (consistency checks)
- Hash-chained state transitions: Merkle tree verification in `src/runtime/merkle-publisher.js`
- Dead-man switch: `src/runtime/dead-man-switch.js` halts on inactivity

## CI/CD & Deployment

**Hosting:**
- Docker Compose (development) - `compose.yml`
- Docker Compose Production - `compose.prod.yml`
- Railway (configured via `railway.toml`)
- Vercel (planned for dashboard)

**CI Pipeline:**
- GitHub Actions (configured in `.github/workflows/`)
  - `ci.yml` - Tests and build checks
  - `auto-label.yml` - PR labeling
- Tests: `npm test` (unit), `npm run test:integration` (integration)
- No external CI service configured; Docker Compose provides fast local feedback loop

**Deployment:**
- Docker multi-stage builds for autobot-inbox, dashboard, docs-site
- Dockerfiles: `autobot-inbox/Dockerfile.dev`, `dashboard/Dockerfile.dev`, `docs-site/Dockerfile.dev`
- Environment variable injection via `.env` file (development) or systemd/systemctl (production)
- Health checks: Service readiness configured in `compose.yml`

## Webhooks & Callbacks

**Incoming Webhooks:**
- GitHub issue events - `src/github/issue-webhook.js` (issue created, commented, closed)
- Gmail push notifications (deferred, currently polling)
- Slack messages (Socket Mode, no outbound URL)
- Telegram messages (polling, no outbound URL)
- Custom webhook adapter: `src/adapters/webhook-adapter.js` (generic input routing)

**Outgoing Webhooks/Callbacks:**
- Draft approvals: Board via dashboard → API `POST /api/drafts/:id/approve`
- Email send: Orchestrator polls `inbox.drafts` view, triggers responder
- GitHub PR creation: Executor-Coder → Git Trees API (not webhook, REST API)
- Linear issue creation: Executor-Ticket → GraphQL API
- Signal publication: Briefing JSON posted to webhook sources defined in `config/webhook-sources.json`

## Environment Configuration Summary

**Development Minimum** (to start with Docker):
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/autobot
```

**Add Email** (to use Gmail):
```
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_USER_EMAIL=user@gmail.com
```

**Add Board Workstation** (to enable dashboard login):
```
GITHUB_ID=...
GITHUB_SECRET=...
NEXTAUTH_SECRET=<64-char-random>
API_KEY_ENCRYPTION_SECRET=<32-hex-random>
API_SECRET=<random>
BOARD_MEMBERS=ecgang,ConsultingFuture4200
```

**Production Required** (additional):
```
POSTGRES_PASSWORD=<strong-password>
REDIS_PASSWORD=<strong-password>
INBOX_DASHBOARD_URL=https://inbox.yourdomain.com
BOARD_URL=https://board.yourdomain.com
```

---

*Integration audit: 2026-04-01*

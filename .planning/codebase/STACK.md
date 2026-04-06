# Technology Stack

**Analysis Date:** 2026-04-01

## Languages

**Primary:**
- JavaScript/ES6+ (latest) - Agent runtime (`src/`), CLI, API server, core business logic
- TypeScript - Dashboard (`dashboard/`), Next.js frontend, type-safe React components
- SQL - Database schema, migrations, stored procedures (`sql/001-baseline.sql`)

**Secondary:**
- Bash - Setup scripts, installation and initialization (`scripts/*.sh`)

## Runtime

**Environment:**
- Node.js v20.0.0+ (specified in `autobot-inbox/.nvmrc`)

**Package Manager:**
- npm (workspace structure with separate `package.json` per service)
- Lockfile: `package-lock.json` present in `autobot-inbox/` and `dashboard/`

## Frameworks

**Core Runtime:**
- Node.js built-in HTTP server (no Express) - Custom event-loop implementation in `src/index.js`, `src/api.js`
- Postgres + PGlite dual-mode database abstraction (`src/db.js`)

**Frontend:**
- Next.js 15.2.0 - Board workstation dashboard (`dashboard/`)
- React 19.0.0 - UI components and layouts
- TypeScript 5.7.0 - Type safety for frontend code

**Testing:**
- Node.js built-in `test` module - Unit tests (`npm test`, `npm run test:integration`)
- Test configuration: `--experimental-test-module-mocks` flag for ESM mocks

**Build/Dev:**
- Tailwind CSS 3.4.17 - Utility-first styling (dashboard)
- PostCSS 8.5.0 - CSS transformation pipeline
- Autoprefixer 10.4.20 - Cross-browser CSS prefixes

## Key Dependencies

**Critical:**
- `@anthropic-ai/sdk` v0.39.0 - Core AI agent API (both autobot-inbox and dashboard)
- `@anthropic-ai/claude-agent-sdk` v0.2.69 - Agent coordination SDK (autobot-inbox)
- `pg` v8.19.0 - Postgres client with connection pooling (production/Docker)
- `@electric-sql/pglite` v0.2.17 - In-process Postgres WASM (demo/dev fallback)

**Infrastructure:**
- `googleapis` v144.0.0 - Gmail/Google Drive API clients
- `nodemailer` v8.0.1 - Email sending fallback/SMTP
- `@slack/bolt` v4.6.0 - Slack Socket Mode integration
- `node-telegram-bot-api` v0.67.0 - Telegram channel support
- `@azure/msal-node` v5.0.5 - Azure AD/Outlook OAuth2
- `@aws-sdk/client-s3` v3.1006.0 - S3 file storage (optional, for content)
- `neo4j-driver` v5.28.3 - Neo4j graph database for knowledge graph
- `ioredis` v5.10.0 - Redis client (board workstation caching)

**Utilities:**
- `dotenv` v16.4.7 - Environment variable loading
- `chalk` v5.3.0 - Terminal color output (CLI)
- `marked` v15.0.0 - Markdown parsing (dashboard)
- `isomorphic-dompurify` v3.1.0 - XSS sanitization (dashboard)
- `next-auth` v4.24.11 - OAuth/session management (board workstation)
- `@xyflow/react` v12.10.1 - Graph visualization (board workstation)

**Optional/Dev Only:**
- `playwright` v1.52.0 - Browser automation (optional)
- `lighthouse` v12.0.0 - Performance auditing (optional)
- `chrome-launcher` v1.1.0 - Chrome control (optional)
- Electron (separate `autobot-inbox/electron/` package.json for native desktop app)

## Configuration

**Environment:**
- `.env.example` in repo root — defines all required and optional variables
- Configuration files in `autobot-inbox/config/`:
  - `agents.json` - Agent definitions, models, tools, guardrails
  - `gates.json` - Constitutional gate definitions (G1-G7)
  - `email-rules.json` - Email filtering and routing
  - `routing.json` - Message channel routing
  - `webhook-sources.json` - Webhook integrations
  - `github-bot.json` - GitHub App configuration
  - `linear-bot.json` - Linear API configuration
  - `design-system.json` - Tone/voice profile templates

**Build:**
- Next.js config: `dashboard/next.config.ts`, `autobot-inbox/dashboard/next.config.ts`
- Tailwind config: `dashboard/tailwind.config.ts`, `autobot-inbox/dashboard/tailwind.config.ts`
- PostCSS config: `dashboard/postcss.config.mjs`, `autobot-inbox/dashboard/postcss.config.mjs`
- TypeScript config: `dashboard/tsconfig.json`, `autobot-inbox/dashboard/tsconfig.json`

## Platform Requirements

**Development:**
- Node.js >= 20.0.0
- Docker (recommended for Postgres/Neo4j/Redis via `docker compose up -d`)
- Git (for CLI + PR creation via GitHub API)
- Bash shell (setup scripts require Unix environment, even on Windows use WSL/Git Bash)

**Production:**
- Deployment target: Railway, Vercel, or self-hosted
- Docker containers for services (Postgres pgvector, Neo4j, Redis)
- HTTPS for NextAuth OAuth callbacks
- Environment variables: See `.env.example` — ANTHROPIC_API_KEY is mandatory minimum

## Database

**Development/Demo:**
- Mode 1 (Docker recommended): Real Postgres `pgvector/pgvector:pg17` in Docker, accessed via `DATABASE_URL` env var
- Mode 2 (Local dev): PGlite in-process WASM fallback when `DATABASE_URL` unset (demo-only, data in `data/pglite/`)
- Dual-mode abstraction in `src/db.js` — same API surface either way

**Production:**
- Supabase (target, not yet migrated)
- Five isolated schemas: `agent_graph`, `inbox`, `voice`, `signal`, `content`
- Extensions: `pgvector` (embeddings), `pg_trgm` (fuzzy matching)
- 1 baseline migration `sql/001-baseline.sql` (squashed from 001-012)

## Runtime Environment Variables (Critical)

**API Keys (Development Minimum):**
- `ANTHROPIC_API_KEY` - Required, Anthropic API key

**Optional Channels:**
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER_EMAIL` - Gmail integration
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` - Slack Socket Mode
- `LINEAR_API_KEY`, `LINEAR_TEAM_ID` - Linear issue tracking
- `GITHUB_TOKEN` or GitHub App credentials - GitHub API/PR creation
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` - Outlook/Azure AD

**Board Workstation (Dashboard):**
- `GITHUB_ID`, `GITHUB_SECRET` - GitHub OAuth for board member login
- `NEXTAUTH_SECRET` - NextAuth session encryption (64+ chars)
- `API_KEY_ENCRYPTION_SECRET` - AES-256-GCM key for storing API keys (32 hex chars)
- `API_SECRET` - HMAC for dashboard-to-API auth
- `BOARD_MEMBERS` - Comma-separated GitHub usernames allowed to log in

**Operational:**
- `DATABASE_URL` - Postgres connection string (postgres://...)
- `REDIS_URL` - Redis connection string (redis://...)
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` - Neo4j graph DB
- `DAILY_BUDGET_USD` - LLM spend ceiling (default 20)
- `AUTONOMY_LEVEL` - Agent autonomy level: 0=all drafts, 1=auto-archive FYI, 2=auto-handle non-G2 (default 0)
- `GMAIL_POLL_INTERVAL` - Polling interval in seconds (default 60)
- `PROCESS_ROLE` - Agent role: 'full', 'api-only', 'cli-only'

---

*Stack analysis: 2026-04-01*

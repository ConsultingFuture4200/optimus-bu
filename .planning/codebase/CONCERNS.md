# Codebase Concerns

**Analysis Date:** 2026-04-01

## Tech Debt

### PGlite Single-Connection Bottleneck

**Issue:** PGlite (in-process Postgres WASM) is single-threaded. Agent loop queries block API dashboard queries, causing timeouts and stale data serving.

**Files:** `autobot-inbox/src/api.js` (lines 49-80), `autobot-inbox/src/db.js` (lines 44-60)

**Impact:** 
- Dashboard pages timeout on first load (5s limit) when agents are processing heavy work
- System serves stale data after timeout to keep UI responsive
- Cannot scale to multiple concurrent agents on same process
- PGlite is demo-only; production (Postgres) doesn't have this issue

**Current Mitigation:**
- In-memory LRU cache with 5-minute TTL
- Stale-while-revalidate pattern (serve stale, refresh background)
- Request timeouts: 5s first-load, 15s background refresh
- Cache key invalidation on state changes

**Fix Approach:**
- Production migration to Supabase (already designed in ADR-004)
- For dev: PGlite acceptable if dashboard queries are < 500ms
- Monitor query latency in `src/api.js` LONG_RUNNING endpoint list
- Consider separate PGlite instance for read-only dashboard if dev-only mode required

---

### Linear Webhook HMAC Fallback Security Gap

**Issue:** Linear OAuth app webhooks fail HMAC signature verification due to Linear-side issue. System falls back to accepting webhooks with just the `linear-delivery` header + `user-agent` check.

**Files:** `autobot-inbox/src/api.js` (lines 957-968)

**Impact:**
- HMAC verification fails for Linear webhooks but system continues
- Relies on header presence + user-agent string (easily spoofed)
- Could allow injection of malicious Linear webhook payloads
- Verified 2026-03-08 that our HMAC code is correct; issue is Linear's signing

**Current Mitigation:**
- Console warning logged when fallback used
- User-agent check for "Linear-Webhook"
- linear-delivery header required (unclear what this header is)

**Fix Approach:**
- Contact Linear support to verify webhook signing secret format
- Implement webhook signature pinning in config (hash the expected signature)
- Add rate limiting per webhook source
- Escalate to board if Linear cannot fix; consider alternative webhook ingestion (polling instead)

**Board Review Required:** Yes — security boundary at webhook acceptance

---

### Completeness Check Removed (LLM-based Governance Theater)

**Issue:** Old "keyword frequency matching" completeness check on agent outputs was removed because it was governance theater (would pass if "email" appeared enough times). Replacement (LLM-based check behind feature flag) not yet implemented.

**Files:** `autobot-inbox/src/runtime/agent-loop.js` (lines 463-465)

**Impact:**
- Agent outputs are not validated for completeness against acceptance criteria
- Executor could return empty results and pass guard-check
- Only structural safety gates (G1-G7) are enforced; no output quality gates
- Affects: executor-triage, executor-responder, executor-coder (any output-producing agent)

**Fix Approach:**
- Implement LLM-based output validation behind `VALIDATE_OUTPUT_COMPLETENESS` feature flag
- Use cheaper model (Haiku) to validate completeness of expensive operations (Sonnet)
- Check against work_item.acceptance_criteria (already in schema)
- Cost: ~$0.0001 per validation (2-3 sentences of analysis)

---

### Deprecated Backwards-Compatibility View

**Issue:** `inbox.drafts` is now a view mapping over `agent_graph.action_proposals` with legacy column name translation. Backwards-compatibility layer must eventually be removed.

**Files:** `autobot-inbox/sql/001-baseline.sql` (CREATE VIEW inbox.drafts), `autobot-inbox/docs/internal/adrs/013-unified-action-proposals.md`

**Impact:**
- Codebase still contains references to both old and new schemas
- Schema migration complexity increases
- Two sources of truth during transition (problematic for audit)
- View adds 1-2ms per draft query due to join/projection

**Fix Approach:**
- Migrate all code to use `agent_graph.action_proposals` directly
- Update references in:
  - `autobot-inbox/dashboard/src/app/drafts/page.tsx` (1285 lines)
  - Any API endpoints that query `inbox.drafts`
- Remove view after code migration complete
- Set deadline: end of Phase 1 (by 2026-04-15)

---

### JWT Implementation Status Incomplete

**Issue:** ADR-018 mandates JWT-scoped agent identity for Phase 1 exit (board decision 2026-03-07). Implementation exists (`src/runtime/agent-jwt.js`) but RLS enforcement not fully active.

**Files:** `autobot-inbox/src/runtime/agent-jwt.js`, `autobot-inbox/src/db.js` (withAgentScope function), `autobot-inbox/sql/001-baseline.sql` (RLS policies defined but not enforced)

**Impact:**
- Agent identity is JWT-signed but RLS policies are schema-level, not enforced
- Agents connect as `autobot_agent` role but per-agent roles (Phase 2) not implemented
- Token revocation list missing — killed agent can still use old token until TTL expiry (15 min)
- Audit trail does not cryptographically bind state transitions to agent identity

**Current Status:**
- JWT issuer: ✓ Complete (`initializeJwtKeys()`)
- JWT signing: ✓ Complete (`issueToken()`)
- JWT verification: ✓ Complete (`verifyToken()`)
- RLS enforcement: ⚠ Partial (policies defined, enforcement optional)
- Per-agent DB roles: ✗ Phase 2 (one shared `autobot_agent` role)
- Token revocation: ✗ Phase 2 (kill switch sufficient for Phase 1)

**Fix Approach:**
- Activate RLS in `withAgentScope()` — require JWT verification before setting app.agent_id
- Add JWT signature verification to `state_transitions` trigger (detect forged agent_id)
- Implement token revocation cache in `src/runtime/agent-jwt.js` (in-memory blocklist, cleared on HALT)
- Timeline: critical for Phase 1 exit validation (by 2026-04-07)

---

## Known Bugs

### Gmail Auth Refresh Token Expiry

**Symptom:** `[orchestrator] Gmail poll error: invalid_grant` or `gmail_connected: false` in API status after 30-90 days.

**Files:** `autobot-inbox/src/gmail/auth.js`, `autobot-inbox/.env.example`

**Trigger:** Google revokes refresh tokens after ~6 months inactivity OR user revokes OAuth grant in Google account settings.

**Workaround:** Re-run OAuth setup: `npm run setup-gmail` or use dashboard browser flow.

**Permanent Fix:** Implement refresh token rotation (Google recommends storing rotation count + requesting new token on first revocation). Add monitoring to catch expiry before impact.

---

### Linear Webhook Signature Never Validates

**Symptom:** Linear tickets are not ingested into pipeline.

**Files:** `autobot-inbox/src/api.js` (webhook signature check)

**Trigger:** Linear webhook is sent with self-signed HMAC that doesn't match our computed signature.

**Workaround:** System accepts it via header fallback (linear-delivery + user-agent check).

**Status:** Waiting on Linear support response. Verified 2026-03-08 that our HMAC implementation is correct.

---

### Dashboard Pages Intermittently Timeout on Load

**Symptom:** Dashboard page loads hang for 5-15 seconds, then show stale data or 503 error.

**Files:** `autobot-inbox/src/api.js` (cachedQuery, timeout logic), `autobot-inbox/dashboard/src/app/**/page.tsx`

**Trigger:** Agent loop is processing heavy email (large attachments, embedding computation) — PGlite single connection is blocked.

**Workaround:** Stale-while-revalidate pattern automatically kicks in; user sees last known good data.

**Root Cause:** PGlite single-connection bottleneck (see Tech Debt above).

---

## Security Considerations

### Hardcoded Secrets Scanning

**Risk:** Potential for hardcoded API keys, tokens, or credentials in source code despite `.env` handling.

**Files:** `autobot-inbox/src/runtime/exploration/domains/security-scan.js` (detection tool)

**Current Mitigation:**
- `.env` never committed (in `.gitignore`)
- `.env.example` documents required vars but has no secrets
- Explorer domain scans for hardcoded patterns: `sk-*`, `ghp_*`, `xoxb-*`, `api_key=`, `password=`
- Code review gates (CODEOWNERS on config/)

**Recommendations:**
- Run security-scan.js monthly to detect drift
- Add pre-commit hook: `grep -r "sk-[a-zA-Z0-9]" src/` (fail if found)
- Rotate API keys annually regardless of exposure risk (principle of least privilege)

---

### Permission Grants Overly Broad

**Risk:** Executor agents granted write permissions they may not need. Wildcard resource_id grants risk unintended access.

**Files:** `autobot-inbox/sql/001-baseline.sql` (permission_grants table definition), `autobot-inbox/src/runtime/exploration/domains/security-scan.js` (detection)

**Current Findings:**
- No known overly broad grants in current config
- Explorer domain flags any executor with write permissions (prevents future mistakes)

**Recommendations:**
- Implement principle of least privilege: executor agents should only have write access to resources they own
- Add board audit of all permission_grants with `resource_id = '*'` quarterly
- Consider schema-level separation: executor agents in isolated schemas with limited cross-schema access

---

### API CORS Configuration

**Risk:** ALLOWED_ORIGINS includes localhost variants and production domains. Misconfiguration could expose API.

**Files:** `autobot-inbox/src/api.js` (lines 43-47)

**Current Configuration:**
```javascript
const ALLOWED_ORIGINS = new Set([
  'http://localhost', 'http://localhost:3100', 'http://localhost:3000',
  'https://staqs.io', 'https://www.staqs.io', 'https://inbox.staqs.io',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
]);
```

**Risk Level:** Medium (production domains included, env var injection possible)

**Recommendations:**
- Remove localhost entries before production deployment
- Validate `ALLOWED_ORIGINS` env var format (split, trim, validate domain format)
- Add warning log if ALLOWED_ORIGINS contains `*` or localhost in production env
- Use subdomain whitelisting (e.g., `*.staqs.io`) only after verifying subdomain ownership

---

## Performance Bottlenecks

### Large Files Complexity

**Problem:** Several modules exceed 400 lines, with largest files at 2062 lines.

**Files (Top 10 by size):**
- `autobot-inbox/src/api.js` — 2062 lines (monolithic HTTP server + webhook routing)
- `autobot-inbox/src/agents/executor-redesign.js` — 1701 lines
- `autobot-inbox/src/strategy/evaluation-protocol.js` — 901 lines
- `autobot-inbox/src/graph/pattern-extractor.js` — 712 lines
- `autobot-inbox/src/runtime/agent-replacement.js` — 656 lines
- `autobot-inbox/dashboard/src/app/drafts/page.tsx` — 1285 lines
- `autobot-inbox/dashboard/src/app/signals/page.tsx` — 1190 lines

**Impact:**
- `src/api.js`: difficult to test in isolation, mixed concerns (HTTP, webhooks, auth, health checks)
- Dashboard pages: slow to load, hard to extract reusable components

**Improvement Path:**
- Extract api.js concerns: create `src/api-routes/` submodules for each logical feature
  - `routes/webhooks.js` (webhook handlers)
  - `routes/auth.js` (OAuth flows)
  - `routes/status.js` (health check)
  - `routes/debug.js` (debug endpoints)
- Dashboard pages: extract large tables/lists into components
  - `components/DraftsTable.tsx`
  - `components/SignalsCard.tsx`
- Target: no source file > 500 lines

---

### Dashboard Voice Bootstrap

**Problem:** `bootstrap-voice` script loads full voice profile corpus (10K+ sent emails with embeddings) into memory and computes similarity matrix.

**Files:** `autobot-inbox/scripts/bootstrap-voice.js`, `autobot-inbox/src/voice/profile-builder.js` (buildGlobalProfile)

**Impact:**
- Blocks API for 60+ seconds during bootstrap
- Cannot parallelize: single-threaded pgvector operations
- Fails silently if embeddings provider (Anthropic) is down

**Improvement Path:**
- Lazy-load voice profile on first triage request (not at startup)
- Cache embeddings in `voice.voice_embeddings` table (already exists)
- Implement chunked similarity computation (batch 100 emails at a time)
- Add graceful degradation: if bootstrap fails, use backup profile (simple from/to frequency)

---

### Code Quality Markers Accumulation

**Problem:** Exploration domain finds TODO/FIXME/HACK markers. These are governance signals but also indicate incomplete work.

**Files Affected:** `autobot-inbox/src/agents/research/deep-research-handler.js` (line 446), `autobot-inbox/src/api.js` (line 959), `autobot-inbox/src/runtime/agent-loop.js` (line 465)

**Current Markers:** ~3 significant TODOs with associated tech debt:
- Deep research signal injection (deferred to v2)
- Linear webhook signing fallback (waiting on Linear support)
- LLM-based completeness check (governance improvement)

**Improvement Path:**
- Convert TODOs to tracked work items in task graph (not inline comments)
- Establish bot that surfaces all TODO/FIXME to board dashboard monthly
- Enforce: new code must not add TODO without corresponding work_item
- Target: zero active TODOs by end of Phase 1

---

## Fragile Areas

### Email Body Fetching (Adapter-Dependent)

**Files:** `autobot-inbox/src/runtime/context-loader.js`, `autobot-inbox/src/adapters/` (Gmail, Outlook, Slack adapters)

**Why Fragile:**
- Email body is never stored (metadata-only design, ADR-001)
- On-demand fetch from external APIs (Gmail, Outlook, Slack) — any provider outage breaks context assembly
- Three different adapter implementations (Gmail GraphAPI, Outlook REST, Slack SDK) with different rate limits and error modes
- No caching of fetched bodies — repeated requests for same email fetch 3x

**Safe Modification:**
- Add caching layer in context-loader: `bodyCache = new Map()` with 30-minute TTL
- Implement circuit-breaker per adapter: fail fast after 3 consecutive fetch errors
- Test each adapter against provider outage scenarios
- Add fallback: if fetch fails, use partial body from metadata (subject + summary snippet)

**Test Coverage:** Adapter tests exist (`test/email-adapter.test.js`, `test/outlook-adapter.test.js`) but are basic

---

### Constitutional Gate G3 (Voice Tone Matching)

**Files:** `autobot-inbox/src/runtime/guard-check.js` (G3 implementation), `autobot-inbox/src/voice/profile-builder.js` (profile building)

**Why Fragile:**
- Tone similarity computed using pgvector cosine distance against voice profile embedding
- If voice profile is corrupted or incomplete (missing formality_score, tone_dimensions), matching fails silently
- No fallback if embedding provider is down during draft review
- Tone threshold (0.80) is hardcoded, not configurable

**Safe Modification:**
- Add voice profile validation at startup: `validateVoiceProfile(profile)` checks all required fields
- Implement embedding fallback: if Anthropic unavailable, use simple rule-based tone check (formality_score from edit deltas)
- Make threshold configurable: `VOICE_TONE_THRESHOLD` env var (default 0.80)
- Test against corrupted profile scenarios

**Test Coverage:** `test/guard-check.test.js` covers happy path but not error cases

---

### Executor Assignment Routing

**Files:** `autobot-inbox/src/agents/orchestrator.js` (executor routing logic)

**Why Fragile:**
- Routing logic uses `work_item.routing_class` + config-driven agent selection to determine which executor to assign
- If `routing_class` is NULL or invalid, assignment may fail
- No validation that assigned executor is actually enabled in `config/agents.json`
- If executor agent crashes, newly created work_items are stuck in `assigned` state

**Safe Modification:**
- Add routing validation in orchestrator: `validateRoutingClass(routing_class)` fails task if invalid
- Check executor enabled status before assignment: `if (!enabledAgents.has(executorId)) { fail() }`
- Add reaper rule: if executor assignment fails 3x, escalate to architect

**Test Coverage:** Basic routing tests exist but not exhaustive executor failure scenarios

---

## Scaling Limits

### Daily Budget Allocation Model

**Current Capacity:** 
- $20/day hardcoded (env var `DAILY_BUDGET_USD`)
- Splits evenly across 6-8 agents (orchestrator, strategist, triage, responder, reviewer, architect, ticket, coder)
- At $0.0015 per email (triage cost), sustains ~13k emails/day

**Limit:** If user traffic grows 10x (130k emails/day), budget exhausted in 1 hour.

**Scaling Path:**
1. Increase `DAILY_BUDGET_USD` (simplest, costs more)
2. Implement agent capacity prioritization: allocate budget by agent tier + current queue depth
3. Implement queue shedding: if triage backlog > 100, drop lowest-priority FYI emails
4. Switch to per-execution budget reservation (instead of per-agent)

---

### PGlite Single Connection Limits Concurrent Agents

**Current Capacity:** 
- Single-threaded PGlite can handle 1-2 agents max without contention
- Adding 3rd agent causes 50% query latency increase
- 4+ agents cause timeouts

**Scaling Path:**
- Phase 1: accept PGlite limit (dev-only anyway)
- Phase 1.5: migrate to Supabase (removes connection bottleneck)
- Phase 2: implement agent-specific DB connections (per-agent role per ADR-018 Phase 2)

---

### Neo4j Graph Database Scaling

**Current State:** Neo4j driver integrated (`src/graph/client.js`) but underutilized.

**Files:** `autobot-inbox/src/graph/` directory, `autobot-inbox/docs/internal/adrs/019-neo4j-knowledge-graph.md`

**Limit:** Knowledge graph not yet scaled to production workload. No queries in critical path.

**Scaling Plan:**
- ADR-019 (accepted) proposes knowledge graph for agent learning + pattern discovery
- Currently used only by claw learning domain (experimental)
- If adopted, Neo4j queries in triage routing could improve quality

---

## Scaling Limits — Email Ingestion

**Current Capacity:**
- Gmail poll interval: 60 seconds
- Processes ~7 emails/minute (~430/hour)
- Supports ~10k/day with 8-hour working hours (realistic for Eric's inbox)

**Scaling Path for Higher Volume:**
- Implement push notifications (Gmail webhooks) instead of polling
- Parallelize triage: split `executor-triage` into N stateless instances
- Add email batching: process 10 emails in single Haiku call (saves 90% of API cost)

---

## Dependencies at Risk

### @electric-sql/pglite Maturity Risk

**Risk:** PGlite is WASM Postgres, relatively new project. Single-connection design limits architecture.

**Files:** `autobot-inbox/src/db.js` (getPgLite function)

**Current Usage:** Dev/demo only (production targets Supabase)

**Migration Plan:**
- PGlite acceptable for Phase 1 dev, migrate to Supabase before production
- ADR-004 already covers migration strategy
- No immediate action needed, but monitor PGlite releases for breaking changes

---

### Anthropic Claude Agent SDK

**Risk:** Rapidly evolving SDK (`@anthropic-ai/claude-agent-sdk` v0.2.69). Breaking changes possible.

**Files:** Package.json dependency, used throughout agent code

**Current Pattern:** SDK used for standard Haiku/Sonnet/Opus calls, not advanced features

**Recommendation:**
- Pin to major version: `^0.2.x` (already done)
- Test agent SDK updates in staging before production deploy
- Subscribe to Anthropic SDK release notes

---

### Hardcoded NEO4J_USER

**Risk:** Neo4j username hardcoded in source, not externalized to env var.

**Files:** `autobot-inbox/src/graph/client.js` (line ~20, needs verification)

**Impact:** Cannot change Neo4j auth without code change

**Fix:** ADR-019 already notes this — move to `NEO4J_USER` env var alongside `NEO4J_PASSWORD`

---

## Test Coverage Gaps

### Missing Integration Tests for Agent Pipeline

**What's not tested:** End-to-end flow: email arrives → triage → responder drafts → reviewer approves → sent.

**Files:** `test/` has 22 unit tests but no integration test for full pipeline

**Risk:** Bug in state machine or event routing could go undetected (happened before, see incident-response runbook)

**Priority:** High (affects core product functionality)

**Test Scenario:** 
```javascript
1. Insert test email into inbox.emails
2. Trigger orchestrator → creates work_item
3. Executor-triage claims + completes
4. Executor-responder claims + creates draft
5. Reviewer claims + approves
6. Orchestrator detects approved draft + sends
7. Assert: email marked sent, draft marked delivered, llm_invocations totaled
```

---

### Missing Tests for Guard-Check Failures

**What's not tested:** When G1-G7 gates should block execution. Current tests only verify happy path.

**Files:** `test/guard-check.test.js` (basic implementation)

**Risk:** Gate could be silently bypassed (e.g., new executor type not added to G7 commitment check)

**Priority:** Medium (governance failure detection)

**Test Scenarios:**
- G1: Budget exhausted, should fail
- G2: Commitment language detected, should fail
- G3: Tone mismatch, should fail
- G5: Reply-all draft, should flag (warn but not block)

---

### Missing Tests for Error Recovery

**What's not tested:** Agent crash recovery, task timeout handling, state rollback.

**Files:** `src/runtime/reaper.js`, `src/runtime/state-machine.js` (limited test coverage)

**Risk:** System could enter unrecoverable state if agent crashes mid-transaction

**Priority:** Medium (affects reliability)

**Test Scenarios:**
- Agent crashes mid-guard-check (partial state update)
- Task times out after 5 min (should transition to `timed_out`)
- State transition fails (hash chain broken)

---

### Dashboard Component Testing

**What's not tested:** React components in dashboard. Only integration tests for API layer.

**Files:** `autobot-inbox/dashboard/src/app/**/*.tsx` (no `.test.tsx` files found)

**Risk:** UI bugs (rendering errors, event handler crashes) undetected

**Priority:** Low (less critical path, but impacts board UX)

**Tool:** Next.js app already compatible with Jest/Vitest

---

## Missing Critical Features

### Token Revocation List

**Problem:** Agents hold 15-minute JWT tokens. If agent is killed/compromised, old token remains valid until expiry.

**Impact:** Violates P1 (Deny by default) — should not trust stale auth

**Solution Exists:** ADR-018 Phase 2 plans per-agent token revocation, but Phase 1 defers to kill switch

**Timeline:** Should be Phase 1 if agents will run on shared infrastructure

**Implementation:** In-memory blocklist in `src/runtime/agent-jwt.js`, cleared on HALT

---

### Per-Agent Database Roles

**Problem:** All agents connect as shared `autobot_agent` role. RLS policies exist but cannot isolate agents from each other's work.

**Impact:** Agent could query/modify another agent's in-progress work (low risk today, critical for scaling)

**Solution Exists:** ADR-018 Phase 2 plans one DB role per agent

**Timeline:** Critical for multi-agent deployments (Phase 1.5+)

---

### Email Search / Full-Text Indexing

**Problem:** No way to search email corpus. Dashboard and CLI cannot find emails by subject/from/content snippet.

**Impact:** User cannot locate specific emails in large inbox

**Current Workaround:** Gmail native search

**Implementation:** Add GIN index on `inbox.emails.subject`, `from_address` + implement /api/search endpoint

---

## Summary by Priority

| Concern | Severity | Timeline | Owner |
|---------|----------|----------|-------|
| PGlite bottleneck (scaling block) | High | Phase 1.5 (after MVP) | Architect |
| JWT RLS enforcement incomplete | High | Phase 1 (before exit) | Executor |
| Linear webhook security gap | High | This week | Executor |
| Completeness check missing | Medium | Phase 1 | Executor |
| Deprecated view cleanup | Medium | Phase 1 end | Executor |
| Gmail refresh token renewal | Medium | Ongoing | Executor |
| Large file refactoring | Low | Phase 2 | Executor |
| Test coverage gaps | Medium | Phase 2 | Executor |

---

*Concerns audit: 2026-04-01*

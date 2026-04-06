# Pitfalls Research

**Domain:** Spec compliance audit and refactoring of a live governed agent system
**Researched:** 2026-04-01
**Confidence:** HIGH (grounded in actual codebase analysis from `.planning/codebase/`)

---

## Critical Pitfalls

### Pitfall 1: Breaking the Live Pipeline by Activating Dormant Enforcement

**What goes wrong:**
The codebase already has JWT infrastructure (`agent-jwt.js`), RLS policies in SQL, and `withAgentScope()` — all present but not fully enforced. An auditor finds "RLS not enforced" in the gap list, marks it as a compliance violation, and activates enforcement in a single commit. The pipeline immediately halts: agents calling `transitionState()` without a valid JWT in the session context get blocked by newly active RLS policies. Every in-flight work item is stuck.

This is the highest-risk pitfall in this codebase. The CONCERNS file explicitly flags: "RLS enforcement: partial (policies defined, enforcement optional)." Flipping this switch while agents are processing live email is a breaking change disguised as a configuration change.

**Why it happens:**
Dormant infrastructure looks like a simple config toggle. Auditors think "the code is already there, we just need to turn it on." What they miss is that activation requires every callsite to pass a valid session context, and that the `withAgentScope()` function is only called in some paths, not all. Every uncovered callsite becomes an instant breakage.

**How to avoid:**
1. Before any enforcement activation: grep every callsite that calls `query()` directly and verify it is wrapped in `withAgentScope()`.
2. Test enforcement activation against a full pipeline run in Docker with a cloned database — not against the live system.
3. Use a feature flag (`ENFORCE_RLS=true`) so activation is independently deployable and reversible without a code change.
4. Activate enforcement in a staging environment for a minimum of one full pipeline cycle (triage → draft → review → approval) before production.
5. Have a rollback plan: the feature flag must be the only change in the commit.

**Warning signs:**
- Agent loop logs show `permission denied` or `no rows returned` after a schema change
- Work items stuck in `assigned` state and not advancing
- `guardCheck()` throwing errors where it previously passed
- `withAgentScope()` not present in all agent handler callsites

**Phase to address:** Phase dealing with JWT/RLS compliance gap (SPEC §5 target architecture). Must be the first item in that phase, with a full pipeline smoke test as the acceptance criterion.

---

### Pitfall 2: Conflating "Currently Implemented" with "Target Architecture" in Audit Scope

**What goes wrong:**
SPEC §5 describes two distinct states: the current guardrail system (G1-G7 via `guard-check.js`) and the target architecture (per-agent DB roles, JWT RLS, tool allow-lists, content sanitization). An auditor treating both as Phase 1 exit criteria will waste weeks building per-agent DB roles (explicitly Phase 2 per CONCERNS) and over-scope the audit into new-feature territory. The PROJECT.md constraint is explicit: "No feature creep — audit and fix only."

**Why it happens:**
The spec is written as a continuous document. Without a clear "Phase 1 boundary" marker inside it, auditors read the target architecture description and assume it all needs to be present now. The distinction lives in `CLAUDE.md` and `CONCERNS.md`, not in SPEC.md itself.

**How to avoid:**
1. Before any audit work begins, create an explicit Phase 1 vs. Phase 2+ scope map by cross-referencing SPEC.md sections against CONCERNS.md's "Fix Approach" and "Timeline" fields.
2. For each spec gap found, classify it as: (a) must fix for Phase 1 exit, (b) explicitly deferred to Phase 2, or (c) genuinely unaddressed.
3. Treat CONCERNS.md as the authoritative scope boundary — it already contains board-reviewed timelines.
4. Mark any spec section where the spec says "target" or "Phase 2" as out of scope in the audit checklist before starting.

**Warning signs:**
- An audit task is creating new infrastructure (per-agent DB roles, token revocation list) rather than verifying or fixing existing code
- The refactoring plan exceeds the "fix all identified compliance gaps" scope from PROJECT.md
- Board review items are accumulating because auditors are making new architectural decisions

**Phase to address:** Pre-audit scoping phase (before any code changes). This is a planning discipline, not a code fix.

---

### Pitfall 3: Losing Hash-Chain Integrity During Schema Refactoring

**What goes wrong:**
The `agent_graph.state_transitions` table is hash-chained and append-only. Any refactoring that adds a column, changes a column type, or reorders data in this table can break the chain integrity if the hash computation includes schema-dependent fields. A migration that adds a `NOT NULL` column with a default value retroactively changes what "the previous row" looks like to any integrity checker that re-reads the table.

Similarly, the `inbox.drafts` → `agent_graph.action_proposals` migration (removing the deprecated view) requires care: if any audit endpoint queries `inbox.drafts` and the view is dropped while it still has consumers, audit queries fail silently and integrity cannot be verified.

**Why it happens:**
Hash-chain integrity is tested in isolation (unit tests for `guard-check.test.js`) but not in integration with schema migrations. Developers assume "append-only means safe to add columns" — true for the data, but potentially false for hash computation if the hash includes a row's full column set.

**How to avoid:**
1. Before any migration to `agent_graph.state_transitions`, verify what fields are included in the hash computation by reading `merkle-publisher.js` and `infrastructure.js`.
2. After every schema migration on hash-chained tables, run a full chain integrity check (not just the happy-path unit test).
3. Migrate the `inbox.drafts` view removal in two commits: (a) migrate all code to `agent_graph.action_proposals`, (b) verify zero references to `inbox.drafts` remain, then (c) drop the view.
4. Add a CI check: grep for `inbox.drafts` references before any migration that removes the view.

**Warning signs:**
- Merkle proof validation fails after a migration
- `spec-drift-detector.js` reports unexpected schema changes
- Audit endpoint returns gaps where records should be continuous
- Hash of `state_transitions` row does not match recomputed value

**Phase to address:** Schema cleanup phase (deprecated view removal and any migration that touches `state_transitions`).

---

### Pitfall 4: Audit Scope Creep from "Fix While You're In There" Impulse

**What goes wrong:**
An auditor finds that `src/api.js` (2062 lines) contains webhook signature verification code that's incorrectly structured relative to P2 (infrastructure enforces). The correct fix is small — enforce at the DB level or in a middleware, not in the route handler. But the file is 2062 lines and "clearly needs refactoring." The auditor begins extracting `routes/webhooks.js`, `routes/auth.js`, etc. Three days later, the audit has become a large-scale refactoring with multiple unrelated changes, and it's impossible to bisect which change introduced a regression.

**Why it happens:**
Compliance audits reveal code smells. The instinct to fix everything visible is natural and well-intentioned. But each additional change increases blast radius and reduces the traceability of individual fixes.

**How to avoid:**
1. Strict rule: one spec violation per commit. The commit message must name the spec section being addressed.
2. When you find a secondary issue during an audit fix, open a tracked work item for it — do not fix it inline.
3. The PROJECT.md constraint is explicit: "Rewriting working code for style preferences — only fix spec violations." File size is a style concern, not a spec violation.
4. Use atomic commits as the accountability mechanism: if a commit cannot be described as "fixes SPEC §X compliance gap Y," it does not belong in this audit.

**Warning signs:**
- A commit touches more than 3 files for a single spec violation fix
- PR descriptions mention "while I was in there"
- The audit milestone has commits that don't reference a spec section
- Refactoring tasks are appearing in the backlog without a corresponding spec gap

**Phase to address:** Every phase. This is a process discipline that must be enforced from the first commit.

---

### Pitfall 5: Over-Engineering Enforcement to Match the Target Architecture Prematurely

**What goes wrong:**
SPEC §5 target architecture specifies JWT-scoped agent identity with per-agent DB roles. The current system uses a shared `autobot_agent` role with JWT signing but no per-agent role enforcement. An auditor reads the spec, sees the gap, and implements full per-agent roles — creating 11 PostgreSQL roles, modifying connection strings for each agent, and updating `withAgentScope()` to switch roles dynamically. This is Phase 2 work (per CONCERNS.md). It introduces significant operational complexity, requires new migration infrastructure, and creates new failure modes in a live system.

The enforcement that is *needed* for Phase 1 exit is much smaller: activate RLS using the existing `autobot_agent` role with `app.agent_id` session variable. The full per-agent role isolation can wait.

**Why it happens:**
The spec describes the target cleanly and completely. It is easy to implement the target when you have the spec in front of you. It is harder to identify the minimum slice that closes the Phase 1 exit criterion without building the rest.

**How to avoid:**
1. For every compliance gap, write down the minimum code change that satisfies the Phase 1 exit criterion — not the target architecture.
2. Cross-reference ADR-018 explicitly: it specifies what is Phase 1 vs. Phase 2 for JWT/RLS.
3. Use "implement the minimum, document the rest" — add a comment referencing the ADR when deferring Phase 2 work, so it is not silently lost.
4. Present Phase 1 vs. Phase 2 scope to both board members before starting any JWT/RLS work (board decision 2026-03-07 already covers this; verify scope hasn't drifted).

**Warning signs:**
- New PostgreSQL roles appearing in migrations during Phase 1
- Connection string management becoming more complex
- Agent startup sequence adding new JWT ceremony steps not in ADR-018 Phase 1
- Board review items about infrastructure changes that were supposed to be "config only"

**Phase to address:** JWT/RLS enforcement phase. Scope must be locked before writing any code.

---

### Pitfall 6: Breaking the Audit Trail by Modifying State Transition Logic

**What goes wrong:**
The `transitionState()` + `guardCheck()` atomic transaction is the heart of P2 enforcement. If a refactor separates these two operations — even temporarily, even "just to test" — you create a window where state transitions can occur without guard checks. In a live system processing real email, this window may be exploited (or may cause data integrity issues) even if it is only open for minutes.

A second form: changing the order of operations inside the transaction (e.g., running `guardCheck()` after `INSERT INTO state_transitions` instead of before) produces an audit log that claims transitions were authorized when they were not yet checked at the time of logging.

**Why it happens:**
The atomicity requirement is documented in SPEC §5 but is easy to violate accidentally during refactoring. Developers testing individual components often stub out one side of the pair, then forget to restore the requirement.

**How to avoid:**
1. Never stub or remove `guardCheck()` from `transitionState()` for any reason, including tests. Integration tests must exercise the real guard check.
2. Any change to `state-machine.js` that touches the `BEGIN`/`COMMIT` block must have a corresponding test that verifies guard check runs before the state transition is committed.
3. Code review gate: no PR that modifies `transitionState()` is merged without explicit sign-off that atomicity is preserved.

**Warning signs:**
- Unit tests for state machine that stub `guardCheck` entirely
- `state_transitions` rows appearing without corresponding `guard_check_log` entries
- `transitionState()` catching and swallowing guard check errors rather than re-throwing

**Phase to address:** Any phase that touches guardrail enforcement or state machine code.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keep `inbox.drafts` view instead of migrating consumers | Avoid breaking dashboard code | Two sources of truth, audit confusion, view adds latency to every draft query | Never — deadline is Phase 1 end per CONCERNS.md |
| Activate RLS without testing all agent callsites | Quick compliance checkbox | Pipeline halt, work items stuck, potentially corrupt state transitions | Never in production |
| Fix secondary code quality issues inline with spec compliance fixes | Cleaner code faster | Untraceable regressions, audit commits become un-bisectable | Never during a compliance audit |
| Skip integration test for hash-chain integrity after migration | Faster migration deployment | Silent chain corruption discovered only during an audit or incident | Never for any migration touching `state_transitions` |
| Mark Phase 2 items as "in progress" to satisfy Phase 1 exit criteria | Looks compliant sooner | Board is misled, Phase 1 exit criteria are not actually met | Never |
| Use in-memory blocklist for token revocation instead of DB table | Faster implementation | Revocations lost on restart, does not survive HALT/resume cycle | Acceptable for Phase 1 per ADR-018 if HALT clears the blocklist |

---

## Integration Gotchas

Common mistakes when connecting enforcement to live infrastructure in this system.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `withAgentScope()` + RLS activation | Calling `SET app.agent_id` without verifying JWT first, allowing unauthenticated agents to set arbitrary IDs | Verify JWT signature in `withAgentScope()` before `SET app.agent_id`, reject if verification fails |
| `state_transitions` hash chain + migrations | Running `ALTER TABLE` on `state_transitions` without checking what fields are hashed | Read `merkle-publisher.js` to confirm hash inputs before any migration on that table |
| `inbox.drafts` view removal | Dropping the view before updating all API endpoints and dashboard pages that reference it | Grep for all consumers, migrate in order: API routes first, dashboard second, then drop |
| Linear webhook security gap | Patching the fallback acceptance in `api.js` inline with other compliance fixes | Treat as a separate security fix with board review; do not mix with spec compliance commits |
| Constitutional gate G3 (voice tone threshold) | Changing the hardcoded `0.80` threshold as part of a "make it configurable" refactor during the audit | Only change if SPEC.md requires configurability; otherwise, leave it — this is a style improvement, not a compliance gap |
| `agent-loop.js` completeness check | Re-implementing the removed completeness check during the audit as a compliance fix | The removed check was governance theater; replacing it is a new feature (out of scope for Phase 1 audit) |

---

## Performance Traps

Patterns that work at small scale but surface during audit-driven refactoring.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Activating full JWT verification on every `query()` call | Agent loop latency doubles; PGlite single-connection bottleneck worsens | Only enforce JWT in `withAgentScope()` for sensitive queries; not on every SELECT | Immediately on PGlite; at ~3 concurrent agents on real Postgres |
| Running `merkle-publisher.js` hash integrity check on startup | Startup takes 60+ seconds; blocks API from accepting requests | Run integrity check as background job, not in startup critical path | At ~10k `state_transitions` rows |
| Dashboard query volume increase from new audit endpoints | Dashboard timeout rate increases; stale-while-revalidate cache misses increase | Add new audit endpoints to the `cachedQuery` pattern in `api.js` with appropriate TTLs | When audit phase adds 3+ new API endpoints querying `state_transitions` |
| Voice bootstrap blocking startup during refactor | API unavailable for 60+ seconds after each restart | Lazy-load voice profile on first triage request, not at startup | At 10k+ sent emails in corpus |

---

## Security Mistakes

Domain-specific security issues for a governed agent system undergoing compliance audit.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Activating RLS while agents hold long-lived transactions | Agent with valid session pre-dates RLS activation; RLS checks run on new transactions only, old in-flight transactions bypass enforcement | Drain all in-flight work items to `completed` or `blocked` state before activating RLS; restart agents after activation |
| Treating the audit itself as an agent-level permission | Audit code running as `autobot_agent` role can read and modify any agent's work | Audit reads should use a dedicated read-only role; never run audit mutations in the agent schema |
| Fixing the Linear HMAC fallback by removing it entirely | If the fallback is removed before Linear support resolves the signing issue, Linear webhook ingestion stops working | Keep the fallback; add rate limiting and source IP allowlist as interim measures; do not remove until HMAC validates correctly |
| Committing `.env` with audit credentials | Secrets exposed in git history | `.gitignore` covers this; verify before any commit that touches `autobot-inbox/.env.example` |
| Adding new `permission_grants` with `resource_id = '*'` during audit | Overly broad access granted to fix a narrow compliance gap | Audit permission grants by checking for `resource_id = '*'` before and after every migration |

---

## "Looks Done But Isn't" Checklist

Things that appear complete in a spec compliance audit but are missing critical pieces.

- [ ] **JWT enforcement activated:** Verify `withAgentScope()` is called in every agent that reads or writes sensitive schemas, not just the ones that were originally audited. Check orchestrator, strategist, reviewer, and all executor variants.
- [ ] **RLS policies active:** Running `SELECT * FROM pg_policies` confirms policies exist — but "existing" is not "enforced." Verify `FORCE ROW LEVEL SECURITY` is set on the tables, not just the policies defined.
- [ ] **Hash chain integrity:** The Merkle publisher runs on a schedule. Verify the scheduled job is actually running (check `autobot_finance.phase1_metrics` or `infrastructure_logs`) and has not been accidentally disabled during refactoring.
- [ ] **`inbox.drafts` view removed:** Removing the view is step 3. Step 1 is migrating all consumers. Grep for `inbox.drafts` in the full codebase (including dashboard `page.tsx` files, api routes, and any CLI scripts) before declaring the migration complete.
- [ ] **Guard check atomicity preserved:** After any change to `state-machine.js`, run the integration test that verifies `guardCheck()` and `transitionState()` are still in the same DB transaction. The unit test alone does not verify this.
- [ ] **Completeness check absence documented:** The missing LLM-based completeness check is an open TODO in `agent-loop.js`. Verify this is tracked as a work item in the task graph, not silently dropped from the audit scope.
- [ ] **Token revocation on HALT:** The in-memory JWT blocklist must be populated when a HALT command is issued. Verify the `dead-man-switch.js` or HALT handler actually calls the revocation function in `agent-jwt.js`.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Pipeline halted by premature RLS activation | HIGH | 1. Immediately set `ENFORCE_RLS=false` (feature flag). 2. Restart agent processes. 3. Verify in-flight work items resume from `assigned` state. 4. Audit all `withAgentScope()` callsites before re-enabling. |
| Hash-chain integrity broken by migration | HIGH | 1. Do not run further migrations. 2. Identify the last valid hash in `state_transitions`. 3. Rebuild hash from that point using `merkle-publisher.js` replay function (verify one exists). 4. Board review required before resuming. |
| `inbox.drafts` view dropped while consumers still reference it | MEDIUM | 1. Recreate the view immediately from the backup SQL in `sql/001-baseline.sql`. 2. Deploy view recreation before any other changes. 3. Identify remaining consumers and migrate them before dropping again. |
| Audit scope creep — accidental feature introduced | MEDIUM | 1. Revert the feature commit. 2. Open a separate work item for the feature. 3. Continue the audit without it. Do not attempt to "partially revert" a mixed commit. |
| `guardCheck()` accidentally decoupled from `transitionState()` | CRITICAL | 1. Revert immediately — do not patch forward. 2. Review all `state_transitions` rows written since the decoupling for guard check compliance. 3. For rows written without guard check: flag as unverified in a new `audit_flags` entry, escalate to board. |
| Phase 2 work accidentally deployed to Phase 1 | LOW-MEDIUM | 1. Identify if it is additive (new DB roles) or breaking (schema changes). 2. Additive: leave in place, document as early Phase 2 delivery. 3. Breaking: revert, redeploy, open Phase 2 work item. |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Breaking pipeline by activating dormant RLS | JWT/RLS enforcement phase — must have feature flag and callsite audit before activation | Full pipeline smoke test: email → triage → draft → review → approval without work items sticking |
| Confusing current vs. target architecture scope | Pre-audit scoping (Phase 0 of audit) | Scope document signed off by board, with explicit Phase 1 / Phase 2 boundary per ADR-018 |
| Losing hash-chain integrity in migration | Schema cleanup phase (deprecated view removal) | `merkle-publisher.js` integrity check passes after every migration |
| Audit scope creep | Every phase — enforced by commit message convention | Zero commits in audit milestone without a SPEC.md section reference |
| Over-engineering enforcement | JWT/RLS enforcement phase scope lock | ADR-018 Phase 1 scope confirmed before coding begins |
| Breaking guard check atomicity | Any phase touching `state-machine.js` | Integration test: guard failure blocks state transition (not just unit test) |

---

## Sources

- `.planning/codebase/CONCERNS.md` — Tech debt, fragile areas, known bugs (HIGH confidence — direct codebase analysis)
- `.planning/codebase/ARCHITECTURE.md` — System layers, data flow, state management (HIGH confidence)
- `CLAUDE.md` — Design principles P1-P6, agent tier constraints, board governance (HIGH confidence)
- `.planning/PROJECT.md` — Audit scope, constraints, out-of-scope items (HIGH confidence)
- [The Agentic Confusion: Why I Keep My Postgres Control Plane Deterministic](https://www.enterprisedb.com/blog/agentic-confusion-why-i-keep-my-postgres-control-plane-deterministic) — Deterministic enforcement patterns for agent systems (MEDIUM confidence)
- [WorkOS: The architecture of governable AI agents](https://workos.com/blog/ai-agents-architecture) — JWT intent binding, authorization at tool level (MEDIUM confidence)
- [Refactoring Databases Is a Different Animal](https://newsletter.systemdesignclassroom.com/p/refactoring-databases-is-a-different-animal) — Expand/Contract pattern, schema-level refactoring risks (MEDIUM confidence)
- [7 Pitfalls to Avoid in Application Refactoring Projects](https://vfunction.com/blog/7-pitfalls-to-avoid-in-application-refactoring-projects/) — Scope creep, incremental approach, blast radius (MEDIUM confidence)
- [Immutable Audit Trails: A Complete Guide](https://www.hubifi.com/blog/immutable-audit-log-basics) — Hash-chain pitfalls, enforcement at data store level (MEDIUM confidence)
- [AuditableLLM: Hash-Chain-Backed Compliance Framework](https://www.mdpi.com/2079-9292/15/1/56) — Hash chain dependency risks in LLM audit systems (MEDIUM confidence)

---

*Pitfalls research for: Optimus spec compliance audit — governed agent system*
*Researched: 2026-04-01*

# Project Research Summary

**Project:** Optimus Spec Compliance Audit
**Domain:** Governed agent organization — spec-vs-code systematic audit and targeted remediation
**Researched:** 2026-04-01
**Confidence:** HIGH

## Executive Summary

This project is a spec compliance audit, not a greenfield build. The target system (Optimus / autobot-inbox) is a live, production-processing governed agent organization: a 6-agent AI pipeline processing real email, governed by six design principles (P1-P6), seven constitutional gates (G1-G7), and a 34-migration Postgres task graph. The stack is fixed by principle P4 (boring infrastructure): Node.js 20+, ESM, `pg` with raw SQL, `node:test`. The audit adds thin, non-invasive tooling — ESLint custom rules, Semgrep semantic analysis, Atlas CLI for schema constraint testing, `jose` for JWT verification tests — all operating at the CLI/CI level without touching the runtime.

The recommended approach is a strictly bottom-up, four-tier audit sequence: schema and design principle foundations first (Tier 0), identity and enforcement layer second (Tier 1), coordination correctness third (Tier 2), and observability plus Phase 1 exit completeness last (Tier 3). Higher-tier audit findings are unreliable until lower tiers are clean. The most critical audit path runs from schema integrity through JWT/RLS activation through guardCheck-transitionState atomicity. SPEC §5 requires explicit "currently implemented" vs. "target architecture" classification for every finding — conflating the two is the audit's most common failure mode, identified in both PITFALLS.md and ARCHITECTURE.md independently.

The primary risk is pipeline disruption from activating dormant enforcement infrastructure. JWT signing and RLS policy definitions already exist in the codebase; enforcement is partial. Activating RLS without auditing every `withAgentScope()` callsite first will halt the live pipeline by blocking agents from their own DB writes. Mitigation requires a feature flag, full callsite audit, and a staging environment smoke test before any production activation. The secondary risk is scope creep: CONCERNS.md is the authoritative Phase 1 / Phase 2 boundary and must be treated as a scope fence before any compliance fix is written.

---

## Key Findings

### Recommended Stack

The audit tooling slots into the existing Node.js 20+ / ESM / `node:test` / `pg` stack without adding a new runtime or framework. ESLint 10.x with `eslint-plugin-sql` and `eslint-plugin-security` provides static enforcement of P1 (no SQL string interpolation) and G6 (security pattern detection). Semgrep (Python CLI, not npm) handles semantic-level architectural boundary checking that AST-level ESLint cannot express — such as "executor agents must not call strategist functions directly." Atlas CLI provides Postgres-native schema constraint testing via `atlas schema test`, the only tool that can assert constraint behavior by seeding data and verifying rejection. `jose` 6.x (ESM-native, no CVE history) replaces `jsonwebtoken` for any new JWT audit test code. `c8` provides V8-native ESM coverage without transpilation. `node:crypto` (built-in) handles all hash-chain verification — no external library needed and adding one would violate P4.

**Core technologies:**
- `eslint@10.1.0` + `eslint-plugin-sql@3.4.1` + `eslint-plugin-security@4.0.0`: Static analysis for P1 SQL injection surface and G6 security patterns — flat config, runs locally and in CI without infrastructure
- `semgrep` (pip): Semantic boundary checking for agent-tier violations that AST-level rules miss — YAML rules are version-controllable and reviewable
- Atlas CLI (binary, v0.30+): Schema constraint and FK testing against real Postgres — the only tool with native `atlas schema test` for assertion-based DDL verification
- `jose@6.2.2`: JWT scope verification test writing — ESM-native, no algorithm confusion CVEs, actively maintained
- `c8@11.0.0`: V8-native ESM coverage — works without transpilation hacks, compatible with `"type": "module"` project
- `node:crypto` (built-in): SHA-256 hash-chain integrity verification — zero new dependencies, P4-compliant

**What NOT to add:** Jest (violates P4, requires Babel/transform for ESM), any ORM for catalog queries (masks SQL, P4 violation), `jsonwebtoken` for new code (CVE history, not ESM-native), Semgrep via npm (the npm package is a stub — install via pip only).

### Expected Features

The audit has a clear MVP boundary. Features are tiered: those required for Phase 1 exit board review, those required before Railway production deployment, and those that are ongoing governance health monitoring (Phase 1.5+). The existing codebase already has substantial audit infrastructure (`tier1-deterministic.js`, `tier2-ai-auditor.js`, `spec-drift-detector.js`, `adversarial-test-suite.js`) — the compliance audit extends and invokes these rather than replacing them.

**Must have (Phase 1 exit — table stakes):**
- Design principle P1-P6 sweep — every principle must have at least one verifiable infrastructure enforcement point
- Agent tier and model assignment verification — all 8 agents mapped to correct spec tier (Opus/Sonnet/Haiku)
- Agent capability constraint verification — `can_assign_to` lists confirmed explicit (no globs); executors cannot initiate tasks
- Task graph state machine legal transition check — illegal transitions blocked by DB constraints, not just code
- Guardrail G1-G7 completeness — all gates present in `gates.json` AND have active `guard-check.js` enforcement paths
- `guardCheck()` + `transitionState()` atomicity verification — all call sites confirmed in a single Postgres transaction
- Hash chain integrity — full `verify_all_ledger_chains()` run, append-only trigger existence confirmed
- Cross-schema isolation — zero cross-schema FKs (SPEC §12)
- JWT implementation completeness — implementation state mapped against ADR-018 Phase 1 requirements
- `pg_notify` vs Redis routing — event coordination confirmed not on Redis
- Phase 1 exit criteria gap map — complete pass/fail table against SPEC §14

**Should have (before Railway production deployment — v1.x security hardening):**
- Token revocation gap analysis — quantify 15-minute TTL exposure window, recommend in-memory blocklist cleared on HALT
- Permission grants over-breadth scan — flag `resource_id = '*'` grants
- Linear webhook HMAC gap classification — classify under P1 with remediation path
- Hash chain JS/SQL parity test — cross-implementation verification (same inputs, same hash from `state-machine.js` and `verify_ledger_chain()` SQL function)
- Completeness check absence documentation — document which executors have unvalidated outputs

**Defer (Phase 1.5+ / ongoing governance health):**
- Prompt-to-code fidelity deep trace — depends on Phase 2 per-agent role work
- Behavioral drift detection review — already handled by `tier2-ai-auditor.js` running daily
- Autonomy level enforcement audit — relevant once system approaches L0 exit conditions
- Adversarial sanitization test coverage — valuable but not a Phase 1 blocker
- Audit tier scheduling integrity — operational health monitoring, not compliance

**Anti-features (explicitly out of scope):**
- Rewriting working code for style compliance (only fix spec violations)
- Auditing Phase 2+ target architecture items as Phase 1 failures (inflates gap count, misleads board)
- Generating a compliance score or percentage (reduces nuanced severity to a single number)
- Deep LLM-based semantic analysis of every agent prompt (duplicates existing tier2 infrastructure, costs $50-80/run)

### Architecture Approach

The audit is structured as a directed acyclic graph with four tiers, not a linear scan. The dependency ordering is hard: findings at higher tiers are unreliable until lower-tier foundations are verified. Tier 0 (design principles P1-P6 + schema/DDL integrity) must complete before Tier 1 (JWT identity + constitutional gates G1-G7), which must complete before Tier 2 (task graph state machine + agent tier enforcement), which must complete before Tier 3 (hash-chain audit log integrity + Phase 1 exit criteria synthesis). Each audit component uses two-pass verification: static analysis (code vs. spec text) followed by runtime confirmation (exercise the constraint and confirm it fires). Static-only findings are labeled LOW confidence.

**Major components:**
1. **Tier 0 — Foundations:** P1-P6 design principle sweep across all `src/**/*.js` + schema integrity check (five schemas in `sql/001-baseline.sql`, zero cross-schema FKs). Cascading — findings here invalidate assumptions in all higher tiers.
2. **Tier 1 — Identity + Enforcement:** JWT agent identity (`agent-jwt.js`, `withAgentScope()` in `db.js`) + constitutional gates G1-G7 (`guard-check.js` + atomic `transitionState()` in `state-machine.js`). Identity must be verified before gates, because broken identity makes gate findings unreliable.
3. **Tier 2 — Coordination Correctness:** Task graph state machine (legal transitions, DAG edge integrity, retry/escalation to 3 then escalate) + agent tier enforcement (`config/agents.json` model assignments, `can_assign_to` enforcement in `orchestrator.js`). Only auditable once Tier 1 is clean.
4. **Tier 3 — Observability + Completeness:** Hash-chain audit log integrity (`state_transitions` SHA-256 chain, append-only triggers, merkle proofs) + Phase 1 exit criteria gap map (every SPEC §14 item either has a code pointer or an explicit "future phase" label). Closes the loop on all lower tiers.

**Classification scheme for every finding:**
- `CURRENT-IMPLEMENTED`: In codebase and active — verify correctness
- `CURRENT-PARTIAL`: In codebase but inactive or incomplete — document gap + severity
- `TARGET-FUTURE`: Spec says Phase 2+ — confirm not falsely claimed as done
- `CLAIMED-INCOMPLETE`: Code claims it but evidence is absent — flag as critical gap

### Critical Pitfalls

1. **Activating dormant RLS enforcement without auditing all callsites first** — The JWT/RLS infrastructure exists but enforcement is optional. Flipping enforcement without wrapping every `query()` callsite in `withAgentScope()` halts the live pipeline immediately. Prevention: feature flag (`ENFORCE_RLS=true`), full grep of all callsites, Docker staging smoke test through a full pipeline cycle before any production activation.

2. **Conflating "currently implemented" with "target architecture" in audit scope** — SPEC §5 describes both the current G1-G7 guardrail system and the Phase 2 target (per-agent DB roles, full RLS). Treating target items as Phase 1 failures wastes weeks building infrastructure that is intentionally deferred. Prevention: create an explicit Phase 1 / Phase 2 scope map from CONCERNS.md before writing any code; treat CONCERNS.md as the authoritative scope fence.

3. **Breaking guardCheck() + transitionState() atomicity during refactoring** — These two operations must execute in a single Postgres transaction (SPEC §5, P2). Any refactor that separates them — even temporarily — creates a window where agents can bypass constitutional gates. Prevention: never stub `guardCheck()` in tests; any change to `state-machine.js` touching the `BEGIN/COMMIT` block requires an integration test confirming the pair is still atomic.

4. **Losing hash-chain integrity during schema migration** — Migrations that add columns or change types on `agent_graph.state_transitions` can silently corrupt the chain if the hash computation includes schema-dependent fields. Prevention: read `merkle-publisher.js` to confirm hash inputs before any migration on that table; run `verify_all_ledger_chains()` after every migration that touches it.

5. **Audit scope creep from "fix while you're in there" impulse** — Compliance audits expose code smells. Each unrelated fix increases blast radius and makes regressions impossible to bisect. Prevention: one spec violation per commit; commit message must name the spec section; any secondary finding goes to a tracked work item, never fixed inline.

---

## Implications for Roadmap

Based on combined research, the audit naturally decomposes into four sequential phases that mirror the architectural tier structure. The hard constraint is dependency ordering: no phase should begin until the phase below it has clean findings.

### Phase 1: Scope Lock and Audit Setup

**Rationale:** The most dangerous pitfall (conflating Phase 1 vs. Phase 2 scope) strikes before any code is written. CONCERNS.md already contains board-reviewed timelines — this phase formalizes those as an explicit scope document before any audit work starts. Tooling installation goes here so it is done once and confirmed working before the audit begins.
**Delivers:** Explicit Phase 1 / Phase 2 scope map signed off by board; audit tooling installed and verified (`eslint-plugin-sql`, `eslint-plugin-security`, Semgrep, Atlas CLI, `jose`, `c8`); initial ESLint flat config (`eslint.config.js`); Phase-labeled checklist for all SPEC.md sections.
**Addresses:** Anti-feature: "Audit Phase 2+ target architecture as failures"; FEATURES.md anti-feature: "Generate a compliance score or percentage."
**Avoids:** Pitfall 2 (scope conflation); Pitfall 4 (scope creep).

### Phase 2: Tier 0 — Foundations (Schema + Design Principles)

**Rationale:** Every other finding depends on the schema being correct and P1-P6 being applied. A P2 violation found here (enforcement boundary in a prompt, not in infrastructure) may invalidate assumptions in all later phases. Auditing gates before schema is clean produces unreliable results.
**Delivers:** Complete P1-P6 enforcement classification per module (INFRA / ADVISORY / UNVERIFIED); schema integrity report (five schemas confirmed, cross-schema FK count confirmed zero); Semgrep YAML rules for architectural boundary violations; ESLint rules for SQL injection surface.
**Uses:** `eslint-plugin-sql` for P1 SQL scan; `semgrep` for semantic boundary rules; `pg` catalog queries (`information_schema.referential_constraints`) for cross-schema FK check; Atlas CLI for DDL constraint verification.
**Implements:** Tier 0 of audit architecture DAG.
**Avoids:** Anti-pattern 1 (auditing high-level before foundations).

### Phase 3: Tier 1 — Identity and Enforcement (JWT + Constitutional Gates)

**Rationale:** JWT identity must be verified before constitutional gates, because broken identity makes gate findings unreliable (an agent could claim a different tier and bypass a gate entirely). RLS enforcement activation — the highest-risk operation in the entire project — belongs in this phase, with its feature flag and staging gate as mandatory acceptance criteria.
**Delivers:** JWT implementation completeness map against ADR-018 Phase 1 requirements (CURRENT-IMPLEMENTED / CURRENT-PARTIAL / TARGET-FUTURE per item); RLS enforcement activated with feature flag and verified against full pipeline smoke test; G1-G7 completeness report (config + code path + runtime gate-violation test per gate); `guardCheck()` + `transitionState()` atomicity confirmed at all callsites.
**Uses:** `jose` for JWT forge/verify tests; `pg` catalog queries for `pg_policies` and `relrowsecurity` status; Atlas CLI for constraint behavior testing.
**Implements:** Tier 1 of audit architecture DAG.
**Avoids:** Pitfall 1 (premature RLS activation); Pitfall 3 (guard check atomicity breakage); Pitfall 5 (over-engineering to match target architecture).

### Phase 4: Tier 2 — Coordination Correctness (Task Graph + Agent Tiers)

**Rationale:** State machine correctness and agent tier enforcement are only auditable once identity (Tier 1) is trustworthy. A verified identity layer means agent tier claims in work items are reliable. DAG edge integrity checks are meaningful only when the schema (Tier 0) is confirmed correct.
**Delivers:** Task graph state machine report (legal transitions only, DB constraints confirmed, retry counter ≤3 then escalate verified); DAG edge integrity check (no orphans, no cycles); agent tier enforcement report (all 8 agents mapped to correct model, `can_assign_to` lists confirmed explicit with no globs, executor task initiation blocked at code level, not just config); `pg_notify` vs Redis routing confirmed.
**Uses:** `pg` catalog queries and `node:test` integration tests for illegal transition rejection; Semgrep rules for "executor cannot initiate tasks" code boundary; `config/agents.json` comparison against SPEC §2 tier table.
**Implements:** Tier 2 of audit architecture DAG.
**Avoids:** Anti-pattern 4 (treating `agents.json` as sufficient tier enforcement); Pitfall 4 (scope creep during `api.js` inspection).

### Phase 5: Tier 3 — Observability + Phase 1 Exit Map (Hash Chain + §14 Synthesis)

**Rationale:** Hash-chain audit log integrity is verified last because it depends on state transitions being written correctly (Tier 2). The Phase 1 exit criteria gap map is the synthesized output of all prior findings — it cannot be written until every individual check has run and produced a classified finding.
**Delivers:** Full `verify_all_ledger_chains()` run with broken-link count; append-only trigger existence confirmed (`trg_state_transitions_no_update`, `trg_state_transitions_no_delete`); hash chain JS/SQL parity test (cross-implementation verification); complete Phase 1 exit gap map — pass/fail table against all SPEC §14 exit criteria with phase labeling.
**Uses:** `node:crypto` for hash-chain integrity verification; `pg` direct queries for trigger inspection; `merkle-publisher.js` for replay verification.
**Implements:** Tier 3 of audit architecture DAG.
**Avoids:** Pitfall 3 (hash-chain corruption from migration); anti-pattern 2 (static analysis without runtime verification).

### Phase 6: Security Hardening (v1.x — Pre-Railway Deployment)

**Rationale:** After the Phase 1 exit compliance map is complete and findings are addressed, a second pass covers the security surface that is not strictly Phase 1 exit criteria but is required before Railway production deployment. These items are lower complexity but have meaningful security impact.
**Delivers:** Token revocation gap analysis with recommendation (in-memory blocklist cleared on HALT); `permission_grants` over-breadth scan (flag `resource_id = '*'` grants); Linear webhook HMAC fallback classified under P1 with interim remediation (rate limiting + IP allowlist until HMAC validates correctly); completeness check absence documented in task graph as tracked work item.
**Avoids:** Security mistake: "Fixing the Linear HMAC fallback by removing it entirely"; Pitfall: overly broad permission grants introduced during compliance fixes.

### Phase Ordering Rationale

- **Dependency ordering is strict.** The four audit tiers form a DAG, and the research independently converged on the same ordering from two directions (ARCHITECTURE.md bottom-up analysis and FEATURES.md dependency graph). This is not an arbitrary sequence — a failed Tier 0 finding can invalidate Tier 2 results.
- **RLS activation is isolated to Phase 3.** It is the highest-risk operation in the project and must be the only change in its commit, wrapped in a feature flag, and staged before production. Spreading JWT/RLS work across multiple phases increases the risk of partial activation.
- **Security hardening is decoupled from Phase 1 exit.** The Phase 1 exit gate is about SPEC §14 compliance. The security hardening phase addresses real-world deployment risks that are not SPEC §14 items. Mixing them muddies both goals.
- **Scope lock is Phase 1, not a pre-work assumption.** CONCERNS.md is the boundary document, but the board-confirmed scope map must be an explicit deliverable — not an implicit assumption — before any code changes start.

### Research Flags

Phases likely needing deeper research or verification during planning:
- **Phase 3 (JWT/RLS):** RLS activation on a live system with in-flight transactions is complex. The "drain all in-flight work items before activating" requirement (PITFALLS.md) needs a concrete runbook. ADR-018 Phase 1 scope should be re-confirmed with both board members before coding begins — the board decision was 2026-03-07 and scope may have drifted.
- **Phase 5 (Hash Chain):** The hash chain JS/SQL parity test (does `state-machine.js` `computeHashChain()` produce identical output to the SQL `verify_ledger_chain()` function for identical inputs?) requires reading both implementations carefully before writing the test. A format string divergence would cause silent verification failure.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Scope Lock):** Cross-referencing CONCERNS.md against SPEC.md is a reading and documentation task. No new research needed.
- **Phase 2 (Foundations):** ESLint custom rules, Semgrep YAML, and `information_schema` FK queries are well-documented. Patterns are established.
- **Phase 4 (Coordination):** Agent tier config comparison and state machine transition testing are standard patterns with no novel infrastructure.
- **Phase 6 (Security Hardening):** All items are targeted SQL queries or code traces. No novel infrastructure.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core tooling verified via npm registry (April 2026). ESM compatibility for `jose`, `c8`, and ESLint 10 flat config confirmed. Semgrep performance improvements from Sep 2025 confirmed. All tools vetted against existing `"type": "module"` project constraints. |
| Features | HIGH | Audit scope derived directly from codebase analysis (`CONCERNS.md`, ADR-018, `tier1-deterministic.js`, `spec-drift-detector.js`). Existing audit infrastructure is well-documented. Phase boundaries derive from board-reviewed CONCERNS.md timelines. |
| Architecture | HIGH | Four-tier ordering derived from two independent sources: ARCHITECTURE.md bottom-up analysis and FEATURES.md dependency graph. Both arrive at the same sequence. Classification scheme (CURRENT-IMPLEMENTED / CURRENT-PARTIAL / TARGET-FUTURE / CLAIMED-INCOMPLETE) is grounded in actual SPEC §5 language and codebase state. |
| Pitfalls | HIGH | All six critical pitfalls are grounded in specific files and line numbers in the live codebase (`CONCERNS.md`, `agent-jwt.js`, `withAgentScope()`, `state-machine.js`). Not theoretical — each has a concrete "warning signs" list and a recovery strategy. |

**Overall confidence:** HIGH

### Gaps to Address

- **`withAgentScope()` callsite completeness:** PITFALLS.md identifies this as the highest-risk gap but does not enumerate the complete callsite list. During Phase 3 planning, run `grep -rn 'withAgentScope\|db.query' src/` to produce the full list before estimating RLS activation effort.
- **Hash computation field list for `state_transitions`:** PITFALLS.md warns that migration safety depends on knowing which fields are included in the hash computation. Read `merkle-publisher.js` and `infrastructure.js` before Phase 5 planning to confirm the field list.
- **ADR-018 Phase 1 scope drift:** The board decision was 2026-03-07. Before Phase 3 begins, re-confirm with both board members that the Phase 1 JWT/RLS scope documented in ADR-018 has not drifted. PITFALLS.md flags this explicitly.
- **`inbox.drafts` view consumer count:** PITFALLS.md identifies a three-step migration (migrate consumers, verify zero references, drop view). The consumer list (API routes, dashboard pages, CLI scripts) should be enumerated during Phase 2 or 3 planning to scope the migration effort.
- **Content sanitization implementation status:** ARCHITECTURE.md classifies content sanitization as `UNVERIFIED` — no clear reference in the codebase map. This should be located and classified before Phase 2 begins.

---

## Sources

### Primary (HIGH confidence)
- SPEC.md v0.7.0 (canonical architecture specification, `autobot-spec/SPEC.md`)
- `.planning/codebase/CONCERNS.md` — tech debt, known gaps, board-reviewed timelines
- `.planning/codebase/ARCHITECTURE.md` — system layers, data flow, state management
- `autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md` — Phase 1 vs Phase 2 JWT/RLS scope
- `autobot-inbox/docs/internal/adrs/006-append-only-audit-trail.md` — hash chain design
- npm registry (live, April 2026) — version verification for `eslint@10.1.0`, `jose@6.2.2`, `eslint-plugin-sql@3.4.1`, `eslint-plugin-security@4.0.0`, `c8@11.0.0`
- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — `pg_class.relrowsecurity`, `pg_policies` catalog queries confirmed
- [Atlas schema testing docs](https://atlasgo.io/testing/schema) — `atlas schema test` for constraint/FK/trigger testing in Postgres
- [jose GitHub](https://github.com/panva/jose) — ESM-native, actively maintained

### Secondary (MEDIUM confidence)
- [Semgrep September 2025 release notes](https://semgrep.dev/docs/release-notes/september-2025) — 3x performance improvement, native Windows support
- [Testing RLS with Atlas](https://atlasgo.io/faq/testing-rls) — non-superuser testing requirement
- [WorkOS: Architecture of governable AI agents](https://workos.com/blog/ai-agents-architecture) — JWT intent binding patterns
- [Refactoring Databases Is a Different Animal](https://newsletter.systemdesignclassroom.com/p/refactoring-databases-is-a-different-animal) — Expand/Contract pattern for schema refactoring risks
- [AI Governance: Infrastructure vs Prompt-Based Controls](https://air-governance-framework.finos.org/mitigations/mi-16_preserving-source-data-access-controls-in-ai-systems.html) — infrastructure enforcement reliability (aligns with P2)

### Tertiary (LOW confidence)
- [AuditableLLM: Hash-Chain-Backed Compliance Framework](https://www.mdpi.com/2079-9292/15/1/56) — hash-chain patterns in LLM audit systems (single source)
- [DEV Community: Why delete jsonwebtoken in 2025](https://dev.to/silentwatcher_95/why-you-should-delete-jsonwebtoken-in-2025-1o7n) — `jose` preference over `jsonwebtoken` (single source, aligns with jose trajectory)
- [CertiK: Auditing with Finite State Machines](https://www.certik.com/resources/blog/auditing-with-finite-state-machines-a-complementary-methodology) — FSM audit patterns (external, needs validation against this specific system)

---
*Research completed: 2026-04-01*
*Ready for roadmap: yes*

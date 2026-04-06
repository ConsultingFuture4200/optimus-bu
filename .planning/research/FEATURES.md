# Feature Research

**Domain:** Spec compliance audit for a governed agent organization (Optimus / autobot-inbox)
**Researched:** 2026-04-01
**Confidence:** HIGH — codebase examined directly; existing audit infrastructure observed in detail; findings cross-checked against SPEC.md requirements documented in CLAUDE.md, CONCERNS.md, and ARCHITECTURE.md

---

## Context: What Makes This Audit Distinct

This is not a generic software quality audit. It is a **spec-compliance audit** for a system where:

- The spec (SPEC.md v0.7.0) is the **authority** — code is wrong when spec and code diverge
- Design principles P1-P6 are **non-negotiable** and cited by number in architectural decisions
- Constitutional gates G1-G7 are **infrastructure-enforced** (P2), not prompt-guided
- The system has a **partially-implemented** target architecture (§5): JWT identity and RLS exist as code but enforcement is incomplete (ADR-018, CONCERNS.md)
- The audit must produce **actionable compliance gap records**, not just a report

The feature categories below are organized around this audit's core question: does every spec claim map to a verifiable implementation state?

---

## Feature Landscape

### Table Stakes (Users Expect These)

Audit is incomplete without these. Each maps to a specific SPEC.md section or design principle.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Design principle P1-P6 sweep | Every architectural decision must cite a principle; the audit must verify enforcement boundaries are in infrastructure, not prompts | MEDIUM | Check guard-check.js, state-machine.js, DB constraints. P2 and P4 have the most code implications. |
| Agent tier enforcement check (§2) | Spec defines 5 tiers (Strategist/Opus, Architect/Sonnet, Orchestrator/Sonnet, Reviewer/Sonnet, Executor/Haiku). Wrong model assignments = spec violation | LOW | Cross-reference agents.json model fields against §2 tier table. All 8 agents must map to a valid spec tier. |
| Agent capability constraint verification (§2) | Each tier has explicit capability limits (e.g., Strategist cannot deploy; Orchestrator has explicit can_assign_to list). These must be enforced in agents.json and code, not just documented | MEDIUM | Verify: Strategist agents have no deploy tools; Orchestrator has explicit can_assign_to (not glob); Executors cannot initiate tasks |
| Task graph state machine audit (§3) | Work items must transition only through the legal state sequence: created → assigned → in_progress → review → completed. Terminal states: completed, cancelled. Illegal transitions should be blocked by DB constraints | MEDIUM | Inspect state-machine.js and DB CHECK constraints in 001-baseline.sql. Verify that each transition is gated by transitionState() + guardCheck() atomically. |
| DAG edge and retry/escalation verification (§3) | Failed tasks must retry up to 3 times, then escalate. The DAG edge structure (depends_on) must be enforced. Orphaned or cyclic edges indicate spec violations | MEDIUM | Query agent_graph.edges for orphans. Check reaper.js retry counter logic against spec limit. |
| Guardrail G1-G7 completeness check (§5) | All 7 constitutional gates must exist in gates.json AND have active enforcement code paths in guard-check.js. Missing gates = silent governance gap | LOW | spec-drift-detector.js already does a surface check; the audit must verify each gate has both config AND a code path that executes atomically with transition_state(). |
| guardCheck() + transition_state() atomicity audit (§5) | The spec requires guardrail checks to execute as a single atomic Postgres transaction. If this coupling is broken anywhere, agents can bypass gates | HIGH | Verify every call site in agent-loop.js that performs a state transition also passes a transaction client to guardCheck(). Manual code trace required. |
| Hash chain integrity verification (P3, ADR-006) | append-only state_transitions table uses SHA-256 hash chains. Broken links = tamper evidence. Must verify: triggers prevent mutation, hash computation matches between JS and SQL, verify_ledger_chain() passes for all recent work items | MEDIUM | tier1-deterministic.js already runs hourly; audit must run full verify_all_ledger_chains() and report broken count. Also verify the trigger definitions exist in 001-baseline.sql. |
| Cross-schema isolation check (§12, CLAUDE.md) | "No cross-schema foreign keys" is an explicit constraint (SPEC §12, code convention). Five schemas: agent_graph, inbox, voice, signal, content. Any FK crossing schema boundaries is a violation | LOW | Query information_schema.referential_constraints and information_schema.key_column_usage to find cross-schema FKs. Should be zero. |
| JWT implementation completeness (§5, ADR-018) | ADR-018 (accepted 2026-03-07) reversed JWT deferral. JWT issuer + signing + verification are complete; RLS enforcement is partial (CONCERNS.md). Audit must map: what is done vs. what spec requires | HIGH | Check: initializeJwtKeys(), issueToken(), verifyToken() exist and work; withAgentScope() validates JWT before set_config; RLS policies are active (not just defined); state_transitions.agent_id is JWT-bound |
| pg_notify event system presence (P4) | Spec requires Postgres-native event bus (pg_notify), not an external queue. Audit must confirm no Redis or external queue is in the critical coordination path | LOW | event-bus.js should use pg_notify. Redis is present (ioredis dependency) — verify it is used only for caching (board workstation), not agent coordination. |
| Audit log append-only trigger verification (P3) | state_transitions and edit_deltas must have active triggers preventing UPDATE and DELETE. ADR-006 documents them. The audit must confirm they exist and fire as expected | LOW | Query information_schema.triggers for trg_state_transitions_no_update and trg_state_transitions_no_delete. Run a test UPDATE and verify it raises an exception. |
| Spec drift surface check | spec-drift-detector.js runs daily and checks §3 task graph tables, §5 guardrail completeness, §9 kill switch, §14 phase metrics. Audit must verify this detector itself is active and has fired recently | LOW | Query agent_graph.task_events for recent spec-drift runs. Verify the detector covers the four sections it claims to cover. |
| Phase 1 exit criteria gap map (§14) | SPEC §14 defines Phase 1 exit criteria. The audit must produce a complete map: which exit criteria are met, which are partially met, which are missing | MEDIUM | Cross-reference PROJECT.md "Active" requirements against the spec §14 exit criteria list. Output must be a clear pass/fail table. |

### Differentiators (Deeper Analysis That Adds Value)

These go beyond pass/fail to produce governance-grade evidence.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Autonomy level enforcement audit (§4, CLAUDE.md) | AUTONOMY_LEVEL env var (0/1/2) should control which agent actions require approval. The graduated autonomy model (L0/L1/L2) has specific exit conditions. Audit should verify: current level is correct for the trust data; config reflects the level; autonomy-controller.js enforces it | MEDIUM | autonomy-controller.js and autonomy-evaluator.js implement this. Cross-check current metrics (approval rate, edit rate, days running) against L0 exit conditions: 50+ drafts, <10% edit rate, 14 days. |
| Prompt-to-code fidelity check for agent tier constraints | agent-loop.js is supposed to enforce tier boundaries in code (P2). But agent handlers also receive system prompts that describe constraints. Audit should flag any case where a constraint exists only in a prompt and not in the infrastructure layer | HIGH | This requires tracing each agent's claimed constraints through to code-level enforcement. Example: "Executor cannot initiate tasks" — verify there is no code path in any executor allowing work_item creation without going through orchestrator. |
| Token revocation gap analysis (ADR-018, CONCERNS.md) | JWT tokens are 15-minute TTL with no revocation list. A killed/compromised agent retains a valid token until expiry. CONCERNS.md marks this as a known gap. Audit should quantify the exposure window and recommend minimum: in-memory blocklist cleared on HALT | LOW | agent-jwt.js inspection. Verify: is there any revocation mechanism? Does HALT signal invalidate outstanding tokens? |
| Completeness check absence documentation (CONCERNS.md) | The LLM-based output completeness validator was removed (governance theater). Replacement not implemented. Audit should document which executors produce unvalidated outputs and what the acceptance criteria field looks like in practice | MEDIUM | agent-loop.js line ~465 has the removed check. Inspect work_items.acceptance_criteria values in DB for recent tasks. |
| Permission grants over-breadth scan | CONCERNS.md notes risk of overly broad permission grants (wildcards on resource_id). Audit should query agent_graph.permission_grants for any resource_id = '*' grants and flag executors with write permissions they shouldn't need | LOW | Simple SQL query against permission_grants table. |
| Linear webhook HMAC gap (CONCERNS.md) | Webhook acceptance falls back to header-only check (easily spoofed) when HMAC fails. Audit should classify this as a P1 (deny by default) violation since the system is accepting unverified payloads | LOW | api.js lines ~957-968. Document the fallback logic and classify severity under P1. |
| Behavioral drift detection review | tier2-ai-auditor.js performs behavioral drift detection using Sonnet. Audit should verify: the detector runs daily, findings are persisted to audit_findings, and any critical finding would trigger a HALT in Phase 3 mode | LOW | Review tier2-ai-auditor.js trigger logic and audit_findings table. Confirm Phase 3 HALT trigger is correctly gated on isPhase3Active(). |
| Adversarial sanitization test coverage (§5) | adversarial-test-suite.js tests the content sanitizer against 200+ attack payloads (prompt injection, role-play, data exfiltration). Audit should verify: test suite runs, pass rate is tracked, any new failure since last run is surfaced | MEDIUM | Run the test suite and compare results against last audit run. Focus on false-positive rate (benign inputs being redacted). |
| Config drift check (exploration domain) | config-drift.js in the exploration domains detects when deployed config diverges from the committed config. Audit should verify this domain runs and produces actionable findings | LOW | Confirm config-drift.js is wired into the exploration monitor and fires on a schedule. |
| Dead-man-switch liveness check (§9) | spec-drift-detector.js checks that a dead_man_switch event fired in the last 48h. Audit should verify: the DMS fires reliably, what happens if it misses a cycle, and whether the board would be notified | LOW | dead-man-switch.js. Query agent_graph.task_events for DMS events over the last 7 days. |
| Audit tier scheduling integrity | Three audit tiers: Tier 1 every agent cycle, Tier 2 daily, Tier 3 every 48h with Opus. Audit should verify all three are scheduled and ran within their expected windows | LOW | Query agent_graph.audit_findings for last run timestamps per tier. |
| Hash chain JS/SQL parity test | ADR-006 notes a coupling risk: computeHashChain() in state-machine.js and the SQL fallback in transition_state() must produce identical hashes for the same inputs. A format string divergence would cause silent verification failures | MEDIUM | Write a test that inserts a transition via JS code path and verifies the hash using the SQL verify_ledger_chain() function. Compare results. |
| Schema count documentation accuracy | spec-alignment.js (exploration domain) checks whether CLAUDE.md's claimed schema count matches information_schema. Audit should verify this check runs and report the actual vs. claimed count | LOW | Already partially implemented in spec-alignment.js. Run and capture output. |

### Anti-Features (Things to Deliberately NOT Do in This Audit)

| Anti-Feature | Why Requested | Why Problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Rewrite working code for style compliance | SPEC.md has strong opinions on code patterns; reviewers may want to standardize everything | Violates project constraint: "Only fix spec violations — no rewrites for style preferences" | Flag style divergences as informational findings. Do not include in compliance gap count. |
| Audit Phase 2+ target architecture as failures | The spec has a "currently implemented" vs. "target architecture" distinction (§5). Per-agent DB roles, external JWT verification, and token revocation are explicitly Phase 2 | Treating Phase 2 items as Phase 1 failures inflates gap count and misleads board | Clearly label each finding with its phase. Phase 2 items get a "deferred, by design" status. |
| External integration testing | Testing that Gmail API, Linear webhooks, Slack, etc. function correctly is operational testing, not spec compliance | Misaligned with audit scope; flaky due to external dependencies; a different discipline entirely | Mark external integrations as "out of scope." Note known bugs (Gmail refresh token expiry) as operational concerns. |
| Generate a compliance score or percentage | Reduces nuanced gap severity to a single number; can be gamed; invites false confidence | A "92% compliant" system with one critical JWT enforcement gap is dangerous | Produce a severity-tiered gap table. Let the board judge risk. Do not aggregate into a score. |
| Automated fixes without board review for security boundaries | The audit framework could in theory auto-fix minor gaps (e.g., re-enable a trigger). For anything touching P1/P2 enforcement boundaries, this is dangerous | CLAUDE.md and ADR-002 require board review for security boundary decisions | Audit produces findings and recommendations. Fixes are committed separately, each atomically (per PROJECT.md constraint). |
| Deep LLM-based semantic analysis of every agent prompt | tier2-ai-auditor.js already does prompt alignment analysis daily. Running this again as part of the audit would be expensive and redundant | Costs $50-80/month per full run; duplicates existing infrastructure | Reference the last tier2 run results rather than re-running. Flag if tier2 results are stale (>48h). |
| Testing the voice profile embedding quality | Voice profiles (G3 tone matching) are a product quality concern, not a spec compliance concern. The audit checks whether G3 enforcement exists and fires; it does not evaluate whether the threshold (0.80) is the right value | Feature creep; voice profile quality is a Phase 1.5+ concern per SPEC | Note the VOICE_TONE_THRESHOLD hardcoding as a minor finding (not configurable). Do not evaluate embedding quality. |

---

## Feature Dependencies

```
[Phase 1 Exit Criteria Gap Map]
    └──requires──> [Design Principle P1-P6 Sweep]
    └──requires──> [Agent Tier Enforcement Check]
    └──requires──> [Task Graph State Machine Audit]
    └──requires──> [Guardrail G1-G7 Completeness Check]
    └──requires──> [JWT Implementation Completeness]
    └──requires──> [Hash Chain Integrity Verification]
    └──requires──> [Cross-Schema Isolation Check]

[guardCheck() + transition_state() Atomicity Audit]
    └──requires──> [Task Graph State Machine Audit]
    └──enhances──> [Guardrail G1-G7 Completeness Check]

[JWT Implementation Completeness]
    └──reveals──> [Token Revocation Gap Analysis]
    └──reveals──> [RLS Enforcement Status]

[Hash Chain Integrity Verification]
    └──requires──> [Audit Log Append-Only Trigger Verification]
    └──enhances──> [Hash Chain JS/SQL Parity Test]

[Spec Drift Surface Check]
    └──validates──> [Audit Tier Scheduling Integrity]
    └──validates──> [Dead-Man-Switch Liveness Check]

[Prompt-to-Code Fidelity Check]
    └──requires──> [Agent Tier Enforcement Check]
    └──requires──> [Agent Capability Constraint Verification]

[Completeness Check Absence Documentation]
    └──conflicts with──> [Adversarial Sanitization Test Coverage]
    (one is about output quality gates; the other is about input sanitization — distinct concerns)

[Permission Grants Over-Breadth Scan]
    └──enhances──> [Agent Capability Constraint Verification]
```

### Dependency Notes

- **Phase 1 Exit Criteria Gap Map requires all table stakes features:** The exit criteria map is the synthesized output — it cannot be written until each individual check has run.
- **guardCheck() atomicity requires task graph audit:** You cannot verify gate enforcement without first confirming the state machine itself follows the spec.
- **JWT completeness reveals downstream gaps:** Once the JWT audit reveals what is and isn't enforced, the token revocation analysis and RLS status naturally follow.
- **Hash chain integrity requires trigger verification:** If the triggers don't exist, the hash chain check will fail for a wrong reason — trigger absence must be checked first.
- **Prompt-to-code fidelity is the highest complexity feature:** It requires tracing each agent's system prompt constraints through to code-level enforcement. Do last, when the tier and capability checks are already complete.

---

## MVP Definition

### Audit Complete With (v1 — Phase 1 Exit Criteria)

Minimum verifiable compliance evidence for Phase 1 exit board review.

- [x] Design principle P1-P6 sweep — every principle must have at least one verifiable enforcement point
- [x] Agent tier and model assignment verification — all 8 agents mapped to correct spec tier and model
- [x] Agent capability constraint verification — can_assign_to lists, tool allow-lists confirmed
- [x] Task graph state machine legal transition check — illegal transitions blocked by DB constraints
- [x] Guardrail G1-G7 completeness — all gates defined in config AND have code enforcement paths
- [x] guardCheck() + transition_state() atomicity — all call sites verified
- [x] Hash chain integrity — full verify_all_ledger_chains() run, trigger existence confirmed
- [x] Cross-schema isolation — zero cross-schema FKs confirmed
- [x] JWT implementation completeness — implementation state mapped against ADR-018 requirements
- [x] pg_notify vs Redis routing — event coordination confirmed not on Redis
- [x] Phase 1 exit criteria gap map — full pass/fail table against SPEC §14

### Add After v1 (v1.x — Security Hardening)

Features to address once core compliance map exists.

- [ ] Token revocation gap analysis — quantify exposure window, recommend in-memory blocklist
- [ ] Permission grants over-breadth scan — flag resource_id wildcards
- [ ] Linear webhook HMAC gap classification — classify under P1 with remediation path
- [ ] Hash chain JS/SQL parity test — write and run the cross-implementation verification test
- [ ] Completeness check absence documentation — document which executors have unvalidated outputs

### Future Consideration (v2+ — Deeper Behavioral Audit)

Defer until Phase 2 work begins.

- [ ] Prompt-to-code fidelity deep trace — deferred; depends on Phase 2 per-agent role work
- [ ] Behavioral drift detection review — already handled by tier2-ai-auditor.js running daily
- [ ] Autonomy level enforcement audit — relevant once the system considers L0 exit
- [ ] Adversarial sanitization test coverage — valuable but not a Phase 1 blocker
- [ ] Audit tier scheduling integrity — operational health monitoring, not compliance

---

## Feature Prioritization Matrix

| Feature | Compliance Value | Implementation Cost | Priority |
|---------|-----------------|---------------------|----------|
| Phase 1 exit criteria gap map | HIGH | LOW (synthesis of other checks) | P1 |
| Design principle P1-P6 sweep | HIGH | MEDIUM | P1 |
| Agent tier enforcement check | HIGH | LOW | P1 |
| Agent capability constraint verification | HIGH | MEDIUM | P1 |
| Task graph state machine audit | HIGH | MEDIUM | P1 |
| Guardrail G1-G7 completeness | HIGH | LOW | P1 |
| guardCheck() + transition_state() atomicity | HIGH | HIGH | P1 |
| Hash chain integrity verification | HIGH | LOW | P1 |
| Cross-schema isolation check | HIGH | LOW | P1 |
| JWT implementation completeness | HIGH | HIGH | P1 |
| pg_notify vs Redis event routing | MEDIUM | LOW | P1 |
| Audit log trigger verification | MEDIUM | LOW | P1 |
| Spec drift surface check | MEDIUM | LOW | P1 |
| Token revocation gap analysis | MEDIUM | LOW | P2 |
| Linear webhook HMAC gap classification | MEDIUM | LOW | P2 |
| Permission grants over-breadth scan | MEDIUM | LOW | P2 |
| Hash chain JS/SQL parity test | MEDIUM | MEDIUM | P2 |
| Completeness check absence documentation | MEDIUM | LOW | P2 |
| Autonomy level enforcement audit | LOW | MEDIUM | P3 |
| Prompt-to-code fidelity check | LOW | HIGH | P3 |
| Behavioral drift detection review | LOW | LOW | P3 |
| Adversarial sanitization test coverage | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Required for Phase 1 exit board review
- P2: Required before Railway production deployment
- P3: Phase 1.5+ / ongoing governance health monitoring

---

## What Already Exists (Do Not Re-Implement)

The codebase already has substantial audit infrastructure. The compliance audit should **use and extend** these, not replace them:

| Existing Component | What It Does | Audit Should |
|--------------------|--------------|--------------|
| `tier1-deterministic.js` | Hourly: hash chain, budget, halt signals, stuck tasks, config hashes | Run on-demand and capture full output |
| `tier2-ai-auditor.js` | Daily: behavioral drift, guardrail health, cost anomalies, prompt alignment (Sonnet) | Read last run findings; do not re-run |
| `tier3-cross-model.js` | 48h: cross-model consistency (requires Opus) | Read last run; check if Phase 3 is active |
| `spec-drift-detector.js` | Daily: §3 tables, §5 gates, §9 kill switch, §14 metrics | Run and capture; verify all 4 checks fire |
| `spec-alignment.js` (exploration) | On-demand: agent tier config vs SPEC.md, schema count | Run and capture findings |
| `capability-gates.js` | Measures G1-G5 gate thresholds for Phase 3 activation | Query gate_snapshots for current status |
| `adversarial-test-suite.js` | 200+ sanitizer attack payloads | Run and compare against last known baseline |

---

## Sources

- SPEC.md v0.7.0 (canonical architecture specification, cited via CLAUDE.md)
- `autobot-inbox/src/audit/tier1-deterministic.js` — existing Tier 1 audit implementation
- `autobot-inbox/src/audit/tier2-ai-auditor.js` — existing Tier 2 audit implementation
- `autobot-inbox/src/runtime/spec-drift-detector.js` — existing spec drift detection
- `autobot-inbox/src/runtime/guard-check.js` — G1-G7 constitutional gate enforcement
- `autobot-inbox/src/runtime/capability-gates.js` — Phase 3 capability gate measurement
- `autobot-inbox/src/runtime/adversarial-test-suite.js` — sanitizer red-team suite
- `autobot-inbox/src/runtime/exploration/domains/spec-alignment.js` — exploration domain
- `autobot-inbox/docs/internal/adrs/006-append-only-audit-trail.md` — hash chain ADR
- `autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md` — JWT mandate ADR
- `.planning/codebase/CONCERNS.md` — tech debt and security gaps catalog
- `.planning/codebase/ARCHITECTURE.md` — system layer analysis
- [AuditableLLM: Hash-Chain-Backed Compliance Framework](https://www.mdpi.com/2079-9292/15/1/56) — LOW confidence (external reference, context for hash-chain patterns)
- [Agentic AI Governance: Strategic Framework](https://www.ewsolutions.com/agentic-ai-governance/) — LOW confidence (external reference, governance framing)
- [Auditing with Finite State Machines — CertiK](https://www.certik.com/resources/blog/auditing-with-finite-state-machines-a-complementary-methodology) — LOW confidence (external reference, FSM audit patterns)
- [Multi-tenant PostgreSQL RLS — AWS Database Blog](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) — MEDIUM confidence (official AWS documentation)

---

*Feature research for: Optimus Spec Compliance Audit — governed agent organization*
*Researched: 2026-04-01*

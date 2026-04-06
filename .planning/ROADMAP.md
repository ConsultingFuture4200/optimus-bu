# Roadmap: Optimus Spec Compliance Audit

## Overview

This roadmap drives a systematic bottom-up audit of the Optimus codebase against SPEC.md v0.7.0. Phases follow the architectural tier dependency order required by the audit: scope must be locked before any code is touched, foundations must be clean before enforcement layers are audited, enforcement must be verified before coordination logic is trusted, and synthesis only becomes meaningful once all lower tiers have clean findings. Six phases deliver a complete Phase 1 exit gap map with every spec claim either verified as implemented or explicitly classified as a future phase.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Scope Lock** - Formalize Phase 1 vs Phase 2 scope boundary before any code changes
- [ ] **Phase 2: Foundations** - Verify design principles P1-P6 and schema integrity (Tier 0)
- [ ] **Phase 3: Identity and Enforcement** - Audit JWT agent identity and constitutional gates G1-G7 (Tier 1)
- [ ] **Phase 4: Coordination Correctness** - Audit task graph state machine and agent tier enforcement (Tier 2)
- [ ] **Phase 5: Integrity and Observability** - Verify hash-chain audit log integrity (Tier 3)
- [ ] **Phase 6: Compliance Synthesis** - Produce Phase 1 exit gap map and close all identified violations

## Phase Details

### Phase 1: Scope Lock
**Goal**: Phase 1 vs Phase 2 scope boundary is explicitly documented and board-confirmed before any compliance fix is written
**Depends on**: Nothing (first phase)
**Requirements**: FOUN-05
**Success Criteria** (what must be TRUE):
  1. A scope document exists that classifies every SPEC.md section as Phase 1 or Phase 2 — no section is unclassified
  2. CONCERNS.md entries and ADR-018 decisions are reconciled into the scope document with no contradictions
  3. The scope document exists as a committed artifact that can be cited in any future compliance fix commit
  4. No code changes have been made before this phase completes
**Plans:** 1 plan
Plans:
- [ ] 01-01-PLAN.md — Write SCOPE-LOCK.md and open board confirmation PR

### Phase 2: Foundations
**Goal**: Design principles P1-P6 each have at least one verifiable infrastructure enforcement point, and schema integrity is confirmed clean
**Depends on**: Phase 1
**Requirements**: FOUN-01, FOUN-02, FOUN-03, FOUN-04
**Success Criteria** (what must be TRUE):
  1. Each of P1-P6 maps to at least one enforcement point in code or DB schema — no principle is enforced only by a prompt
  2. Zero cross-schema foreign keys exist across all five schemas (agent_graph, inbox, voice, signal, content) — confirmed via information_schema query
  3. pg_notify is confirmed as the only agent coordination event bus — no Redis coordination paths exist in src/
  4. Append-only triggers on state_transitions and edit_deltas are confirmed active — an UPDATE or DELETE against either table is rejected by the DB
**Plans**: TBD

### Phase 3: Identity and Enforcement
**Goal**: JWT agent identity is fully mapped against ADR-018 Phase 1 requirements, and all seven constitutional gates have confirmed active enforcement paths
**Depends on**: Phase 2
**Requirements**: GUAR-01, GUAR-02, GUAR-03, GUAR-04, GUAR-05
**Success Criteria** (what must be TRUE):
  1. All seven constitutional gates (G1-G7) are present in gates.json and each has an active code path in guard-check.js that fires when the gate condition is met
  2. Every state transition call site in agent-loop.js passes a transaction client to guardCheck() — no callsite executes guard and transition in separate transactions
  3. JWT functions (initializeJwtKeys, issueToken, verifyToken) exist and produce valid tokens that can be round-tripped
  4. withAgentScope() validates a JWT signature before setting app.agent_id — a tampered or missing token is rejected
  5. RLS policy enforcement status is mapped against ADR-018 — each policy is classified as active or explicitly deferred to Phase 2
**Plans**: TBD
**UI hint**: no

### Phase 4: Coordination Correctness
**Goal**: Task graph state machine transitions are enforced at the DB level, agent tier assignments match SPEC §2, and coordination routing uses pg_notify not Redis
**Depends on**: Phase 3
**Requirements**: AGOV-01, AGOV-02, AGOV-03, AGOV-04, TASK-01, TASK-02, TASK-03, TASK-04
**Success Criteria** (what must be TRUE):
  1. All agents in agents.json map to a valid SPEC §2 tier with the correct model (Strategist/Opus, Architect/Sonnet, Orchestrator/Sonnet, Reviewer/Sonnet, Executor/Haiku) — zero mismatches
  2. Orchestrator agents each have an explicit can_assign_to list — no glob patterns exist
  3. Executor agents have no code path to create work items without going through an orchestrator — the code-level block is confirmed, not just config-level
  4. Strategist agents have no deploy or infrastructure-modification tools registered
  5. Illegal state transitions (e.g., created → completed, in_progress → assigned) are rejected by DB constraints — confirmed by attempting the transition against a test row
  6. Failed tasks retry exactly 3 times then escalate — the retry counter ceiling and escalation path in reaper.js are confirmed
  7. DAG edges contain no orphans or cycles — confirmed via graph traversal query on agent_graph.edges
**Plans**: TBD

### Phase 5: Integrity and Observability
**Goal**: Hash-chain audit log integrity is fully verified across all recent work items, and append-only guarantees are confirmed active
**Depends on**: Phase 4
**Requirements**: INTG-01, INTG-02, INTG-03, INTG-04
**Success Criteria** (what must be TRUE):
  1. verify_all_ledger_chains() runs to completion with zero broken hash links on all recent work items
  2. Hash chain computation in state-machine.js and the SQL verify_ledger_chain() function produce identical output for identical inputs — confirmed by a parity test with known values
  3. spec-drift-detector.js is active and has a verifiable execution record within its expected schedule window
  4. All three audit tiers (Tier 1 hourly, Tier 2 daily, Tier 3 48h) have run within their expected time windows — confirmed from execution logs
**Plans**: TBD

### Phase 6: Compliance Synthesis
**Goal**: Every SPEC.md claim is either verified as implemented or explicitly classified as a future phase — no silent gaps remain
**Depends on**: Phase 5
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04
**Success Criteria** (what must be TRUE):
  1. A Phase 1 exit criteria gap map exists as a committed document — a complete pass/fail table against every SPEC §14 exit criterion
  2. Every finding in the gap map carries exactly one classification: CURRENT-IMPLEMENTED, CURRENT-PARTIAL, TARGET-FUTURE, or CLAIMED-INCOMPLETE — no finding is unclassified
  3. All spec violations identified across Phases 1-5 have atomic fix commits, each referencing the relevant SPEC section
  4. Documentation (docs/internal/ and docs/external/) accurately reflects the actual implementation state — no claims in docs contradict what the gap map found
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Scope Lock | 0/1 | Planning complete | - |
| 2. Foundations | 0/? | Not started | - |
| 3. Identity and Enforcement | 0/? | Not started | - |
| 4. Coordination Correctness | 0/? | Not started | - |
| 5. Integrity and Observability | 0/? | Not started | - |
| 6. Compliance Synthesis | 0/? | Not started | - |

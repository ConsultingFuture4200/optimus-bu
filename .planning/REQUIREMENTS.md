# Requirements: Optimus Spec Compliance Audit

**Defined:** 2026-04-01
**Core Value:** Every claim in SPEC.md is either implemented in code or explicitly marked as a future phase — no silent gaps.

## v1 Requirements

Requirements for Phase 1 exit board review. Each maps to roadmap phases.

### Foundations

- [ ] **FOUN-01**: Design principles P1-P6 each have at least one verifiable infrastructure enforcement point
- [ ] **FOUN-02**: Cross-schema foreign key count is zero across all five schemas (agent_graph, inbox, voice, signal, content)
- [ ] **FOUN-03**: pg_notify is the coordination event bus — Redis is used only for caching, not agent coordination
- [ ] **FOUN-04**: state_transitions and edit_deltas have active triggers preventing UPDATE and DELETE
- [ ] **FOUN-05**: Phase 1 vs Phase 2 scope boundary is formalized from CONCERNS.md and ADR-018 before any code changes

### Agent Governance

- [ ] **AGOV-01**: All agents in agents.json map to a valid SPEC §2 tier with correct model assignment (Strategist/Opus, Architect/Sonnet, Orchestrator/Sonnet, Reviewer/Sonnet, Executor/Haiku)
- [ ] **AGOV-02**: Orchestrator agents have explicit can_assign_to lists (no globs)
- [ ] **AGOV-03**: Executor agents cannot initiate tasks — no code path allows work_item creation without orchestrator
- [ ] **AGOV-04**: Strategist agents have no deploy or infrastructure-modification tools

### Task Graph

- [ ] **TASK-01**: Work item state transitions follow the legal sequence: created → assigned → in_progress → review → completed, with terminal states completed and cancelled
- [ ] **TASK-02**: Illegal state transitions are blocked by DB constraints, not just application code
- [ ] **TASK-03**: Failed tasks retry up to 3 times, then escalate — verified in reaper.js
- [ ] **TASK-04**: DAG edges have no orphans or cycles in agent_graph.edges

### Guardrails

- [ ] **GUAR-01**: All 7 constitutional gates (G1-G7) exist in gates.json AND have active enforcement code paths in guard-check.js
- [ ] **GUAR-02**: Every state transition call site in agent-loop.js passes a transaction client to guardCheck(), ensuring atomic execution with transition_state()
- [ ] **GUAR-03**: JWT issuer, signing, and verification functions exist and work (initializeJwtKeys, issueToken, verifyToken)
- [ ] **GUAR-04**: withAgentScope() validates JWT signature before setting app.agent_id via set_config
- [ ] **GUAR-05**: RLS policies are active (not just defined) on agent-scoped tables — enforcement status mapped against ADR-018

### Integrity

- [ ] **INTG-01**: Full verify_all_ledger_chains() passes for all recent work items — zero broken hash links
- [ ] **INTG-02**: Hash chain computation in state-machine.js matches the SQL verify_ledger_chain() function
- [ ] **INTG-03**: spec-drift-detector.js is active and has fired within its expected schedule
- [ ] **INTG-04**: All three audit tiers (Tier 1 hourly, Tier 2 daily, Tier 3 48h) ran within expected windows

### Compliance Synthesis

- [ ] **COMP-01**: Phase 1 exit criteria gap map produced — full pass/fail table against SPEC §14
- [ ] **COMP-02**: Every finding classified as CURRENT-IMPLEMENTED, CURRENT-PARTIAL, TARGET-FUTURE, or CLAIMED-INCOMPLETE
- [ ] **COMP-03**: All identified spec violations have been fixed with atomic commits referencing the relevant SPEC section
- [ ] **COMP-04**: Documentation updated to reflect actual implementation state accurately

## v2 Requirements

Deferred to security hardening pass (v1.x). Tracked but not in current roadmap.

### Security Hardening

- **SECR-01**: Token revocation gap quantified — exposure window documented, in-memory blocklist recommended
- **SECR-02**: Permission grants scanned for resource_id wildcards — over-broad grants flagged
- **SECR-03**: Linear webhook HMAC fallback classified as P1 violation with remediation path
- **SECR-04**: Hash chain JS/SQL parity test written and passing — cross-implementation verification
- **SECR-05**: Completeness check absence documented — which executors produce unvalidated outputs

### Behavioral Audit

- **BEHV-01**: Prompt-to-code fidelity deep trace — every agent constraint traced to code enforcement
- **BEHV-02**: Autonomy level enforcement verified against L0 exit conditions
- **BEHV-03**: Adversarial sanitization test suite run and compared against baseline

## Out of Scope

| Feature | Reason |
|---------|--------|
| External integration testing (Gmail, Linear, Slack) | Operational testing, not spec compliance — different discipline |
| Compliance score/percentage | Reduces nuanced severity to gameable number — severity-tiered gap table instead |
| Voice profile embedding quality evaluation | Product quality concern, not spec compliance — audit checks G3 enforcement exists |
| Code style standardization | Project constraint: only fix spec violations, not style preferences |
| Phase 2+ target architecture as failures | Per ADR-018, items like per-agent DB roles and token revocation are explicitly Phase 2 |
| Re-running tier2-ai-auditor.js | Already runs daily — reference last run results instead |
| Auto-fixing security boundaries without board review | CLAUDE.md and ADR-002 require board review for security boundary decisions |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUN-05 | Phase 1 | Pending |
| FOUN-01 | Phase 2 | Pending |
| FOUN-02 | Phase 2 | Pending |
| FOUN-03 | Phase 2 | Pending |
| FOUN-04 | Phase 2 | Pending |
| GUAR-01 | Phase 3 | Pending |
| GUAR-02 | Phase 3 | Pending |
| GUAR-03 | Phase 3 | Pending |
| GUAR-04 | Phase 3 | Pending |
| GUAR-05 | Phase 3 | Pending |
| AGOV-01 | Phase 4 | Pending |
| AGOV-02 | Phase 4 | Pending |
| AGOV-03 | Phase 4 | Pending |
| AGOV-04 | Phase 4 | Pending |
| TASK-01 | Phase 4 | Pending |
| TASK-02 | Phase 4 | Pending |
| TASK-03 | Phase 4 | Pending |
| TASK-04 | Phase 4 | Pending |
| INTG-01 | Phase 5 | Pending |
| INTG-02 | Phase 5 | Pending |
| INTG-03 | Phase 5 | Pending |
| INTG-04 | Phase 5 | Pending |
| COMP-01 | Phase 6 | Pending |
| COMP-02 | Phase 6 | Pending |
| COMP-03 | Phase 6 | Pending |
| COMP-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-01*
*Last updated: 2026-04-01 after roadmap creation*

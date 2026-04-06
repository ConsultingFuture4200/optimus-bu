# Architecture Research: Spec Compliance Audit

**Domain:** Governed agent organization — spec-vs-code systematic audit
**Researched:** 2026-04-01
**Confidence:** HIGH (based on codebase map in `.planning/codebase/` and SPEC.md structure)

## Standard Architecture

### System Overview: Audit Component Map

The audit is not a linear scan. It has four distinct component families, with hard dependency ordering between them. Auditing a higher-tier component before its foundation is verified produces unreliable results.

```
┌──────────────────────────────────────────────────────────────────┐
│                   TIER 0: Foundations                             │
│  ┌──────────────────┐  ┌────────────────────────────────────┐    │
│  │  Design Principles│  │  Schema / DDL Integrity            │    │
│  │  P1-P6 scan      │  │  (001-baseline.sql vs spec §12)    │    │
│  │  (cross-cutting) │  │  No cross-schema FK; schemas match │    │
│  └──────────────────┘  └────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│                   TIER 1: Identity + Enforcement                  │
│  ┌──────────────────┐  ┌────────────────────────────────────┐    │
│  │  Agent Identity  │  │  Constitutional Gates              │    │
│  │  JWT + RLS (§5)  │  │  G1-G7, guardCheck(), atomic tx   │    │
│  └──────────────────┘  └────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│                   TIER 2: Coordination Correctness                │
│  ┌──────────────────┐  ┌────────────────────────────────────┐    │
│  │  Task Graph (§3) │  │  Agent Tier Enforcement (§2)       │    │
│  │  State machine,  │  │  Model assignments, can_assign_to, │    │
│  │  DAG edges,      │  │  tier constraints from config      │    │
│  │  retry/escalate  │  └────────────────────────────────────┘    │
│  └──────────────────┘                                            │
├──────────────────────────────────────────────────────────────────┤
│                   TIER 3: Observability + Integrity               │
│  ┌──────────────────┐  ┌────────────────────────────────────┐    │
│  │  Hash-Chain Audit│  │  Phase 1 Exit Criteria (§14)       │    │
│  │  P3 compliance   │  │  All §14 items implemented or      │    │
│  │  append-only logs│  │  explicitly flagged as future phase│    │
│  └──────────────────┘  └────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | What Gets Audited | Files | Spec Reference |
|-----------|------------------|-------|----------------|
| P1-P6 Principle Scan | Every module checked for deny-by-default, infra enforcement, boring deps | `src/**/*.js` | SPEC §0 |
| Schema / DDL Integrity | Five schemas, no cross-schema FKs, column types match spec | `sql/001-baseline.sql` | SPEC §12 |
| JWT Agent Identity | `agent-jwt.js` issues/verifies tokens; `withAgentScope()` enforces before any DB write | `src/runtime/agent-jwt.js`, `src/db.js` | SPEC §5 target |
| RLS Agent Isolation | Policies defined AND enforced; non-superuser test roles verify policy activation | `sql/001-baseline.sql` RLS sections, `src/db.js` | SPEC §5 target |
| Constitutional Gates G1-G7 | `guardCheck()` + `transition_state()` in single Postgres transaction; gate config matches `gates.json` | `src/runtime/guard-check.js`, `src/runtime/state-machine.js` | SPEC §5 current |
| Task Graph State Machine | Valid transitions only (`created→assigned→in_progress→review→completed`); failed tasks retry≤3 then escalate | `src/runtime/state-machine.js`, `agent_graph.state_transitions` | SPEC §3 |
| DAG Edge Integrity | `depends_on` edges are acyclic; no orphan work items; blocked state propagates | `src/runtime/state-machine.js`, `agent_graph.work_item_edges` | SPEC §3 |
| Agent Tier Model Assignments | Strategist=Opus, Architect/Orchestrator/Reviewer=Sonnet, Executors=Haiku; `can_assign_to` lists are explicit (no globs) | `config/agents.json`, `src/agents/orchestrator.js` | SPEC §2 |
| Hash-Chain Audit Logs | `state_transitions.hash` chains each row to previous; merkle proofs publishable | `src/runtime/state-machine.js`, `src/runtime/merkle-publisher.js` | SPEC P3 |
| pg_notify Event System | No external message queue; all inter-agent signals via `pg_notify` | `src/runtime/event-bus.js` | SPEC P4 |
| Phase 1 Exit Criteria | Every §14 item either has code pointer or explicit "future phase" label | SPEC §14, `PROJECT.md` | SPEC §14 |

## Recommended Audit Structure

### Approach: Bottom-Up Foundations First, Then Top-Down Completeness

The audit should run bottom-up. Checking agent tier enforcement (TIER 2) is only meaningful if the identity layer (TIER 1) is verified first — an agent claiming the wrong tier via a forged JWT corrupts all tier-level findings. Similarly, checking the state machine (TIER 2) is only meaningful if the schema it writes to (TIER 0) has the correct structure.

**Do not audit TIER 2 before TIER 0 and TIER 1 are clean.**

After TIER 0-2 are verified, apply a top-down completeness pass (TIER 3) to confirm that §14 has no silent gaps.

```
autobot-inbox/
├── audit-components/       # Conceptual groupings, not a real directory
│   ├── tier0/
│   │   ├── design-principles/   # P1-P6 across all modules
│   │   └── schema-integrity/    # DDL vs spec §12
│   ├── tier1/
│   │   ├── jwt-identity/        # agent-jwt.js + withAgentScope()
│   │   └── constitutional-gates/ # guard-check.js + atomic transaction
│   ├── tier2/
│   │   ├── task-graph/          # state-machine.js + DAG edges
│   │   └── agent-tiers/         # config/agents.json + orchestrator routing
│   └── tier3/
│       ├── hash-chain/          # state_transitions hash integrity
│       └── phase1-exit/         # §14 completeness map
```

### Structure Rationale

- **tier0/ (Foundations):** Everything else depends on the schema being correct and the design principles being applied. Audited first because findings here cascade.
- **tier1/ (Enforcement):** The two mechanisms that stop bad things from happening. JWT identity is a prerequisite for RLS; RLS is a prerequisite for trusting agent-scoped queries in tier2.
- **tier2/ (Coordination):** Only auditable once identity and enforcement are trustworthy. State machine correctness depends on knowing that the agents writing to it are who they claim to be.
- **tier3/ (Observability + Completeness):** Audit log integrity is verified last because it depends on the state transitions being written correctly (tier2). Phase 1 exit completeness is a top-down scan that closes the loop.

## Architectural Patterns for the Audit

### Pattern 1: Infrastructure Enforcement vs. Prompt Advice Separation

**What:** Every constraint must be enforced by DB constraints, JWT verification, or a Postgres transaction — never by a prompt instruction. The audit must classify each constraint as one of three types: INFRA (enforced by code/DB), ADVISORY (prompt-only, flagged as gap), or UNVERIFIED (no evidence found either way).

**When to use:** Applied across all components. Any control found to be ADVISORY must be logged as a P2 violation.

**Why this matters for audit ordering:** You cannot trust ADVISORY controls during higher-tier audits. Discovering a P2 violation in TIER 0 may invalidate assumptions in TIER 2. Run TIER 0 first.

**Example classification:**
```
G1 Budget Gate:
  - DB CHECK constraint on autobot_finance.budget_ledger: INFRA (verified)
  - Agent prompt says "don't exceed budget": ADVISORY (expected, non-blocking)
  - guardCheck() pre-authorization call before state transition: INFRA (to verify)
```

### Pattern 2: Dependency Ordering as a Directed Graph

**What:** Audit components form a DAG. Each component lists what it depends on being verified first. This prevents false confidence: a "passing" agent tier check is meaningless if JWT identity is broken.

**Dependency chain:**
```
schema-integrity
    ↓ (schema correct?)
jwt-identity ← schema-integrity
    ↓ (JWT verified?)
rls-isolation ← jwt-identity + schema-integrity
    ↓ (RLS active?)
constitutional-gates ← rls-isolation
    ↓ (gates fire correctly?)
task-graph ← constitutional-gates + schema-integrity
    ↓ (state machine is sound?)
agent-tiers ← task-graph + jwt-identity
    ↓ (tiers enforced?)
hash-chain ← task-graph
    ↓ (audit log trustworthy?)
phase1-exit ← ALL above
```

### Pattern 3: Two-Phase Verification per Component

**What:** Each audit component runs in two passes: (1) static analysis — read code and config, compare to spec text; (2) runtime verification — run a test that exercises the constraint and confirms it fires.

**When to use:** Applied to all TIER 1 and TIER 2 components. Static analysis alone is insufficient for enforcement claims.

**Trade-offs:** Runtime verification requires a working test environment. Static-only findings should be labeled LOW confidence.

**Example for G1 budget gate:**
```
Pass 1 (Static):
  - Read guard-check.js: does G1 code exist? Does it call the DB?
  - Read sql/001-baseline.sql: does budget_ledger have a CHECK constraint?
  - Read gates.json: is G1 threshold defined?

Pass 2 (Runtime):
  - Exhaust DAILY_BUDGET_USD in test
  - Attempt state transition
  - Verify transition is blocked, not just warned
  - Verify work_item transitions to `blocked`, not `failed`
```

### Pattern 4: "Currently Implemented" vs. "Target Architecture" Classification

**What:** SPEC §5 distinguishes between what guardrails exist now and what the target architecture requires. The audit must explicitly classify each §5 item against this distinction — otherwise findings will either over-report gaps (by applying target requirements to Phase 1) or under-report them (by treating target items as already done).

**Classification scheme:**

| Status | Meaning | Audit Action |
|--------|---------|-------------|
| CURRENT-IMPLEMENTED | In codebase and active | Verify correctness |
| CURRENT-PARTIAL | In codebase but inactive/incomplete | Document gap + severity |
| TARGET-FUTURE | Spec says Phase 2+ | Confirm not claimed as done in code comments |
| CLAIMED-INCOMPLETE | Code claims it but evidence is absent | Flag as critical gap |

**Known classifications from codebase map:**

| Item | Status | Evidence |
|------|--------|---------|
| G1-G7 constitutional gates | CURRENT-IMPLEMENTED | `guard-check.js`, `gates.json` |
| JWT signing and verification | CURRENT-IMPLEMENTED | `agent-jwt.js` issueToken/verifyToken |
| RLS policy definitions | CURRENT-PARTIAL | Policies defined in SQL, enforcement optional in `withAgentScope()` |
| Per-agent DB roles | TARGET-FUTURE | ADR-018 Phase 2 |
| Token revocation list | CURRENT-PARTIAL | In-memory kill switch exists; blocklist not implemented |
| Tool allow-lists | CURRENT-PARTIAL | `tools_allowed` in `agents.json`, enforcement unclear |
| Content sanitization | UNVERIFIED | No clear reference in codebase map |
| Tool integrity hash check | TARGET-FUTURE | Not implemented, ADR pending |

## Data Flow: Audit Execution Sequence

### Audit Execution Flow

```
Spec §0 (P1-P6) Text
    ↓ (extract each principle as testable assertion)
Principle Assertion List
    ↓ (scan code for each assertion)
[static scan of src/**/*.js]
    ↓
P1-P6 Findings (PASS/FAIL/UNVERIFIED per module)
    ↓
sql/001-baseline.sql
    ↓ (compare schemas to spec §12)
Schema Gap Report
    ↓
agent-jwt.js + db.js withAgentScope()
    ↓ (static: does JWT verify before scope set? runtime: forge token → expect reject)
JWT Identity Findings
    ↓
guard-check.js + state-machine.js
    ↓ (static: single transaction? runtime: violate each gate → expect block)
Gate Enforcement Findings
    ↓
state-machine.js + agent_graph.state_transitions
    ↓ (static: all transitions valid? runtime: attempt invalid transition → expect reject)
Task Graph Findings
    ↓
config/agents.json
    ↓ (compare model names, can_assign_to lists to spec §2 text)
Agent Tier Findings
    ↓
merkle-publisher.js + state_transitions.hash column
    ↓ (static: hash chain formula? runtime: mutate a row → detect broken chain)
Hash Chain Findings
    ↓
SPEC §14 item list
    ↓ (cross-reference against all findings above)
Phase 1 Exit Gap Report
```

### Key Data Flows Within the Audit

1. **Spec text → testable assertions:** Each spec section is parsed into a checklist of binary claims. Example: §3 says "failed tasks retry up to 3 times, then escalate" — this becomes three assertions: retry counter exists in schema, retry logic increments counter, escalation fires at count=3.

2. **Static finding → runtime confirmation:** A static finding of "gate exists" is upgraded to HIGH confidence only after a runtime test confirms it fires. Without runtime confirmation, classification stays MEDIUM.

3. **Finding → gap record:** Every gap (FAIL or UNVERIFIED) creates a record with: spec reference, code location, gap severity (CRITICAL/HIGH/MEDIUM/LOW), whether it's CURRENT-PARTIAL or TARGET-FUTURE.

4. **Gap record → fix or label:** Gaps must either be closed with a code fix or explicitly labeled "future phase — not Phase 1 exit criteria." Silent gaps are not acceptable (the audit's entire purpose is eliminating silent gaps).

## Scaling Considerations

The audit itself doesn't scale — it's a one-time exercise with incremental follow-ups at phase transitions.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single auditor (current) | Run all four tiers sequentially; static analysis first, then runtime tests in one environment |
| Two parallel streams | TIER 0 (schema + principles) in parallel with TIER 1 (identity + gates); merge before TIER 2 |
| Continuous compliance (post-Phase 1) | Convert audit checklist to automated test suite; run on every PR; spec drift detector already exists in `src/runtime/exploration/domains/security-scan.js` |

### Scaling Priorities

1. **First priority:** Get TIER 0 and TIER 1 findings documented before starting TIER 2. Incorrect schema or broken identity makes higher-tier findings unreliable.
2. **Second priority:** Distinguish CURRENT-PARTIAL from TARGET-FUTURE explicitly. This prevents wasted effort fixing items that are intentionally deferred to Phase 2.

## Anti-Patterns

### Anti-Pattern 1: Auditing High-Level Before Foundations

**What people do:** Start with the most visible feature (e.g., constitutional gates G1-G7) because it's the most discussed, then discover the RLS layer under it is broken.

**Why it's wrong:** If agent identity (JWT + RLS) is not enforced, a gate finding of "PASS" is meaningless — an agent could claim a different identity and bypass the gate entirely. Higher-tier findings depend on lower-tier foundations.

**Do this instead:** Run TIER 0 schema integrity and TIER 1 identity enforcement first. Only after those pass should you trust TIER 2 gate-level findings.

### Anti-Pattern 2: Static Analysis Without Runtime Verification

**What people do:** Read `guard-check.js`, see that G1-G7 logic exists, mark all gates as "implemented."

**Why it's wrong:** `withAgentScope()` in `db.js` has RLS enforcement described as "optional" in the codebase map (CONCERNS.md: "RLS enforcement: partial, policies defined, enforcement optional"). Static presence does not confirm active enforcement.

**Do this instead:** For every CURRENT-PARTIAL item, write a runtime test that attempts the violation and confirms the system blocks it. If the block doesn't fire, it's a gap regardless of what the code says.

### Anti-Pattern 3: Conflating "Currently Implemented" with "Target Architecture"

**What people do:** Audit SPEC §5 target architecture items (per-agent DB roles, tool integrity hash checks) as if they're Phase 1 requirements, then report them as critical gaps.

**Why it's wrong:** SPEC §5 explicitly separates "currently implemented" guardrails from "target architecture." Reporting TARGET-FUTURE items as gaps creates noise that obscures real CURRENT-PARTIAL gaps.

**Do this instead:** Apply the four-status classification (CURRENT-IMPLEMENTED, CURRENT-PARTIAL, TARGET-FUTURE, CLAIMED-INCOMPLETE) before assigning severity. Only CURRENT-PARTIAL and CLAIMED-INCOMPLETE items are Phase 1 audit failures.

### Anti-Pattern 4: Treating `config/agents.json` as Sufficient Tier Enforcement

**What people do:** Check that `agents.json` lists the correct models for each tier and mark agent tier enforcement as passing.

**Why it's wrong:** Config files are advisory at runtime unless code actively reads them and rejects mismatches. The audit must verify that `orchestrator.js` actually rejects an assignment outside its `can_assign_to` list, not just that the list is correctly defined.

**Do this instead:** Verify the enforcement path: config is read → validation function exists → invalid assignment fails → work_item is rejected. All four steps, not just step one.

## Integration Points

### Spec Sections and Their Code Counterparts

| Spec Section | Code Location | Audit Method |
|-------------|---------------|-------------|
| §0 Design Principles P1-P6 | Cross-cutting, all `src/` | Static scan, classify each module per principle |
| §2 Agent Tiers | `config/agents.json`, `src/agents/orchestrator.js` | Config comparison + assignment rejection test |
| §3 Task Graph | `src/runtime/state-machine.js`, `agent_graph` schema | SQL schema check + invalid transition test |
| §5 Guardrails (current) | `src/runtime/guard-check.js`, `src/runtime/state-machine.js` | Gate violation test per G1-G7 |
| §5 Guardrails (target) | `src/runtime/agent-jwt.js`, `src/db.js` | JWT forge test + RLS policy activation check |
| §12 Schema Isolation | `sql/001-baseline.sql` | grep for cross-schema FK; verify 5 schemas exist |
| §14 Phase 1 Exit | All of above | Cross-reference against checklist |
| P3 Transparency | `src/runtime/state-machine.js`, `src/runtime/merkle-publisher.js` | Hash chain mutation test |
| P4 Boring Infrastructure | All dependencies | Dependency scan: no external message queue, pg/jwt/hash-chain only |

### Internal Audit Boundaries

| Boundary | Communication | Audit Notes |
|----------|---------------|-------------|
| Schema audit ↔ Gate audit | Schema must pass before gates are audited | Gates write to `state_transitions`; bad schema = bad gate test |
| JWT audit ↔ RLS audit | JWT must verify before RLS test | RLS enforcement uses `app.agent_id` set by JWT path |
| Gate audit ↔ State machine audit | Gates are called inside state transitions | A broken gate found in isolation may pass in context |
| All components ↔ Phase 1 exit audit | All lower tiers complete | Exit audit is only meaningful when all inputs are clean |

## Sources

- Optimus SPEC.md v0.7.0 (canonical, located at `autobot-spec/SPEC.md`)
- `.planning/codebase/ARCHITECTURE.md` — codebase layer map and data flow documentation
- `.planning/codebase/CONCERNS.md` — known gaps including JWT RLS partial enforcement, completeness check removed
- `.planning/codebase/STRUCTURE.md` — file locations for each audit component
- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — RLS policy verification methodology (HIGH confidence)
- [Testing RLS with Atlas](https://atlasgo.io/faq/testing-rls) — non-superuser testing requirement, policy activation verification
- [Hash Chain Audit Log Integrity](https://dev.to/veritaschain/your-audit-logs-are-lying-to-you-6-properties-that-make-logs-actually-verifiable-3808) — six properties of verifiable logs; deletion detection via append-only verification
- [AuditableLLM: Hash-Chain Audit Framework](https://www.mdpi.com/2079-9292/15/1/56) — structural vs behavioral verification levels for LLM audit systems
- [AI Governance: Infrastructure vs Prompt-Based Controls](https://air-governance-framework.finos.org/mitigations/mi-16_preserving-source-data-access-controls-in-ai-systems.html) — infrastructure enforcement is the only reliable method; prompt-based controls are easily bypassed (aligns with Optimus P2)
- [Risk-Based Audit Methodology](https://auditboard.com/blog/risk-based-auditing) — bottom-up audit planning, foundations before higher-tier components

---
*Architecture research for: Optimus spec compliance audit*
*Researched: 2026-04-01*

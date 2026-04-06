# Phase 1: Scope Lock - Research

**Researched:** 2026-04-01
**Domain:** Documentation architecture, scope boundary formalization, ADR reconciliation
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Section-level table — one row per SPEC.md section (e.g., section 2, section 3, section 5) with phase classification. Compact, directly citable by section number in future compliance fix commits.
- **D-02:** Standalone file at `autobot-inbox/docs/internal/SCOPE-LOCK.md` — self-contained, clearly citable, won't bloat existing docs. Not an ADR, not a SPEC.md modification.
- **D-03:** Four-way classification: `P1-REQUIRED`, `P1-PARTIAL`, `P2-DEFERRED`, `NOT-APPLICABLE`. The PARTIAL label captures items like RLS (policies defined but enforcement not active) and JWT (functions exist, full enforcement pending).
- **D-04:** P1-PARTIAL items get an inline sub-table with explicit "P1 scope" and "Deferred" columns.
- **D-05:** When CONCERNS.md and ADR-018 contradict, neither wins automatically — contradictions are flagged with both positions stated. Board resolves during PR review.
- **D-06:** SPEC sections where neither ADR-018 nor CONCERNS.md takes a position default to `P1-REQUIRED`. Conservative approach.
- **D-07:** Board confirmation via GitHub PR with both Dustin and Eric approving via review.
- **D-08:** Executive summary at the top of SCOPE-LOCK.md — 2-3 paragraphs covering what's Phase 1, what's deferred, and what contradictions need board resolution.

### Claude's Discretion

- Table formatting details (column widths, markdown styling)
- Section ordering within the document beyond the executive summary
- How to reference SPEC.md section numbers (e.g., "section 5" vs "section 5 Guardrail Enforcement")

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUN-05 | Phase 1 vs Phase 2 scope boundary is formalized from CONCERNS.md and ADR-018 before any code changes | All six research areas below directly enable this: SPEC section inventory, ADR-018/ADR-015 analysis, CONCERNS.md contradiction mapping, and classification decisions |

</phase_requirements>

---

## Summary

Phase 1 is purely a documentation task: produce `autobot-inbox/docs/internal/SCOPE-LOCK.md` that classifies every SPEC.md section as Phase 1 or Phase 2. No code is touched. The primary complexity is reconciling three sources that occasionally disagree: SPEC.md (the architecture target), ADR-018 (the board's 2026-03-07 mandate reversing the earlier JWT deferral), and CONCERNS.md (the 2026-04-01 codebase analysis that makes one recommendation that conflicts with ADR-018 on token revocation).

The planner needs to produce a single task: write SCOPE-LOCK.md. That task requires reading all three inputs in detail, constructing a classification table for all 22 SPEC.md sections (§0–§21), expanding P1-PARTIAL entries with sub-tables, writing an executive summary, and opening a GitHub PR for board approval.

**Primary recommendation:** One atomic plan — read sources, classify all 22 sections, write the document, commit it, open PR. No code changes permitted in this phase.

---

## Standard Stack

### Core

| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| Markdown | — | SCOPE-LOCK.md format | All internal docs are Markdown; board reviews via GitHub PR diff |
| Git | system | Commit artifact for traceability | All docs committed per CLAUDE.md conventions |
| GitHub PR | — | Board confirmation mechanism | Auditable, timestamped, standard process per D-07 |

### Supporting

No external libraries needed. This phase is documentation-only.

**Installation:** None required.

---

## Architecture Patterns

### Recommended Document Structure

```
autobot-inbox/docs/internal/
└── SCOPE-LOCK.md              # The single deliverable
```

### Pattern 1: Board-Facing Executive Summary (D-08)

**What:** 2-3 paragraphs at the top of the document, following Dustin's communication preference (recommendation → why → how) and Eric's preference (peer-to-peer technical, spec section references).

**When to use:** Always — first section of SCOPE-LOCK.md before the classification table.

**Example:**
```markdown
## Executive Summary

Every SPEC.md section has been classified as Phase 1 or Phase 2 based on three
authoritative sources: the spec itself (canonical target), ADR-018 (2026-03-07
board mandate on JWT), and CONCERNS.md (2026-04-01 codebase analysis).

Phase 1 requires: [summary of P1-REQUIRED items]. JWT agent identity (§2, §5) is
Phase 1 per ADR-018, with per-agent DB roles and token revocation explicitly deferred
to Phase 2. One contradiction requires board resolution before Phase 3 begins:
CONCERNS.md recommends token revocation as Phase 1 for shared-infrastructure
deployments; ADR-018 explicitly defers it.

Sections outside Optimus Phase 1 scope (§17 Legal, §18 Autonomous Software
Composition, §12 AutoBot extension) are classified NOT-APPLICABLE.
```

### Pattern 2: Classification Table (D-01, D-03)

**What:** One row per SPEC.md section, four-way classification.

**When to use:** Core body of SCOPE-LOCK.md, after the executive summary.

**Example:**
```markdown
| Section | Title | Classification | Rationale |
|---------|-------|----------------|-----------|
| §0 | Design Principles | P1-REQUIRED | P1-P6 are foundational; each must have at least one enforcement point |
| §5 | Guardrail Enforcement | P1-PARTIAL | See sub-table below |
| §12 | Database Architecture (AutoBot Extension) | NOT-APPLICABLE | AutoBot-only; Optimus Phase 3+ |
```

### Pattern 3: P1-PARTIAL Sub-Tables (D-04)

**What:** Inline expansion for each P1-PARTIAL section listing exactly what is and is not in Phase 1 scope.

**When to use:** Every row classified P1-PARTIAL.

**Example:**
```markdown
#### §5 Partial Scope

| Item | P1 Scope | Deferred to Phase 2 |
|------|----------|---------------------|
| JWT issuer | ✓ initializeJwtKeys() exists and functional | — |
| JWT signing | ✓ issueToken() with RS256 | — |
| JWT verification | ✓ verifyToken() confirmed | — |
| withAgentScope() validation | ✓ validates JWT before set_config | — |
| RLS enforcement | ✓ policies defined; enforcement active status per Phase 3 audit | — |
| Per-agent DB roles | — | Phase 2: one role per agent (ADR-018) |
| Token revocation list | — | Phase 2: kill switch sufficient for Phase 1 (ADR-018) |
```

### Anti-Patterns to Avoid

- **Adding code changes in this phase:** D-06 and success criterion #4 both forbid it. SCOPE-LOCK.md is a documentation artifact only.
- **Leaving sections unclassified:** Success criterion #1 requires zero unclassified sections. All 22 must be in the table.
- **Resolving CONCERNS.md vs. ADR-018 contradictions unilaterally:** D-05 requires both positions to be stated and flagged for board resolution. Do not silently pick a winner.
- **Modifying SPEC.md:** SPEC.md is read-only source of truth (CLAUDE.md and autobot-spec/CLAUDE.md both state this).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Board confirmation | Custom approval workflow | GitHub PR with CODEOWNERS | Already established pattern for all board decisions; auditable and timestamped |
| Decision record | New ADR for scope boundary | SCOPE-LOCK.md per D-02 | Not an architecture decision — it is an audit scope document, distinct from ADRs |
| Section enumeration | Manual guess | Read SPEC.md §0-§21 headers directly | 22 sections confirmed; enumeration is trivial |

---

## SPEC.md Section Inventory

**Total sections: 22** (§0 through §21). This is the definitive list the planner must classify.

| Section | Title | Notes for Classification |
|---------|-------|--------------------------|
| §0 | Design Principles | P1-P6 — foundational, all Phase 1 |
| §1 | The Core Idea | Conceptual framing — no implementation deliverables |
| §2 | Architecture Overview | Agent tiers, orchestration layer — Phase 1 core |
| §3 | The Task Graph | agent_graph schema, work item state machine — Phase 1 core |
| §4 | Agent Runtime | Agent loop, tier constraints — Phase 1 core |
| §5 | Guardrail Enforcement | JWT + RLS + content sanitization — P1-PARTIAL (ADR-018 scope boundary) |
| §5a | Knowledge Graph Layer | Neo4j advisory layer — ADR-019 Proposed, gated on Linus security fixes |
| §6 | Tool Integrity Layer | Hash verification Phase 1; sandboxed execution Phase 2 |
| §7 | Communication Gateway | Shadow mode Phase 1; Tier 0-1 auto-send Phase 2 |
| §8 | Audit and Observability | Tier 1 hourly Phase 1; Tier 2 AI Auditor Phase 2 |
| §9 | Kill Switch | Phase 1 core |
| §10 | Cost Tracking | Phase 1 core |
| §11 | Failure Modes | Phase 1 — retry logic, escalation |
| §12 | Database Architecture (AutoBot Extension) | AutoBot-only; NOT-APPLICABLE to Optimus Phase 1 |
| §13 | AutoBot Constitution (Summary) | AutoBot Phase 3+; NOT-APPLICABLE |
| §14 | Phased Execution Plan | Reference document — classification source, not itself a deliverable |
| §14.1 | Source Control and Code Review Architecture | Phase 1 deliverable per §14 |
| §15 | Operating Cost Model | Phase 1 instrumentation |
| §16 | Open Questions Resolved | Historical record — NOT-APPLICABLE |
| §17 | Legal Compliance Architecture | Phase 0 prerequisite — NOT-APPLICABLE to compliance audit scope |
| §18 | Autonomous Software Composition | Phase 2+ — NOT-APPLICABLE |
| §19 | Strategy Evaluation Protocol | Single-pass Phase 1; three-perspective Phase 2 |
| §20 | What This Document Does Not Cover | Not a deliverable |
| §21 | Changelog | Not a deliverable |

**Note on §14:** SPEC.md v1.0.0 (2026-03-10) is the current version per the file header. CLAUDE.md references SPEC.md v0.7.0 in several places. Both the autobot-inbox CLAUDE.md and the top-level CLAUDE.md reference v0.7.0. The actual SPEC.md file header shows v1.0.0 dated 2026-03-10. The planner should classify against the actual file contents, not the version number cited in CLAUDE.md. This discrepancy should be noted in SCOPE-LOCK.md.

---

## ADR-018 vs ADR-015 Analysis

### ADR-015 (Superseded — 2026-03-02)

Original deferral. Key claims:
- JWT-scoped agent identity deferred to Phase 2
- Application-layer identity (session vars via `set_config`) accepted as sufficient
- RLS policies defined but not enforced (PGlite doesn't support roles; Supabase superuser bypasses RLS)
- Four Phase 2 trigger conditions defined: multi-user, untrusted code, network-exposed API, autonomous execution without HITL
- Intermediate step proposed: HMAC-signed audit claims (not full JWT)

### ADR-018 (Active — 2026-03-07, supersedes ADR-015)

Board mandate reversing the deferral. Key decisions:
- JWT-scoped agent identity REQUIRED for Phase 1 exit
- All four ADR-015 trigger conditions are now met (new contributors, Railway deployment)
- **In Phase 1 scope:** JWT issuer, signing, verification, DB connection scoping via `withAgentScope()` + JWT signature validation, RLS activation connecting as `autobot_agent` role, JWT-verified `state_transitions.agent_id`
- **Explicitly Phase 2:** Per-agent DB roles (one role per agent), token revocation list, external JWT verification

**Implementation status per CONCERNS.md (2026-04-01):**
- JWT issuer: Complete
- JWT signing: Complete
- JWT verification: Complete
- RLS enforcement: PARTIAL (policies defined, enforcement "optional" — the exact activation status is what Phase 3 will verify)
- Per-agent DB roles: Phase 2
- Token revocation: Phase 2

---

## Contradictions Between CONCERNS.md and ADR-018

**This is the complete contradiction map. The scope document must surface all of these with both positions stated (D-05).**

### Contradiction 1: Token Revocation Timeline (HIGH SEVERITY for scope document)

| Source | Position |
|--------|----------|
| ADR-018 (2026-03-07) | Token revocation explicitly deferred to Phase 2: "kill switch is sufficient for Phase 1" |
| CONCERNS.md (2026-04-01) | "Should be Phase 1 if agents run on shared infrastructure" — explicitly recommends adding in-memory blocklist before Phase 1 exit |

**Note:** ADR-018 was written when Railway deployment was the trigger for reversing ADR-015. CONCERNS.md was written 25 days later with the explicit knowledge that agents are already on shared infrastructure. The CONCERNS.md author had this context and still called out the gap.

**Board resolution needed:** Does ADR-018's explicit "kill switch is sufficient" language hold, or does shared-infrastructure deployment reopen the token revocation question?

### Contradiction 2: RLS Enforcement Activation

| Source | Position |
|--------|----------|
| ADR-018 (2026-03-07) | "RLS activation — connect as `autobot_agent` role with RLS policies enforced" — listed as in Phase 1 scope |
| CONCERNS.md (2026-04-01) | RLS enforcement is "⚠ Partial (policies defined, enforcement optional)" — suggests it has not been fully activated |

**Note:** This is not a strategic contradiction — it is an implementation status gap. ADR-018 mandates RLS activation as Phase 1; CONCERNS.md reports it has not been completed. Phase 3 (Identity and Enforcement audit) will determine actual enforcement status. SCOPE-LOCK.md should record ADR-018's mandate and note the CONCERNS.md gap without resolving it (resolution is Phase 3 scope).

### No Contradiction on Per-Agent DB Roles

Both sources agree: per-agent DB roles are Phase 2. No board resolution needed.

### No Contradiction on JWT Functions

Both sources agree: JWT issuer, signing, and verification are Phase 1 and complete. No board resolution needed.

---

## Common Pitfalls

### Pitfall 1: Misidentifying the SPEC.md Version

**What goes wrong:** CLAUDE.md references SPEC.md "v0.7.0" but the actual file header says "v1.0.0 (2026-03-10)." If the planner writes "classifying against v0.7.0" the document is inaccurate.

**Why it happens:** CLAUDE.md was written when v0.7.0 was current; SPEC.md has since been updated to v1.0.0.

**How to avoid:** Always read the SPEC.md file header directly. Record the actual version found in the file in SCOPE-LOCK.md.

### Pitfall 2: Missing the §14.1 Subsection

**What goes wrong:** Classifying §14 as a single row misses the §14.1 subsection (Source Control and Code Review Architecture), which has distinct Phase 1 deliverables. The section inventory above lists 22 sections — §14.1 is one of them.

**How to avoid:** The grep of SPEC.md section headers confirms §14.1 is a separate `##` heading. Include it as a separate row in the classification table.

### Pitfall 3: Treating CONCERNS.md Severity as Phase Classification

**What goes wrong:** CONCERNS.md uses a "High/Medium/Low" severity and timeline table. "High — Phase 1 (before exit)" entries in CONCERNS.md sound like Phase 1 scope, but some of these are IMPLEMENTATION gaps (incomplete work) not scope questions. The scope document classifies what the spec requires in Phase 1, not what is currently incomplete.

**How to avoid:** Separate "what does ADR-018 say belongs in Phase 1" (scope question) from "what is currently not implemented" (implementation status question). The scope document answers the scope question only.

### Pitfall 4: Opening a PR Before the Document Is Board-Ready

**What goes wrong:** SCOPE-LOCK.md is opened as a draft before contradictions are surfaced. Board members see an incomplete document and the PR review stalls.

**How to avoid:** The SCOPE-LOCK.md document must be fully drafted — all 22 sections classified, contradictions explicitly flagged, executive summary written — before the PR is opened. The PR description should call out each contradiction explicitly so board members know what requires their decision.

---

## Code Examples

### Section Classification Table Format

```markdown
| Section | Title | Classification | Source / Rationale |
|---------|-------|----------------|--------------------|
| §0 | Design Principles | P1-REQUIRED | Foundations — each of P1-P6 must have an enforcement point (SPEC §14 Phase 1) |
| §2 | Architecture Overview | P1-REQUIRED | Agent tiers and orchestration layer are Phase 1 core (SPEC §14) |
| §5 | Guardrail Enforcement | P1-PARTIAL | JWT: ADR-018 scope below. Content sanitization Phase 1 (static rules). Versioned rule sets Phase 2. |
| §5a | Knowledge Graph Layer | P2-DEFERRED | ADR-019 Proposed; deployment gated on Linus security fixes (SPEC §5a status note) |
| §12 | Database Architecture (AutoBot Extension) | NOT-APPLICABLE | AutoBot extension only; Optimus Phase 1 uses standard schemas (SPEC §12 header) |
```

### P1-PARTIAL Sub-Table Format (for §5)

```markdown
#### §5 Guardrail Enforcement — Phase Boundary Detail

| Item | P1 Scope | Deferred |
|------|----------|---------|
| guardCheck() atomic with transition_state() | P1-REQUIRED | — |
| JWT issuer (initializeJwtKeys) | P1-REQUIRED — complete per CONCERNS.md | — |
| JWT signing (issueToken, RS256) | P1-REQUIRED — complete per CONCERNS.md | — |
| JWT verification (verifyToken) | P1-REQUIRED — complete per CONCERNS.md | — |
| withAgentScope() validates JWT before set_config | P1-REQUIRED per ADR-018; implementation status for Phase 3 | — |
| RLS activation (autobot_agent role) | P1-REQUIRED per ADR-018; activation status for Phase 3 | — |
| Content sanitization (static rule set) | P1-REQUIRED | Versioned rule sets → Phase 2 |
| Per-agent DB roles | — | P2-DEFERRED (ADR-018 §Out of Scope) |
| Token revocation list | — | P2-DEFERRED per ADR-018; CONTRADICTION — see board resolution flag |
| External JWT verification | — | P2-DEFERRED (ADR-018 §Out of Scope) |
```

### CONCERNS.md Contradiction Flag Format

```markdown
### BOARD RESOLUTION REQUIRED: Token Revocation Timeline

| Source | Date | Position |
|--------|------|----------|
| ADR-018 | 2026-03-07 | Token revocation deferred to Phase 2; kill switch sufficient for Phase 1 |
| CONCERNS.md | 2026-04-01 | "Should be Phase 1 if agents run on shared infrastructure" (Railway deployment is live) |

**Both positions are stated above. Classification held as P2-DEFERRED (ADR-018) pending board resolution in this PR.**
```

---

## Environment Availability

Step 2.6: SKIPPED — Phase 1 is documentation-only with no external tool dependencies. The only actions are reading source files and writing a Markdown document.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None (documentation phase) |
| Config file | None |
| Quick run command | N/A |
| Full suite command | N/A |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FOUN-05 | SCOPE-LOCK.md exists, classifies all 22 sections, contradictions flagged | manual | `ls autobot-inbox/docs/internal/SCOPE-LOCK.md` (existence); count table rows manually | ❌ Wave 0 — file does not exist yet |

### Sampling Rate

- **Per task commit:** Verify SCOPE-LOCK.md exists and has no empty classification cells
- **Per wave merge:** N/A (single-wave phase)
- **Phase gate:** All four success criteria confirmed before `/gsd:verify-work`:
  1. All 22 SPEC.md sections classified (no blank rows)
  2. CONCERNS.md vs ADR-018 contradictions explicitly flagged (token revocation)
  3. File committed to `autobot-inbox/docs/internal/SCOPE-LOCK.md`
  4. No code files modified in this phase

### Wave 0 Gaps

- [ ] `autobot-inbox/docs/internal/SCOPE-LOCK.md` — the phase deliverable itself, created in Wave 1

---

## Open Questions

1. **SPEC.md version discrepancy**
   - What we know: CLAUDE.md says "SPEC.md v0.7.0" but the actual file header says "v1.0.0 (2026-03-10)"
   - What's unclear: Which sections changed between v0.7.0 and v1.0.0 that might affect classification
   - Recommendation: Note the actual version (v1.0.0) in SCOPE-LOCK.md and flag the discrepancy in the PR description for board awareness. Do not block on it.

2. **§4 Agent Runtime — subsection structure**
   - What we know: SPEC.md §4 is a full section (lines 535+) with substantial content
   - What's unclear: Whether §4 has subsections that need separate classification rows
   - Recommendation: The grep of SPEC.md `## \d+` headers confirms §4 is a single `##` heading. Classify as one row.

3. **§14.1 is an H3 inside §14, not a separate H2**
   - What we know: The grep returned `## 14. Phased Execution Plan` only. §14.1 appears in the text as `### 14.1. Source Control and Code Review Architecture`
   - What's unclear: Whether the planner should add it as a sub-row or a separate row
   - Recommendation: Add §14.1 as a sub-row of §14 in the classification table, since it has distinct Phase 1 deliverables listed in §14.

---

## Sources

### Primary (HIGH confidence)

- `autobot-spec/SPEC.md` v1.0.0 — full section structure enumerated via grep, §0, §2, §3, §4, §5, §5a, §6, §7, §8, §14 read directly
- `autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md` — ADR-018 full text read
- `autobot-inbox/docs/internal/adrs/015-jwt-deferral-to-phase2.md` — ADR-015 full text read
- `.planning/codebase/CONCERNS.md` — full text read
- `.planning/REQUIREMENTS.md` — FOUN-05 definition confirmed
- `.planning/phases/01-scope-lock/01-CONTEXT.md` — all locked decisions D-01 through D-08 read
- `autobot-inbox/docs/internal/adrs/README.md` — ADR sequence (001-021) confirmed

### Secondary (MEDIUM confidence)

- `.planning/ROADMAP.md` — Phase 1 success criteria cross-referenced
- `.planning/STATE.md` — project state and blockers noted

### Tertiary (LOW confidence)

None.

---

## Metadata

**Confidence breakdown:**
- SPEC section inventory: HIGH — grep on actual file, 22 H2 sections confirmed
- ADR-018 vs ADR-015 analysis: HIGH — both ADRs read in full
- Contradiction mapping: HIGH — derived directly from primary sources with dates
- Document structure patterns: HIGH — derived from CONTEXT.md locked decisions

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable — ADR-018 is accepted, SPEC.md v1.0.0 is current)

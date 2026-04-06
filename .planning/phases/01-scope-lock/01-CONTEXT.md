# Phase 1: Scope Lock - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Formalize the Phase 1 vs Phase 2 scope boundary as a standalone committed document (SCOPE-LOCK.md) before any compliance fixes are written. Every SPEC.md section gets classified. Contradictions between CONCERNS.md and ADR-018 are surfaced for board resolution. No code changes in this phase.

</domain>

<decisions>
## Implementation Decisions

### Document Structure
- **D-01:** Section-level table — one row per SPEC.md section (e.g., section 2, section 3, section 5) with phase classification. Compact, directly citable by section number in future compliance fix commits.
- **D-02:** Standalone file at `autobot-inbox/docs/internal/SCOPE-LOCK.md` — self-contained, clearly citable, won't bloat existing docs. Not an ADR, not a SPEC.md modification.

### Classification Categories
- **D-03:** Four-way classification: `P1-REQUIRED`, `P1-PARTIAL`, `P2-DEFERRED`, `NOT-APPLICABLE`. The PARTIAL label captures items like RLS (policies defined but enforcement not active) and JWT (functions exist, full enforcement pending).
- **D-04:** P1-PARTIAL items get an inline sub-table with explicit "P1 scope" and "Deferred" columns. Example: JWT — P1 scope: token issuance + verification + withAgentScope validation. Deferred: per-agent roles, token revocation.

### Conflict Resolution
- **D-05:** When CONCERNS.md and ADR-018 contradict, neither wins automatically — contradictions are flagged in the scope document with both positions stated. Board resolves during PR review.
- **D-06:** SPEC sections where neither ADR-018 nor CONCERNS.md takes a position default to `P1-REQUIRED`. Conservative approach — forces the audit to verify everything the spec claims.

### Board Confirmation
- **D-07:** Board confirmation via GitHub PR with both Dustin and Eric approving via review. Auditable, timestamped, standard process.
- **D-08:** Executive summary at the top of SCOPE-LOCK.md — 2-3 paragraphs covering what's Phase 1, what's deferred, and what contradictions need board resolution. Follows Dustin's preference (lead with recommendation, then why, then how).

### Claude's Discretion
- Table formatting details (column widths, markdown styling)
- Section ordering within the document beyond the executive summary
- How to reference SPEC.md section numbers (e.g., "section 5" vs "section 5 Guardrail Enforcement")

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specification
- `autobot-spec/SPEC.md` — Canonical architecture specification v0.7.0. Every section must be classified in the scope document.

### Architecture Decisions
- `autobot-inbox/docs/internal/adrs/018-jwt-agent-identity.md` — Board mandate reversing ADR-015. Defines what JWT work is Phase 1 vs Phase 2. Critical for P1-PARTIAL classifications.
- `autobot-inbox/docs/internal/adrs/015-jwt-deferral-to-phase2.md` — Superseded by ADR-018 but establishes the original Phase 2 deferral reasoning.

### Codebase Analysis
- `.planning/codebase/CONCERNS.md` — Tech debt, known bugs, security considerations, and missing features. Contains recommendations that may contradict ADR-018 phase assignments — these contradictions must be surfaced.

### Requirements
- `.planning/REQUIREMENTS.md` — v1 requirements with FOUN-05 mapped to this phase. Defines what "scope lock" must deliver.
- `.planning/ROADMAP.md` — Phase 1 success criteria (4 criteria, all must be TRUE).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- ADR index at `autobot-inbox/docs/internal/adrs/README.md` — provides numbering sequence if scope doc needs to reference decisions
- 20 existing ADRs establish the pattern for board-level decisions

### Established Patterns
- Board decisions are captured as ADRs with date, status, and explicit scope sections
- SPEC.md uses numbered sections (section 0 through section 14+) — scope document table rows should mirror this numbering
- CONCERNS.md uses severity/timeline/owner tables — scope document can reference these directly

### Integration Points
- SCOPE-LOCK.md will be cited in every compliance fix commit across Phases 2-6
- PR for board review will need CODEOWNERS approval (both board members)
- Success criteria #1 requires "no section is unclassified" — need to enumerate all SPEC.md sections

</code_context>

<specifics>
## Specific Ideas

- The executive summary should follow the board communication pattern from CLAUDE.md: Dustin wants recommendation first, then why, then how; Eric wants peer-to-peer technical framing with spec section references
- Contradictions to flag for board: CONCERNS.md recommends token revocation for Phase 1 ("should be Phase 1 if agents run on shared infrastructure") but ADR-018 explicitly defers it
- The scope document becomes the audit's anchor — every finding in Phases 2-6 references back to it

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-scope-lock*
*Context gathered: 2026-04-01*

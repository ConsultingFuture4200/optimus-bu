# Phase 1: Scope Lock - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 01-scope-lock
**Areas discussed:** Document structure, Classification categories, Conflict resolution, Board confirmation

---

## Document Structure

### Organization

| Option | Description | Selected |
|--------|-------------|----------|
| Section-level table | One row per SPEC.md section with phase classification. Compact, scannable, citable. | Yes |
| Subsection-level table | One row per subsection. More granular but much larger document. | |
| Grouped by verdict | Three groups: P1 Required, P2 Deferred, Partial. Easier for board review but harder to look up. | |

**User's choice:** Section-level table
**Notes:** None

### File Location

| Option | Description | Selected |
|--------|-------------|----------|
| Standalone SCOPE-LOCK.md | New file in autobot-inbox/docs/internal/. Self-contained, citable. | Yes |
| ADR format | ADR-021 following established decision record pattern. | |
| Section in SPEC.md | Add section 15 to the spec itself. | |

**User's choice:** Standalone SCOPE-LOCK.md
**Notes:** None

---

## Classification Categories

### Labels

| Option | Description | Selected |
|--------|-------------|----------|
| Four-way | P1-REQUIRED, P1-PARTIAL, P2-DEFERRED, NOT-APPLICABLE. PARTIAL captures items like RLS. | Yes |
| Binary only | Phase 1 or Phase 2. Simpler but forces hard calls on partial items. | |
| Five-way with rationale | Adds P1-COMPLETE distinction. Most granular. | |

**User's choice:** Four-way classification
**Notes:** None

### Partial Item Detail

| Option | Description | Selected |
|--------|-------------|----------|
| Inline sub-table | Each PARTIAL row gets P1 scope and Deferred columns. | Yes |
| Separate section | Breakdown at document bottom. Keeps main table clean. | |
| Just the label | PARTIAL is enough, details in ADR-018 and CONCERNS.md. | |

**User's choice:** Inline sub-table
**Notes:** None

---

## Conflict Resolution

### CONCERNS.md vs ADR-018

| Option | Description | Selected |
|--------|-------------|----------|
| ADR-018 wins | Board decisions are authoritative. CONCERNS.md is analysis, ADRs are decisions. | |
| Flag for board | Neither wins. Contradictions flagged with both positions. Board resolves during confirmation. | Yes |
| CONCERNS.md wins | Newer analysis should take priority over older board decisions. | |

**User's choice:** Flag for board
**Notes:** Contradictions should be explicitly surfaced rather than auto-resolved.

### Unaddressed Sections

| Option | Description | Selected |
|--------|-------------|----------|
| Default to P1-REQUIRED | Spec claims it, so Phase 1 unless explicitly deferred. Conservative. | Yes |
| Default to P2-DEFERRED | If nobody flagged it, probably aspirational. Liberal. | |
| Flag as UNCLASSIFIED | Leave unclassified, force decision during board review. | |

**User's choice:** Default to P1-REQUIRED
**Notes:** None

---

## Board Confirmation

### Confirmation Method

| Option | Description | Selected |
|--------|-------------|----------|
| PR with both approvals | GitHub PR review by Dustin and Eric. Auditable, timestamped. | Yes |
| Commit with review tag | Direct commit, tag after verbal confirmation. Faster but less formal. | |
| Board meeting artifact | Present in board session, capture in meeting notes. Most formal. | |

**User's choice:** PR with both approvals
**Notes:** None

### Executive Summary

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, in document | 2-3 paragraph summary at top of SCOPE-LOCK.md. Follows Dustin's communication preference. | Yes |
| No, table only | Table is already scannable. Summary risks going stale. | |
| Yes, in PR description | Summary in PR body, not the document. Keeps document clean. | |

**User's choice:** Executive summary in document
**Notes:** None

---

## Claude's Discretion

- Table formatting details (column widths, markdown styling)
- Section ordering within the document beyond the executive summary
- How to reference SPEC.md section numbers

## Deferred Ideas

None — discussion stayed within phase scope

# Optimus Spec Compliance Audit

## What This Is

A systematic audit of the Optimus codebase (autobot-inbox, autobot-spec, dashboard) against SPEC.md v0.7.0. Every gap between specification and implementation gets identified, prioritized, and fixed. The spec is the source of truth — code gets refactored to match.

## Core Value

Every claim in SPEC.md is either implemented in code or explicitly marked as a future phase — no silent gaps.

## Requirements

### Validated

- ✓ 6-agent pipeline processing real email — existing
- ✓ 34 SQL migrations with schema — existing
- ✓ Voice profiles and tone matching — existing
- ✓ Constitutional gates G1-G7 enforced via DB constraints and guard-check.js — existing
- ✓ CLI and Next.js dashboard — existing
- ✓ Multi-channel adapter layer — existing
- ✓ Docker Compose local dev environment — existing
- ✓ Append-only audit logging — existing

### Active

- [ ] Audit design principles P1-P6 compliance across all modules
- [ ] Audit agent tier enforcement (§2) — model assignments, capability constraints
- [ ] Audit task graph implementation (§3) — state machine, DAG edges, retry/escalation
- [ ] Audit guardrail enforcement (§5) — guardCheck(), transition_state(), atomic transactions
- [ ] Audit JWT-scoped agent identity (§5 target architecture)
- [ ] Audit Postgres RLS for agent data isolation (§5 target architecture)
- [ ] Audit tool allow-lists and content sanitization (§5 target architecture)
- [ ] Audit cross-schema isolation — no cross-schema foreign keys (§12)
- [ ] Audit hash-chain integrity on audit tables (P3)
- [ ] Audit pg_notify event system (P4)
- [ ] Fix all identified compliance gaps
- [ ] Refactor code that violates design principles
- [ ] Update documentation to reflect current state accurately

### Out of Scope

- New features not in SPEC.md — this is alignment, not expansion
- Phase 2+ deliverables — audit against Phase 1 exit criteria only
- Rewriting working code for style preferences — only fix spec violations
- External integrations testing — focus on code structure and constraints

## Context

- SPEC.md v0.7.0 is the canonical architecture specification
- Codebase was consolidated from two repos (staqsIO/autobot-inbox and staqsIO/autobot-spec) via subtree merge in March 2026
- Phase 1 (Optimus MVP) is in progress — autobot-inbox is live
- Design principles P1-P6 are non-negotiable and govern every architectural decision
- The distinction between "currently implemented" guardrails and "target architecture" guardrails (§5) needs to be clearly mapped
- Board members (Dustin and Eric) set strategy and maintain governance — spec changes require their review
- Existing codebase map available at .planning/codebase/

## Constraints

- **Source of truth**: SPEC.md wins over code in all conflicts
- **No feature creep**: Audit and fix only — no new capabilities
- **Preserve working functionality**: Fixes must not break existing pipeline operations
- **Incremental commits**: Each fix committed atomically for traceability

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Spec wins over code | User directive — systematic alignment, not pragmatic compromise | — Pending |
| Full spec coverage | All sections audited, not just high-risk areas | — Pending |
| Find and fix | Not just a report — gaps get closed with code changes | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-01 after initialization*

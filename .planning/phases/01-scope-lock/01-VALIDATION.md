---
phase: 1
slug: scope-lock
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification (docs-only phase — no code changes) |
| **Config file** | none |
| **Quick run command** | `grep -c "^|" autobot-inbox/docs/internal/SCOPE-LOCK.md` |
| **Full suite command** | `bash -c 'test -f autobot-inbox/docs/internal/SCOPE-LOCK.md && echo PASS || echo FAIL'` |
| **Estimated runtime** | ~1 second |

---

## Sampling Rate

- **After every task commit:** Run `grep -c "^|" autobot-inbox/docs/internal/SCOPE-LOCK.md`
- **After every plan wave:** Run full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 1 second

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | FOUN-05 | file-check | `test -f autobot-inbox/docs/internal/SCOPE-LOCK.md` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | FOUN-05 | content-check | `grep -c "P1-REQUIRED\|P1-PARTIAL\|P2-DEFERRED\|NOT-APPLICABLE" autobot-inbox/docs/internal/SCOPE-LOCK.md` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | FOUN-05 | section-count | `grep -c "^| §" autobot-inbox/docs/internal/SCOPE-LOCK.md` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements. This is a documentation-only phase — no test framework needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| All SPEC sections classified | FOUN-05 | Requires human verification that no section is missed | Count rows in scope table vs grep "^## " in SPEC.md |
| Contradictions flagged | FOUN-05 | Semantic judgment required | Review each CONCERNS.md entry against ADR-018 positions |
| Board confirmation via PR | FOUN-05 | Requires GitHub PR approval | Verify PR has 2 approving reviews from board members |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 1s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

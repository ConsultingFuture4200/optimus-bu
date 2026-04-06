# Stack Research

**Domain:** Spec compliance audit for governed agent organization (Node.js/Postgres monorepo)
**Researched:** 2026-04-01
**Confidence:** HIGH (core tools verified via npm registry + official docs; architecture decisions derived from existing codebase analysis)

## Context

This is an audit-and-refactor project, not a greenfield build. The existing stack (Node.js 20+, ESM, `node:test`, `pg`, no ORM) is fixed by P4 (boring infrastructure). New tooling must fit that stack — no new runtimes, no ORM, no test-framework replacements. All tools either:
(a) operate at the CLI/CI level (e.g., Semgrep, Atlas), or
(b) slot into the existing test suite as test helpers.

---

## Recommended Stack

### Core Audit Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| ESLint | 10.1.0 | Static analysis: enforce P1 (parameterized queries only), detect cross-schema FK patterns, flag string interpolation in SQL calls | Already de facto standard; custom rules via AST traversal enforce architectural invariants that code review misses. No runtime — pure static. |
| `eslint-plugin-sql` | 3.4.1 | SQL-specific linting — detects non-parameterized query construction in `pg` client calls | Purpose-built for this exact violation (P1: parameterized queries only). Catches `db.query('SELECT * FROM ' + tableName)` patterns. |
| `eslint-plugin-security` | 4.0.0 | Broader security pattern detection — prototype pollution, unsafe regex, eval | Adds G6 (stakeholder safety) and general injection surface coverage alongside SQL rules. |
| Semgrep (CLI) | latest (Dec 2025) | Semantic code analysis: detect architectural violations that AST-level ESLint misses — e.g., cross-module import violations, agent-tier capability leaks | Pattern matching at semantic level. Can express rules like "executor agents must not call strategist functions directly." YAML rules are readable and version-controllable. Install via `pip install semgrep`, not npm. |
| `node:crypto` | built-in (Node 20+) | Hash-chain integrity verification for audit tables (`state_transitions`, edit deltas) | Zero dependency, zero install. `createHash('sha256')` is sufficient for chain verification. Adding a dep here violates P4. |
| `jose` | 6.2.2 | JWT scope verification testing — verify agent identity tokens have correct scopes, validate `alg` is not `none`, check agent-tier claims | Preferred over `jsonwebtoken` (9.0.3): actively maintained, ESM-native, no algorithm confusion vulnerabilities by default, supports modern Web Crypto API. jwt.io and DEV Community both recommend migration in 2025. |

### Database Audit Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `pg` | 8.19.0 (already installed) | Direct catalog queries against `pg_class`, `pg_policies`, `pg_constraint`, `information_schema` to verify RLS status, cross-schema FK violations, constraint presence | Already in the codebase. All DB audit queries run through the existing `src/db.js` abstraction. No new DB driver needed. |
| Atlas CLI | v0.30+ (standalone binary) | Schema constraint verification, migration linting, RLS policy testing | The only tool that provides native `atlas schema test` for Postgres — can write HCL tests that seed data and assert constraint behavior (FK violations, check constraints, unique constraints). Separate from the Node stack; install as a dev binary, not npm. |
| `pgaudit` extension | Postgres-side (no npm) | Session-level and object-level audit logging verification — confirms that `agent_graph.state_transitions` trigger fires correctly | Verifies at the DB level that audit trails can't be bypassed by application code. Run via Docker compose in test environment. |

### Development / CI Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `node:test` (built-in) | Audit test runner for all hash-chain, JWT, and DB constraint tests | Already the project standard (P4 — no Jest, no Vitest). All new audit tests follow existing patterns in `test/`. |
| `c8` | 11.0.0 | Coverage reporting for audit test suite | Node.js V8 native coverage. Lighter than `nyc`, works with ESM without transpilation. Use for CI gate on audit test coverage. |
| `node:assert/strict` (built-in) | Assertions within audit tests | Already the project standard. |

---

## Installation

```bash
# ESLint audit plugins (dev dependencies)
npm install -D eslint@10.1.0 eslint-plugin-sql@3.4.1 eslint-plugin-security@4.0.0

# JWT verification (used in audit tests)
npm install jose@6.2.2

# Coverage (dev dependency)
npm install -D c8@11.0.0

# Semgrep (Python, not npm — install once per dev machine / CI runner)
pip install semgrep

# Atlas CLI (standalone binary — not npm)
# Linux/macOS:
curl -sSf https://atlasgo.sh | sh
# Windows: https://atlasgo.io/docs — download pre-built binary
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| ESLint custom rules | SonarJS | If the team already runs SonarQube. For this project, SonarJS requires a SonarQube server — overkill for a single-product audit. ESLint runs locally and in CI without infrastructure. |
| Semgrep | CodeQL | CodeQL is better for security research and CVE discovery. For architectural compliance (agent-tier boundary checking), Semgrep's pattern syntax is simpler and rules are easier to review. CodeQL requires GitHub Advanced Security license. |
| `jose` (6.x) | `jsonwebtoken` (9.x) | Only if the codebase already uses `jsonwebtoken` deeply. For net-new JWT audit test code, `jose` is unambiguously better: ESM-native, no CVE history for algorithm confusion, actively maintained. |
| `c8` | `nyc` | `nyc` if you're on CommonJS. This project is pure ESM (`"type": "module"`), and `c8` works natively without Istanbul instrumentation hacks. |
| Atlas CLI | `node-pg-migrate` (8.0.4) | `node-pg-migrate` is a migration tool, not a schema test tool. Atlas's `atlas schema test` command is purpose-built for constraint assertion. Use both if needed: `node-pg-migrate` for running migrations, Atlas for testing constraint behavior. |
| `pg` catalog queries | pgAudit server logs | pgAudit is a verification-time tool (confirms audit logs are generated). `pg_catalog` queries are an audit-time tool (verify constraints exist). Both serve different purposes; the catalog queries are the audit mechanism. |
| `node:crypto` (built-in) | `@node-rs/crc32` or `hash.js` | Only if you need non-SHA256 algorithms. SHA256 via `node:crypto` is the correct choice for hash-chain integrity — zero dependencies, hardware-accelerated, P4 compliant. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Jest | Violates P4. Requires babel/transform for ESM, adds significant dep tree, incompatible with `--experimental-test-module-mocks` used in existing tests. Would require rewriting all 5 test files. | `node:test` (already in use) |
| ORM-based audit queries (Prisma, Drizzle, Sequelize) | Violates P4 and the explicit "No ORM" convention. ORM introspection of `pg_catalog` is unreliable and masks the exact SQL being run. | Raw `pg` queries against system catalogs |
| `jsonwebtoken` for new audit code | Has historical CVE issues around algorithm confusion. Not ESM-native (requires CJS interop). Maintenance velocity lower than `jose`. | `jose` 6.x |
| `eslint-plugin-node` (11.1.0) | Superseded by `eslint-plugin-n` (the maintained fork). `eslint-plugin-node` is effectively unmaintained since 2021. | `eslint-plugin-n` if Node.js-specific rules are needed |
| Embedding Semgrep as an npm package | The npm package `semgrep` (0.0.1) is a stub placeholder — not the real tool. Semgrep is a Python binary. | Install via `pip install semgrep` or `brew install semgrep` |
| Custom hash-chain library | Adds an external dep for 3 lines of `node:crypto` code. The hash-chain verification pattern is O(n) SHA256 calls — trivially implementable without a library. | `node:crypto` |

---

## Stack Patterns by Audit Area

**For P1 (Deny by default) — SQL injection surface:**
- Use `eslint-plugin-sql` with rule `sql/no-unsafe-query` to catch string concatenation in `pg` calls
- Supplement with Semgrep rules matching `db.query(... + ...)` or template literal SQL patterns
- All violations are blocking — P1 is non-negotiable

**For P2 (Infrastructure enforces) — guardrail bypass detection:**
- Semgrep custom rules: detect any `if (agentTier === 'executor')` style prompt-level checks that should be DB constraints
- ESLint custom rule: flag direct calls to `transition_state()` outside `guardCheck()` context
- Atlas schema tests: verify `CHECK` constraints exist on the relevant columns

**For P3 (Transparency by structure) — hash-chain integrity:**
- `node:crypto` in a dedicated `test/audit-integrity.test.js` — iterates all rows in `agent_graph.state_transitions`, computes expected chain, asserts `prev_hash` linkage
- Runs against Docker Postgres in CI, not PGlite (PGlite is demo-only per existing CLAUDE.md)

**For JWT-scoped agent identity (§5 target architecture):**
- `jose` for writing tests that verify token claims: `{ sub: 'executor-triage', tier: 'executor', scope: ['task:read', 'task:update'] }`
- Negative tests: assert tokens with wrong `alg` claim are rejected, tokens without `scope` fail capability checks
- These tests are aspirational — they document the target architecture before implementation exists

**For Postgres RLS and cross-schema FK (§5, §12):**
- Direct `pg` queries against `pg_class`, `pg_policies`, `pg_constraint` in `test/db-constraints.test.js`
- Verify: `relrowsecurity = true` for all tables in `agent_graph` schema (target)
- Verify: zero rows in a cross-schema FK detection query (currently required — P1 enforcement)
- Run with Docker Postgres only; skip gracefully when `DATABASE_URL` is unset (PGlite fallback)

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `eslint@10.x` | Node.js 20+ | ESLint 10 requires Node 18+. Uses flat config (`eslint.config.js`), not `.eslintrc`. |
| `eslint-plugin-sql@3.x` | `eslint@8+` | Works with ESLint 9/10 flat config. |
| `eslint-plugin-security@4.x` | `eslint@8+` | Compatible with ESLint 10 flat config. |
| `jose@6.x` | Node.js 20+ | ESM-native. No CommonJS shim needed given `"type": "module"` in `package.json`. |
| `c8@11.x` | Node.js 20+, ESM | Works without transpilation for ESM. Reads V8 coverage natively. |
| Atlas CLI | Postgres 13+ | The codebase uses `pgvector/pgvector:pg17` in Docker — fully compatible. |
| Semgrep (pip) | Python 3.8+ | Separate from Node stack. Runs in CI as a pre-commit or PR check. |

---

## Sources

- npm registry (live): `eslint@10.1.0`, `jose@6.2.2`, `jsonwebtoken@9.0.3`, `eslint-plugin-sql@3.4.1`, `eslint-plugin-security@4.0.0`, `c8@11.0.0` — all verified April 2026
- [Semgrep JavaScript docs](https://semgrep.dev/docs/languages/javascript) — JavaScript/TypeScript support confirmed, custom YAML rules, 3,000+ community rules
- [Semgrep September 2025 release notes](https://semgrep.dev/docs/release-notes/september-2025) — 3x performance improvement, native Windows support
- [Atlas schema testing docs](https://atlasgo.io/testing/schema) — `atlas schema test` confirmed for constraint/FK/trigger testing in Postgres
- [PostgreSQL 18 RLS docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — `pg_class.relrowsecurity`, `pg_policies` catalog queries confirmed
- [jose GitHub](https://github.com/panva/jose) — ESM-native, actively maintained, recommended over `jsonwebtoken` for 2025+
- [DEV Community: Why delete jsonwebtoken in 2025](https://dev.to/silentwatcher_95/why-you-should-delete-jsonwebtoken-in-2025-1o7n) — MEDIUM confidence (single source, but aligns with jose's active development trajectory)
- [ESLint custom rules docs](https://eslint.org/docs/latest/extend/custom-rules) — AST traversal for architectural enforcement confirmed
- [Building tamper-evident audit log with hash chains](https://dev.to/veritaschain/building-a-tamper-evident-audit-log-with-sha-256-hash-chains-zero-dependencies-h0b) — hash-chain verification pattern (no-dependency approach) confirmed
- [OWASP JWT testing guide](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/10-Testing_JSON_Web_Tokens) — scope claim verification patterns confirmed
- Existing codebase analysis: `.planning/codebase/STACK.md`, `autobot-inbox/package.json`, `autobot-inbox/CLAUDE.md` — confirmed Node 20+, ESM, no ORM, `pg` 8.19, PGlite for dev

---

*Stack research for: Optimus spec compliance audit (governed agent organization)*
*Researched: 2026-04-01*

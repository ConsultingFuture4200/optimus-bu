# Coding Conventions

**Analysis Date:** 2026-04-01

## Overview

Optimus follows pragmatic conventions derived from the architecture specification (SPEC.md §0: Design Principles) and the CLAUDE.md governance framework. Code is intentionally boring — prioritizing safety, auditability, and infrastructure enforcement over framework shortcuts or syntactic sugar.

## Naming Patterns

### Files

**JavaScript/Node.js:**
- `kebab-case.js` for all files: `executor-responder.js`, `guard-check.js`, `agent-loop.js`
- Test files: `feature-name.test.js` (co-located with source)
- Config files: `kebab-case.json` (JSON only): `agents.json`, `gates.json`, `routing.json`
- Directories: `kebab-case/` for multi-file modules: `src/agents/claw-campaigner/`, `src/runtime/`

**TypeScript/Next.js (dashboard):**
- PascalCase for component files: `SetupBanner.tsx`, `KillSwitch.tsx`, `NavBar.tsx`
- camelCase for utilities: `useApiProxy.ts`, `sessionProvider.ts`
- Page routes follow Next.js convention: `app/audit/page.tsx`, `app/api/proxy/route.ts`

### Functions

**camelCase throughout:**
```javascript
// Good
export async function guardCheck({ action, agentId }) { }
export async function checkDraftGates(draft, profile) { }
export function validateInputAdapter(adapter) { }
async function evaluateL0Exit() { } // Private async: no export prefix

// Also good - module-scoped helpers
async function measureG1() { }
```

**Prefixes for clarity:**
- Query functions: `get*`, `query*`: `getProfile()`, `getAdapter()`
- State checks: `is*`, `has*`, `can*`: `isPathAllowed()`, `hasPermission()`
- Initialize/setup: `init*`: `initializeDatabase()`, `initPgNotify()`
- Measurement: `measure*`: `measureAllGates()`, `measureGate()`
- Build: `build*`: `buildPromptContext()`, `buildGlobalProfile()`
- Load/fetch: `load*`, `fetch*`: `loadContext()`, `fetchContent()`

### Variables

**camelCase for all variables:**
```javascript
// Good
const poolSize = 25;
let pgListenClient = null;
const agentRegistry = { ... };
const enabledAgents = agents.filter(a => a.enabled);

// Also good - descriptive compound names
const USE_REAL_PG = !!process.env.DATABASE_URL;
const NOREPLY_PATTERNS = /^(noreply|no-reply)/i; // SCREAMING_SNAKE_CASE for constants
const SQL_DIR = join(__dirname, '..', 'sql');
```

**Constants:** `SCREAMING_SNAKE_CASE` when module-scoped:
```javascript
const API_URL = process.env.API_URL || 'http://localhost:3001';
const DEMO_MODE = process.argv.includes('--demo');
const ALLOWED_PATHS = ['/api/gates', '/api/status'];
```

**Convention for DB columns:** Match database schema exactly (snake_case in queries):
```javascript
// Query uses snake_case from schema
const result = await query(
  `SELECT id, account_id, from_address, provider_msg_id FROM inbox.messages`
);
// Result object keys are also snake_case
result.rows[0].account_id // ✓ Not accountId
```

**Destructure purposefully:** Extract only what's used in the function:
```javascript
// Good
export async function handler(task, context, agent) {
  const { email } = context;
  const { workItem } = context;
  const emailBody = context.emailBody;
  // ...
}

// Avoid over-destructuring
export async function handler(task, context, agent) {
  const { email, workItem, emailBody, promptContext } = context; // Too much if not all used
}
```

### Types

**TypeScript interfaces/types (dashboard only):** PascalCase
```typescript
// In .tsx/.ts files
interface PromptContext {
  channel: string;
  body: string | null;
  contentLabel: string;
}

type ApiResponse = { data: unknown; error?: string };
```

**JSDoc type hints in JS files:** Use @typedef (see Comments section):
```javascript
/**
 * @typedef {Object} PromptContext
 * @property {string} channel
 * @property {string|null} body
 */
```

## Code Style

### Formatting

No `.prettierrc` or `.eslintrc` is used. Code style is enforced through:
1. **Deliberate choice** — developers write clean code, not tools
2. **PR review** — discussed during human review
3. **Specification** — SPEC.md design principles guide choices

**Observed patterns:**
- 2-space indentation (matches Node.js/Google style)
- Semicolons present (explicit over implicit; matches spec for clarity)
- No trailing commas in objects (except in arrays where git diffs are cleaner)
- Blank lines between logical sections (readability over density)
- Max line length: ~100 characters (pragmatic, not enforced)

### Quotation

- Double quotes for strings: `"hello"`
- Single quotes for regex patterns: `'utf-8'`
- Template literals only when interpolation is present: `` `SELECT * FROM users WHERE id = $1` ``
- No unnecessary backticks for single strings

### Import Organization

**Order (ascending strictness):**
1. Node.js built-ins: `import { readFileSync } from 'fs'`
2. Third-party npm packages: `import pg from 'pg'`, `import { query } from '../db.js'`
3. Local project files: `import { guardCheck } from '../runtime/guard-check.js'`
4. Blank line between groups (required)

**ES Modules throughout:**
```javascript
// Good (ES modules)
import { query } from '../db.js';
import { eventBus } from './event-bus.js';

// Never
const { query } = require('../db.js'); // ✗ CommonJS not used
```

**Relative paths only for local imports:**
- Use relative paths: `import { db } from '../db.js'` (good for refactoring)
- Never use absolute aliases or `@/` imports in backend (only in Next.js dashboard)
- Exception: Next.js dashboard uses `@/` (configured in tsconfig.json)

**Barrel files (index.js):** Used sparingly, only for multi-file modules:
```javascript
// src/agents/claw-campaigner/index.js (re-exports for convenience)
export { campaignLoop } from './campaign-loop.js';
export { strategyPlanner } from './strategy-planner.js';
```

## Error Handling

### Strategy: Fail Loudly, Fail Early

P2 (Infrastructure enforces) applies to errors — validation is at entry points, not scattered.

**Pattern: Guard clauses at function start:**
```javascript
export async function handler(task, context, agent) {
  const email = context.email;
  if (!email) return { success: false, reason: 'No email context' };

  const emailBody = context.emailBody;
  // ... continue knowing email exists
}
```

**Pattern: Explicit returns for errors:**
```javascript
if (replyHistory.rows.length === 0 && !knownContact.rows.length) {
  return { 
    success: true, 
    reason: `Skipped: no prior reply history with ${email.from_address}` 
  };
}
```

**Pattern: Try-catch for async operations:**
```javascript
async function runMigrations() {
  try {
    const files = readdirSync(SQL_DIR);
    for (const file of files) {
      await runMigration(file);
    }
  } catch (err) {
    console.error('[db] Migration failed:', err.message);
    throw err; // Propagate, don't swallow
  }
}
```

**Pattern: Atomic transactions with rollback:**
```javascript
await query('BEGIN');
try {
  await query(`DELETE FROM table WHERE id = $1`, [id]);
  await query(`INSERT INTO audit_log (action) VALUES ($1)`, ['deleted']);
  await query('COMMIT');
} catch (err) {
  await query('ROLLBACK');
  throw err;
}
```

**Never silently catch:**
```javascript
// Bad
try { await someAsync(); } catch (err) { }

// Good (explicit intent)
try { await someAsync(); } catch (err) {
  console.error('[module] Operation failed (non-critical):', err.message);
  return null; // Document why we swallow
}
```

**Pattern: Validation errors are structural:**
```javascript
export function validateInputAdapter(adapter) {
  const errors = [];
  
  if (!adapter || typeof adapter !== 'object') {
    errors.push('adapter must be a non-null object');
  }
  
  // Collect all errors, return shape
  return { valid: errors.length === 0, errors };
}
```

### Shape Convention: `{ success, reason }` or `{ valid, errors }`

- Validation functions return: `{ valid: boolean, errors: string[] }`
- Handler functions return: `{ success: boolean, reason: string }`
- Query functions throw or return data directly (no wrapper)

## Logging

### Framework: `console` (Node.js built-in)

No logging library. Use `console.log`, `console.warn`, `console.error` directly.

**Pattern: Prefixed logs with agent/module ID:**
```javascript
console.log('[event-bus] pg_notify listener active (LISTEN autobot_events)');
console.warn('[architect] Autonomy evaluation failed: ${err.message}');
console.error('[campaigner] Campaign ${campaignId} not found');
```

**Format:** `[module-name] message`

**Levels:**
- `console.log()` — Informational, normal operation
- `console.warn()` — Non-fatal errors, recoverable issues
- `console.error()` — Fatal errors, escalation triggers

**Never log sensitive data:**
- No API keys, tokens, or secrets
- No PII beyond role/ID
- No full query results for large datasets

**What to log:**
- Agent lifecycle: starting, loop iteration count, exit conditions
- Configuration: settings applied, migrations run
- Gate checks: which gates passed/failed, why
- Latency: `console.time()` / `console.timeEnd()` for perf-critical sections

## Comments

### When to Comment

**Document the WHY, not the WHAT:**
```javascript
// Good — explains tricky logic
// Guard: never draft replies to newsletters/marketing (unsubscribe in footer/headers)
if (emailBody && /unsubscribe/i.test(footer)) {
  return { success: true, reason: 'Skipped: newsletter/marketing email' };
}

// Mediocre — restates code
// Check if emailBody exists and contains unsubscribe
if (emailBody && /unsubscribe/i.test(footer)) { }
```

**Document design decisions:**
```javascript
// D1: Metadata-only email storage. Never store body in DB.
// Fetch on-demand via adapter (Gmail, Outlook, or inline for Slack).
// Rationale: smaller schema, supports multi-tenancy, privacy by design.
```

**Document non-obvious constraints:**
```javascript
// NOTE: Do not call close() here — PGlite WASM cannot be reinitialized
// after close in the same process, which breaks other PGlite-using test files.
// Process exit handles cleanup.
```

### JSDoc/TSDoc

**Function documentation:** Use JSDoc for public functions:
```javascript
/**
 * Atomic guard check. Called WITHIN the same transaction as transition_state.
 * P2: Infrastructure enforces, prompts advise.
 *
 * @param {Object} opts
 * @param {string} opts.action - What the agent wants to do
 * @param {string} opts.agentId - Who is doing it
 * @param {number} [opts.estimatedCostUsd] - Expected cost of this action (optional)
 * @returns {Promise<{allowed: boolean, failedChecks: string[], reason: string}>}
 */
export async function guardCheck({ action, agentId, estimatedCostUsd = 0 }) { }
```

**Typedef for complex types:**
```javascript
/**
 * @typedef {Object} PromptContext
 * @property {string} channel - 'email', 'slack', etc.
 * @property {string|null} body - Full message body (may be null if unavailable)
 * @property {string} contentLabel - Label for untrusted content
 * @property {{ name: string, address: string }} sender
 */
```

**Parameter documentation:**
- `[optional]` for optional parameters (not required)
- `*` for any type (avoid; be specific)
- Union types: `string|null`, `string|number`

**No JSDoc for private functions** (no export) — self-documenting code is fine:
```javascript
// Private helper — no JSDoc needed if name + structure are clear
async function evaluateL0Exit() {
  // ...
}
```

## Function Design

### Size

**Target: 30–50 lines.** Functions longer than ~80 lines are candidates for refactoring.

**Natural breakpoints suggest splitting:**
```javascript
// Too long — split at `await`
async function handleEmail(email) {
  // 30 lines: guard checks
  if (!email) return { success: false };
  
  // 20 lines: fetch profile
  const profile = await getProfile(email.from_address);
  
  // 40 lines: build prompt + call LLM
  const prompt = buildPrompt(...);
  const response = await callLLM(prompt);
  
  // Refactor: extract buildPromptAndCall()
  return { success: true, response };
}
```

### Parameters

**Prefer objects over positional arguments:**
```javascript
// Good
export async function checkDraftGates(draft, profile = null, client = null, reserved = null, actionType = 'email_draft') { }
// Called: checkDraftGates(draft, null, stubClient, null, 'content_post')

// Better (clearer call site)
export async function checkDraftGates(opts) {
  const { draft, profile = null, client = null, reserved = null, actionType = 'email_draft' } = opts;
}
// Called: checkDraftGates({ draft, actionType: 'content_post', client: stubClient })
```

**Destructure at function start:**
```javascript
export async function guardCheck({ action, agentId, configHash, taskId = null, estimatedCostUsd = 0, context = {}, client = null }) {
  // Parameters unpacked immediately — no guessing what taskId is
}
```

### Return Values

**Consistency over verbosity:**
- Validation functions: `{ valid: boolean, errors: string[] }`
- Query functions: raw result or throw (no wrapper)
- Handlers: `{ success: boolean, reason: string }` or thrown error
- Async operations: return result directly or throw

**Never return null for errors — use exceptions or explicit error structures:**
```javascript
// Good
if (!result) throw new Error('Database returned no rows');

// Also good — explicit error structure
return { success: false, reason: 'Failed to fetch profile' };

// Bad
return null; // Caller doesn't know why
```

## Module Design

### Exports

**Export one main function per file when possible:**
```javascript
// guard-check.js — exports main function + helpers if needed
export async function guardCheck({ ... }) { }
export async function checkDraftGates(draft, ...) { }

// Simple modules do one thing
// event-bus.js
export async function subscribe(agentId, callback) { }
export async function emit(event) { }
export async function initPgNotify() { }
```

**Organize exports by public/private:**
```javascript
// Public exports first, private helpers below (no export keyword)
export async function publicFunction() { }

async function privateHelper() { } // Not exported
```

### Barrel Files

**Use sparingly — only for multi-file feature modules:**
```
src/agents/claw-campaigner/
├── index.js           # Barrel: exports campaign-loop, strategy-planner, etc.
├── campaign-loop.js
├── strategy-planner.js
└── circuit-breaker.js
```

**Good use:**
```javascript
// src/agents/claw-campaigner/index.js
export { campaignLoop } from './campaign-loop.js';
export { strategyPlanner } from './strategy-planner.js';
export { getRemaining, resetCircuit } from './circuit-breaker.js';
```

**Avoid barrel files for simple modules:**
```javascript
// Don't do this — adds indirection
src/utils/
├── index.js  // ✗ Unnecessary
├── helpers.js
└── validators.js
```

## Async/Await

**Always async for operations that might block:**
```javascript
// Good
export async function guardCheck(opts) {
  const result = await queryFn('SELECT ...', [params]);
  return result;
}

// Bad — query is async but not awaited
export function guardCheck(opts) {
  const result = queryFn('SELECT ...', [params]); // Returns Promise!
  return result;
}
```

**Pattern: Async loops with concurrency control:**
```javascript
// Sequential when order matters
for (const item of items) {
  await processItem(item); // Wait for each
}

// Parallel when safe (use Promise.all)
await Promise.all(items.map(item => processItem(item)));

// Controlled parallelism
const results = [];
for (let i = 0; i < items.length; i += batchSize) {
  const batch = items.slice(i, i + batchSize);
  results.push(await Promise.all(batch.map(processItem)));
}
```

## Database Access

### SQL Patterns

**P1 & P4: Parameterized queries only. Never string interpolation.**

```javascript
// Good
await query('SELECT * FROM users WHERE id = $1 AND role = $2', [userId, role]);

// Bad — SQL injection vulnerability
await query(`SELECT * FROM users WHERE id = ${userId} AND role = '${role}'`);
```

**Dynamic WHERE clauses with parameterization:**
```javascript
const params = [];
let clause = `SELECT * FROM users WHERE 1=1`;

if (userId) {
  params.push(userId);
  clause += ` AND id = $${params.length}`;
}

if (role) {
  params.push(role);
  clause += ` AND role = $${params.length}`;
}

await query(clause, params);
```

**Transactions for atomic operations:**
```javascript
await query('BEGIN');
try {
  await query('DELETE FROM table WHERE id = $1', [id]);
  await query('INSERT INTO audit_log ... VALUES (...)', [...]);
  await query('COMMIT');
} catch (err) {
  await query('ROLLBACK');
  throw err;
}
```

### Result Handling

**Check rowCount for data changes:**
```javascript
const result = await query('UPDATE users SET active = $1 WHERE id = $2', [true, userId]);
if (result.rowCount === 0) {
  throw new Error('User not found');
}
```

**Extract from rows array:**
```javascript
const result = await query('SELECT id, email FROM users WHERE id = $1', [userId]);
if (result.rows.length === 0) {
  return null;
}
const user = result.rows[0];
```

---

*Convention analysis: 2026-04-01*

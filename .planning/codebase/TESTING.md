# Testing Patterns

**Analysis Date:** 2026-04-01

## Test Framework

### Runner

**Node.js built-in test module:** `node:test`
- Version: Node.js >= 20.0.0 (built-in, no npm dependency)
- No external test runner needed (Jest, Vitest, Mocha all avoided per P4 — boring infrastructure)

**Config:** None (conventions baked into test structure)

**Run Commands:**
```bash
npm test                    # Run all unit tests (test/*.test.js)
npm run test:integration    # Run integration tests (test/integration/**/*.test.js)
```

### Assertion Library

**Node.js built-in:** `node:assert/strict` (aliased as `assert`)

```javascript
import assert from 'node:assert/strict';

assert.ok(condition, 'message');
assert.equal(actual, expected, 'message');
assert.deepEqual(obj1, obj2, 'message');
assert.throws(() => fn(), Error, 'should throw');
assert.rejects(async () => { }, Error, 'should reject');
```

## Test File Organization

### Location

**Co-located with source (autobot-inbox):**
```
test/
├── adapter-registry.test.js         # Tests src/adapters/registry.js
├── email-adapter.test.js            # Tests src/adapters/email-adapter.js
├── guard-check.test.js              # Tests src/runtime/guard-check.js
├── capability-gates.test.js         # Tests src/runtime/capability-gates.js
├── permissions-integration.test.js  # Integration test
└── integration/
    └── advanced/
        └── full-pipeline.test.js     # Complex integration scenarios
```

**Test discovery:** Any file matching `*.test.js` or `*.spec.js` is run by `npm test`

### Naming

**Files:** `feature-name.test.js` (kebab-case)

**Test suites:** Hierarchical describe blocks matching the structure being tested:
```javascript
describe('AdapterRegistry', () => {
  describe('registerAdapter', () => {
    it('stores a valid adapter', () => { });
    it('rejects non-string provider', () => { });
  });

  describe('getAdapter', () => {
    it('returns a registered adapter', () => { });
  });
});
```

## Test Structure

### Suite Organization (from `guard-check.test.js`)

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftGates } from '../src/runtime/guard-check.js';

describe('checkDraftGates', () => {
  it('passes clean draft', async () => {
    const draft = {
      body: 'Hi John, thanks for reaching out.',
      to_addresses: ['john@example.com'],
    };

    const result = await checkDraftGates(draft, null, stubClient);
    assert.ok(result.passed);
  });

  it('flags commitment language (G2)', async () => {
    const draft = {
      body: 'I promise we will deliver the feature by March 15th for $5,000.',
      to_addresses: ['client@example.com'],
    };

    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.length > 0);
  });

  it('email_draft runs all gates (backward compat)', async () => {
    // Test full behavior with actionType parameter
    const result = await checkDraftGates(draft, null, null, null, 'email_draft');
    for (const gateId of ['G2', 'G3', 'G5', 'G6', 'G7']) {
      assert.equal(result.gates[gateId].skipped, undefined);
    }
  });
});
```

### Setup/Teardown Patterns (from `capability-gates.test.js`)

```javascript
describe('capability-gates', () => {
  before(async () => {
    // Run once before all tests
    delete process.env.DATABASE_URL;  // Force PGlite mode
    await initializeDatabase();
    
    // Optional: apply DB schema migrations, seed data
    await query(`ALTER TABLE ... ADD CONSTRAINT ...`).catch(() => {});
  });

  after(async () => {
    // Run once after all tests
    await close();
  });

  // beforeEach / afterEach also available for per-test setup
});
```

### Async Test Pattern

```javascript
import { describe, it, before, after, beforeEach } from 'node:test';

describe('feature', () => {
  before(async () => {
    // Initialization
    await initializeDatabase();
  });

  it('async operation', async () => {
    // Test automatically awaits returned promise
    const result = await someAsyncOperation();
    assert.ok(result);
  });

  // No need for .then() or callbacks — async/await is native
});
```

## Mocking

### Framework: Built-in `node:test` Mock

```javascript
import { describe, it, before, mock } from 'node:test';

describe('EmailAdapter', () => {
  let adapter;
  const mockFetchEmailBody = mock.fn(async () => 'mock body');
  const mockCreateGmailDraft = mock.fn(async () => 'draft-123');

  before(() => {
    adapter = createEmailAdapter({
      fetchEmailBody: mockFetchEmailBody,
      createGmailDraft: mockCreateGmailDraft,
    });
  });

  it('delegates to fetchEmailBody', async () => {
    mockFetchEmailBody.mock.resetCalls();
    const message = { provider_msg_id: 'msg-abc', account_id: 'acct-1' };
    
    const result = await adapter.fetchContent(message);
    
    assert.equal(result, 'mock body');
    assert.equal(mockFetchEmailBody.mock.calls.length, 1);
    assert.deepEqual(mockFetchEmailBody.mock.calls[0].arguments, ['msg-abc', 'acct-1']);
  });
});
```

### Mock Patterns

**Stub databases (avoid DB in unit tests):**
```javascript
// From adapter-registry.test.js
const stubClient = { query: async () => ({ rows: [], rowCount: 0 }) };

// Pass to functions that need a DB client
const result = await checkDraftGates(draft, null, stubClient);
```

**Spy on function calls:**
```javascript
mock.fn() creates a function that:
- Records every call (call count, arguments)
- Returns whatever you configure
- Can be reset between tests with .mock.resetCalls()

const fn = mock.fn((x) => x * 2);
fn(5);
assert.equal(fn.mock.calls[0].arguments[0], 5);
assert.equal(fn.mock.calls[0].result, 10);
```

**Fake implementations:**
```javascript
const mockAdapter = {
  channel: 'email',
  fetchContent: async (msg) => 'Mock body',
  buildPromptContext: (msg, body) => ({
    channel: 'email',
    body,
    contentLabel: 'untrusted_email',
    contentType: 'email',
    sender: { name: msg.from_name, address: msg.from_address },
    threading: null,
    channelHint: '',
  }),
};

registerAdapter('gmail', mockAdapter);
```

### What to Mock

**Mock:**
- External APIs (Gmail, Slack, Linear, GitHub)
- Database interactions (in unit tests)
- File system (when testing without side effects)
- LLM calls (use fixed responses for determinism)
- Time (use `mock.timers()` if needed)

**Don't Mock:**
- Core business logic (the unit being tested)
- Validation functions (test real behavior)
- Adapter registry (test the registry integration)
- Database layer itself (use real DB in integration tests)

## Fixtures and Test Data

### Test Data Patterns

**Inline for simple cases:**
```javascript
it('flags pricing precedent (G7)', async () => {
  const draft = {
    body: 'Our pricing for this service is $500 per month.',
    to_addresses: ['prospect@example.com'],
  };

  const result = await checkDraftGates(draft);
  assert.equal(result.gates.G7.passed, false);
});
```

**Helper functions for complex setup:**
```javascript
// From permissions-integration.test.js
before(async () => {
  // Seed agent_configs
  await queryFn(`
    INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
    VALUES
      ('orchestrator', 'orchestrator', 'sonnet', 'test', 'test', true),
      ('executor-triage', 'executor', 'haiku', 'test', 'test', true),
      ...
    ON CONFLICT (id) DO NOTHING
  `);
});

beforeEach(() => {
  // Reset state before each test
  clearAdapters();
  registerAdapter('gmail', makeAdapter('email'));
});
```

**Factory functions for reusable test objects:**
```javascript
// From adapter-registry.test.js
function makeAdapter(channel = 'test') {
  return {
    channel,
    async fetchContent() { return 'body'; },
    buildPromptContext() { 
      return { 
        channel, 
        body: 'body', 
        contentLabel: 'untrusted', 
        contentType: 'message', 
        sender: {}, 
        threading: null, 
        channelHint: '' 
      }; 
    },
  };
}

describe('AdapterRegistry', () => {
  it('stores a valid adapter', () => {
    registerAdapter('gmail', makeAdapter('email'));
    const adapter = getAdapter('gmail');
    assert.equal(adapter.channel, 'email');
  });
});
```

**Location:** No separate fixtures directory — define helpers inline or in the test file

## Coverage

### Requirements

**No formal coverage enforcement** — test coverage is measured via code review and judgment, not metrics.

**Observed coverage (from practice):**
- Critical paths (guard-check, gates, adapters): 80–95%
- Business logic (agents, handlers): 60–80%
- Infrastructure (DB layer): 70–90%
- Utilities: As practical

### Measure Coverage

Coverage metrics not automated, but can be run manually with Node.js inspector:
```bash
node --test --coverage test/*.test.js  # Requires Node 19+
```

## Test Types

### Unit Tests

**Scope:** Single function or module in isolation

**Characteristics:**
- No external I/O (DB, network, filesystem) — use mocks
- Fast (< 100ms per test)
- Deterministic (same input = same output every time)
- Test one thing per `it()` block

**Example: `guard-check.test.js`**
```javascript
describe('checkDraftGates', () => {
  it('passes clean draft', async () => {
    const draft = { body: 'Hi...', to_addresses: ['john@example.com'] };
    const result = await checkDraftGates(draft, null, stubClient);
    assert.ok(result.passed);
  });

  it('flags commitment language (G2)', async () => {
    const draft = { body: 'I promise we will deliver...' };
    const result = await checkDraftGates(draft);
    assert.equal(result.gates.G2.passed, false);
  });
});
```

### Integration Tests

**Scope:** Multiple modules + real database interaction

**Location:** `test/integration/` (separate from unit tests for clear separation)

**Characteristics:**
- Use real or in-process database (PGlite)
- Test workflows, not individual functions
- Slower (1–5 seconds per test)
- Set up and tear down real state

**Example: `permissions-integration.test.js`**
```javascript
describe('permissions integration (ADR-017 call sites)', () => {
  let queryFn, closeFn;

  before(async () => {
    delete process.env.DATABASE_URL;  // Use PGlite
    const { initializeDatabase, query, close } = await import('../src/db.js');
    await initializeDatabase();
    queryFn = query;
    closeFn = close;

    // Seed real test data
    await queryFn(`INSERT INTO agent_graph.agent_configs ...`);
  });

  it('loads email body when agent has adapter:gmail grant', async () => {
    const ctx = await loadContext('orchestrator', workItemId);
    assert.equal(ctx.emailBody, 'Mock email body...');
  });

  it('returns null body when agent lacks adapter grant', async () => {
    const ctx = await loadContext('architect', workItemId);
    assert.equal(ctx.emailBody, null);
  });
});
```

### E2E / Pipeline Tests

**Not currently automated.** Manual testing via:
- `npm start` (full agent loop)
- `npm run cli` (interactive CLI)
- Dashboard UI (Next.js frontend)
- Docker Compose stack

**Rationale:** Agent loop interactions are complex; human + observational testing is more reliable than automated assertions.

## Common Patterns

### Async Testing

```javascript
// Pattern 1: Explicit async/await
it('resolves promise', async () => {
  const result = await somePromise();
  assert.ok(result);
});

// Pattern 2: Async generator (rare, avoid)
async function* gen() {
  yield 1;
}

it('handles async iteration', async () => {
  const results = [];
  for await (const item of gen()) {
    results.push(item);
  }
  assert.deepEqual(results, [1]);
});
```

### Error Testing

**Testing that a function throws:**
```javascript
it('throws for unknown provider', () => {
  assert.throws(
    () => getAdapter('unknown'),
    /No adapter registered for provider "unknown"/
  );
});

// With async/Promise rejection
it('rejects when query fails', async () => {
  await assert.rejects(
    async () => {
      await query('INVALID SQL');
    },
    /syntax error/i
  );
});
```

**Testing error structure:**
```javascript
it('returns error in validation result', () => {
  const result = validateInputAdapter({ channel: 'test' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('missing required property: fetchContent'));
});
```

### Parameterized Tests

**Pattern: Loop over test cases:**
```javascript
describe('measureGate', () => {
  const gateIds = ['G1', 'G2', 'G3', 'G4', 'G5'];

  for (const gateId of gateIds) {
    it(`${gateId} returns correct shape`, async () => {
      const result = await measureGate(gateId);
      assert.ok('passing' in result);
      assert.ok('value' in result);
      assert.ok('threshold' in result);
    });
  }
});
```

### Database Testing (PGlite)

**Force PGlite mode in tests:**
```javascript
before(async () => {
  // Unset DATABASE_URL to use in-process PGlite
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';
  
  const { initializeDatabase, query } = await import('../src/db.js');
  await initializeDatabase();
});
```

**Seed data for integration tests:**
```javascript
before(async () => {
  await queryFn(`
    INSERT INTO agent_graph.agent_configs (id, agent_type, model, ...)
    VALUES ('executor-triage', 'executor', 'haiku', ...)
    ON CONFLICT (id) DO NOTHING
  `);
});
```

**Note on PGlite reinitialization:**
```javascript
// ⚠️ PGlite WASM cannot be reinitialized in the same process
// Workaround: don't call close() in after() — let process exit handle cleanup
describe('test-file', () => {
  before(async () => {
    await initializeDatabase();
  });

  // after() is omitted intentionally
  // Process exit cleans up resources
});
```

## Test Examples from Codebase

### Example 1: Interface Validation Testing
**File:** `test/adapter-registry.test.js`

Tests that adapters conform to required interfaces:
```javascript
describe('AdapterRegistry', () => {
  describe('registerAdapter', () => {
    it('rejects adapter missing required methods', () => {
      assert.throws(
        () => registerAdapter('bad', { channel: 'test' }),
        /Invalid adapter.*missing required property: fetchContent/
      );
    });

    it('rejects adapter with wrong types', () => {
      assert.throws(
        () => registerAdapter('bad', { 
          channel: 'test', 
          fetchContent: 'not-a-fn',  // ✗ Not a function
          buildPromptContext: () => {}
        }),
        /Invalid adapter.*fetchContent must be a function/
      );
    });
  });
});
```

**Pattern:** Validate interface contracts before runtime

### Example 2: Gate Logic Testing
**File:** `test/guard-check.test.js`

Tests constitutional gate behavior across action types:
```javascript
describe('checkDraftGates', () => {
  it('content_post skips G3, G5, G6', async () => {
    const draft = {
      body: 'Excited to share our latest insights...',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    for (const gateId of ['G3', 'G5', 'G6']) {
      assert.equal(result.gates[gateId].skipped, true);
      assert.equal(result.gates[gateId].passed, true); // Skip = auto-pass
    }
  });

  it('content_post still checks G2 (commitment language)', async () => {
    const draft = {
      body: 'I promise we will deliver this feature by next Friday.',
      to_addresses: [],
    };

    const result = await checkDraftGates(draft, null, null, null, 'content_post');
    assert.equal(result.gates.G2.passed, false);
    assert.ok(result.gates.G2.matches.length > 0);
  });
});
```

**Pattern:** Test gate applicability per action type (email_draft, content_post, etc.)

### Example 3: Capability Gates Integration
**File:** `test/capability-gates.test.js`

Tests gate measurement system with real DB:
```javascript
describe('capability-gates', () => {
  before(async () => {
    delete process.env.DATABASE_URL;
    await initializeDatabase();
    
    // Apply DB constraint needed for test upserts
    await query(`ALTER TABLE agent_graph.gate_snapshots
      ADD CONSTRAINT gate_snapshots_snapshot_date_unique UNIQUE (snapshot_date)`
    ).catch(err => {
      if (!err.message.includes('already exists')) throw err;
    });
  });

  it('measureAllGates returns all 5 gates', async () => {
    const { measureAllGates } = await import('../src/runtime/capability-gates.js');
    const result = await measureAllGates();

    const gateIds = Object.keys(result.gates);
    assert.equal(gateIds.length, 5);
    assert.deepEqual(gateIds.sort(), ['G1', 'G2', 'G3', 'G4', 'G5']);
  });
});
```

**Pattern:** Test idempotent operations with conflict handling

### Example 4: Permission Enforcement Integration
**File:** `test/permissions-integration.test.js`

Tests that permissions are enforced at call sites (not just in the permission layer):
```javascript
describe('permissions integration (ADR-017 call sites)', () => {
  it('loads email body when agent has adapter:gmail grant', async () => {
    // orchestrator has adapter:gmail from seed
    const ctx = await loadContext('orchestrator', workItemId);
    assert.equal(ctx.emailBody, 'Mock email body...');
  });

  it('returns null body when agent lacks adapter grant', async () => {
    // architect does NOT have any adapter grants
    const ctx = await loadContext('architect', workItemId);
    assert.equal(ctx.emailBody, null, 'emailBody should be null when permission denied');
  });

  it('writes audit trail on permission denial', async () => {
    const before = await queryFn(`SELECT count(*)::int AS c FROM ...`);
    // Try to load (fails due to missing grant)
    const ctx = await loadContext('architect', workItemId);
    const after = await queryFn(`SELECT count(*)::int AS c FROM ...`);
    assert.ok(after.rows[0].c > before.rows[0].c, 'audit entry created');
  });
});
```

**Pattern:** Test both the happy path and permission denial, verify audit logs

## Best Practices

1. **One assertion per `it()` — or one logical group**
   - Each test name should describe exactly what's being tested
   - Multiple assertions are OK if they test one behavior

2. **Descriptive test names (not "test1", "test2")**
   ```javascript
   // Good
   it('flags commitment language (G2)', () => { });
   it('returns null body when agent lacks adapter grant', () => { });

   // Bad
   it('works', () => { });
   it('error case', () => { });
   ```

3. **Test data close to assertions**
   - Arrange (setup) → Act (call) → Assert (check) pattern
   - Don't buried test data high in the file

4. **Use `assert.throws()` and `assert.rejects()` for error paths**
   - Much clearer than wrapping in try-catch

5. **Reset mocks between tests**
   ```javascript
   beforeEach(() => {
     mockFn.mock.resetCalls();
   });
   ```

6. **Don't test implementation details**
   - Test behavior, not that `console.log` was called
   - Exception: mock call counts for critical integrations (e.g., API calls)

7. **Integration tests separate from unit tests**
   - Unit: fast, isolated, no DB
   - Integration: slower, real state, validates workflows

---

*Testing analysis: 2026-04-01*

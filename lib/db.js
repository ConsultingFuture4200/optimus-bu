import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = process.env.SQL_DIR || (existsSync(join(process.cwd(), 'sql'))
  ? join(process.cwd(), 'sql')
  : join(__dirname, '..', 'sql'));

/**
 * Dual-mode database layer.
 *
 * DATABASE_URL set → real Postgres via `pg` Pool (production/Supabase).
 * DATABASE_URL unset → PGlite in-process (demo/dev).
 *
 * Same API surface either way: query(), withTransaction(), setAgentContext(), close().
 * P4: Boring infrastructure. No ORM. Parameterized queries only.
 */

const USE_REAL_PG = !!process.env.DATABASE_URL;
let pool = null;   // pg.Pool (real Postgres mode)
let pglite = null; // PGlite instance (demo mode)

// ============================================================
// Circuit breaker — skip non-critical DB ops when pool is unhealthy
// ============================================================
let _consecutiveErrors = 0;
let _circuitOpenUntil = 0;
let _circuitTripped = false;
const CIRCUIT_THRESHOLD = 3;       // errors before tripping
const CIRCUIT_COOLDOWN_MS = 30_000; // 30s backoff when tripped

function recordDbSuccess() {
  if (_circuitTripped) {
    console.log(`[db] Circuit breaker CLOSED — connection recovered after ${_consecutiveErrors} errors`);
    _circuitTripped = false;
  }
  _consecutiveErrors = 0;
}
function recordDbError() {
  _consecutiveErrors++;
  if (_consecutiveErrors >= CIRCUIT_THRESHOLD) {
    _circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    // Only log on initial trip, not every subsequent error
    if (!_circuitTripped) {
      console.warn(`[db] Circuit breaker OPEN — skipping non-critical ops for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
      _circuitTripped = true;
    }
  }
}

/**
 * Returns true if the DB circuit breaker is open (pool is unhealthy).
 * Non-critical callers (heartbeats, polling) should skip when true.
 */
export function isCircuitOpen() {
  if (_consecutiveErrors < CIRCUIT_THRESHOLD) return false;
  if (Date.now() > _circuitOpenUntil) {
    // Allow a probe — reset threshold but keep count at threshold-1
    _consecutiveErrors = CIRCUIT_THRESHOLD - 1;
    return false;
  }
  return true;
}

// ============================================================
// Initialization
// ============================================================

async function getPgPool() {
  if (!pool) {
    const { default: pg } = await import('pg');
    const connStr = process.env.DATABASE_URL;
    // Enable SSL for any external Postgres (Supabase, Railway proxy, etc.)
    // Disable only for localhost/Docker connections
    const isLocal = connStr?.includes('localhost') || connStr?.includes('127.0.0.1') || connStr?.includes('.railway.internal');
    // Supabase session pooler has limited slots (~15 for Small compute).
    // Use transaction pooler (port 6543) for higher concurrency, or keep pool small.
    const isSupabase = connStr?.includes('supabase.com');
    // Supabase transaction pooler (PgBouncer) — add pgbouncer=true to disable prepared statements
    const urlObj = new URL(connStr);
    if (isSupabase && !urlObj.searchParams.has('pgbouncer')) {
      urlObj.searchParams.set('pgbouncer', 'true');
    }
    pool = new pg.Pool({
      connectionString: urlObj.toString(),
      max: isSupabase ? 15 : 25,    // Supabase Pro plan; increased from 10 for SSE+agents+chat
      idleTimeoutMillis: 20_000,    // Release idle connections faster (was 30s)
      connectionTimeoutMillis: 10_000, // Fail faster on connection attempts (was 15s)
      keepAlive: true,              // Reuse TCP sockets — prevents EADDRNOTAVAIL
      keepAliveInitialDelayMillis: 10_000,
      // Removed global statement_timeout — was killing legitimate long operations
      // (workspace provisioning, campaign iterations, migration runs).
      // Instead, individual query callers should set timeouts via AbortSignal when needed.
      ...(!isLocal ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    // Surface connection errors early
    pool.on('error', (err) => {
      console.error('[db] Pool error:', err.message);
    });
  }
  return pool;
}

async function getPgLite() {
  if (!pglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

    const DEFAULT_DATA_DIR = join(__dirname, '..', 'data', 'pglite');
    const dataDir = process.env.PGLITE_DATA_DIR || DEFAULT_DATA_DIR;
    mkdirSync(dataDir, { recursive: true });

    pglite = new PGlite(dataDir, {
      extensions: { vector, pg_trgm },
    });
    await pglite.waitReady;

    // PGlite lacks roles that production Postgres has. Pre-create them so
    // migrations with GRANT/CREATE ROLE don't fail. Idempotent — errors
    // are swallowed (role may already exist from a persisted data dir).
    for (const role of ['postgres', 'autobot_agent', 'explorer_ro']) {
      try { await pglite.exec(`CREATE ROLE ${role} SUPERUSER`); } catch { /* exists */ }
    }

    // Auto-close PGlite when the process exits to prevent test hangs.
    // Without this, any test that imports a module touching db.js will
    // hold the process open indefinitely (exit code 100).
    process.on('beforeExit', () => {
      if (pglite) { pglite.close().catch(() => {}); pglite = null; }
    });
  }
  return pglite;
}

/**
 * Initialize the database: run all SQL migrations on first launch.
 * Idempotent — checks for schema existence before running.
 */
export async function initializeDatabase() {
  if (USE_REAL_PG) {
    return initializeRealPg();
  }
  return initializePgLite();
}

async function initializeRealPg() {
  const p = await getPgPool();

  // Ensure migration tracking table exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await p.query(`SELECT filename FROM public._migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  const pending = files.filter(f => !appliedSet.has(f));

  if (pending.length === 0) {
    console.log('[db] Connected to Postgres (all migrations applied)');
    return false;
  }

  console.log(`[db] Running ${pending.length} pending migration(s) (Postgres)...`);

  for (const file of pending) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
    console.log(`[db] Running ${file}...`);
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO public._migrations (filename) VALUES ($1)`, [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.message.includes('already exists')) {
        console.log(`[db]   Skipped (already exists)`);
        await p.query(
          `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
      } else {
        console.error(`[db]   FAILED: ${err.message}`);
      }
    } finally {
      client.release();
    }
  }

  console.log('[db] Database initialized (Postgres)');
  return true;
}

async function initializePgLite() {
  const d = await getPgLite();

  // Ensure migration tracking table exists
  await d.exec(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await d.query(`SELECT filename FROM public._migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  const pending = files.filter(f => !appliedSet.has(f));

  if (pending.length === 0) {
    console.log('[db] PGlite already initialized (all migrations applied)');
    return false;
  }

  console.log(`[db] Running ${pending.length} pending migration(s) (PGlite)...`);

  for (const file of pending) {
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
    console.log(`[db] Running ${file}...`);
    try {
      await d.exec(sql);
      await d.query(`INSERT INTO public._migrations (filename) VALUES ($1)`, [file]);
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log(`[db]   Skipped (already exists)`);
        await d.query(
          `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
      } else {
        console.error(`[db]   FAILED: ${err.message}`);
      }
    }
  }

  console.log('[db] Database initialized (PGlite)');
  return true;
}

// ============================================================
// Query
// ============================================================

/**
 * Execute a parameterized query. No string interpolation ever.
 * P4: boring infrastructure.
 */
export async function query(text, params = []) {
  const start = Date.now();
  let result;

  if (USE_REAL_PG) {
    const p = await getPgPool();
    try {
      result = await p.query(text, params);
      recordDbSuccess();
    } catch (err) {
      recordDbError();
      throw err;
    }
  } else {
    const d = await getPgLite();
    result = await d.query(text, params);
    // pg compat: PGlite uses affectedRows, pg uses rowCount
    if (result.rowCount === undefined) {
      result.rowCount = result.affectedRows ?? 0;
    }
  }

  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`[db] Slow query (${duration}ms):`, text.slice(0, 100));
  }
  return result;
}

// ============================================================
// Transactions
// ============================================================

/**
 * Execute within a transaction. guardCheck + transition_state in same tx.
 */
export async function withTransaction(fn) {
  if (USE_REAL_PG) {
    return withTransactionPg(fn);
  }
  return withTransactionPgLite(fn);
}

async function withTransactionPg(fn) {
  const p = await getPgPool();
  const client = await p.connect();
  // Pool removes its error handler on checkout — add one to prevent unhandled crash
  const onError = (err) => {
    console.error('[db] Checked-out client error (transaction):', err.message);
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release();
  }
}

async function withTransactionPgLite(fn) {
  const d = await getPgLite();
  return d.transaction(async (tx) => {
    // Wrap tx for pg-compatible result shape
    const wrapped = {
      query: async (text, params = []) => {
        const result = await tx.query(text, params);
        if (result.rowCount === undefined) {
          result.rowCount = result.affectedRows ?? 0;
        }
        return result;
      },
    };
    return fn(wrapped);
  });
}

// ============================================================
// Agent context (RLS)
// ============================================================

/**
 * Set agent context for RLS policies.
 * Uses set_config() with parameterized values (not string interpolation).
 */
export async function setAgentContext(client, agentId, role = 'agent') {
  if (!/^[a-z0-9_-]+$/.test(agentId)) throw new Error(`Invalid agent ID: ${agentId}`);
  if (!/^[a-z]+$/.test(role)) throw new Error(`Invalid role: ${role}`);
  await client.query(`SELECT set_config('app.agent_id', $1, true), set_config('app.role', $2, true)`, [agentId, role]);
}

/**
 * Execute a function with a dedicated connection that has RLS agent context set.
 * Guarantees all queries within fn() use the same connection with app.agent_id set.
 *
 * Usage in agent-loop.js:
 *   const scopedQuery = await withAgentScope(agentId);
 *   try { await handler(task, context, { ...agent, query: scopedQuery }); }
 *   finally { scopedQuery.release(); }
 *
 * P2: Infrastructure enforces. The handler cannot accidentally query without RLS context.
 */
export async function withAgentScope(agentId) {
  if (!USE_REAL_PG) {
    // PGlite: single-connection, no pool. RLS context persists.
    const d = await getPgLite();
    await d.query(`SELECT set_config('app.agent_id', $1, true), set_config('app.role', 'agent', true)`, [agentId]);
    const scopedQuery = async (text, params = []) => {
      const result = await d.query(text, params);
      if (result.rowCount === undefined) result.rowCount = result.affectedRows ?? 0;
      return result;
    };
    scopedQuery.release = () => {}; // no-op for PGlite
    scopedQuery.agentId = agentId;
    return scopedQuery;
  }

  const p = await getPgPool();
  const client = await p.connect();
  // Pool removes its error handler on checkout — add one to prevent unhandled crash
  const onError = (err) => {
    console.error(`[db] Checked-out client error (agent: ${agentId}):`, err.message);
  };
  client.on('error', onError);
  await setAgentContext(client, agentId);

  const scopedQuery = async (text, params = []) => {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[db] Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  };
  scopedQuery.release = () => {
    client.removeListener('error', onError);
    client.release();
  };
  scopedQuery.agentId = agentId;
  return scopedQuery;
}

// ============================================================
// Utilities
// ============================================================

/**
 * SHA256 hash for config/prompt verification.
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Get the connection mode for diagnostics.
 */
export function getMode() {
  return USE_REAL_PG ? 'postgres' : 'pglite';
}

/**
 * Return the pg.Pool instance (real Postgres mode only).
 * Returns null when running PGlite or before initialization.
 */
export function getPool() {
  return pool;
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
}

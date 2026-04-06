// Board Postgres connection — raw pg Pool for board API routes.
// Per P4 (boring infrastructure): raw pg + parameterized queries. No ORM.
// Per P1: auth enforced at the API route level, not here.

import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export { pool };

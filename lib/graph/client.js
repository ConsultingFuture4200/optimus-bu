// graph/client.js — Neo4j driver singleton (P4: boring infrastructure)
import neo4j from 'neo4j-driver';

let driver = null;
let available = false;

export async function initGraph() {
  const uri = process.env.NEO4J_URI;
  const password = process.env.NEO4J_PASSWORD;

  if (!uri) {
    console.log('[graph] NEO4J_URI not set — knowledge graph disabled');
    return;
  }

  const user = process.env.NEO4J_USER || 'neo4j';
  if (!password) {
    console.warn('[graph] NEO4J_PASSWORD not set — connecting with empty password (NOT safe for production)');
  }

  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password || ''), {
      maxConnectionPoolSize: 10,
      connectionAcquisitionTimeout: 5000,
    });
    await driver.verifyConnectivity();
    available = true;
    console.log('[graph] Neo4j connected');
  } catch (err) {
    console.warn('[graph] Neo4j unavailable — learning features disabled:', err.message);
    driver = null;
    available = false;
  }
}

export function isGraphAvailable() {
  return available;
}

/**
 * Execute a Cypher query against Neo4j.
 * @param {string} query - Parameterized Cypher query
 * @param {Object} params - Query parameters (never interpolate strings)
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.readOnly] - Use READ session mode (for queries that don't mutate)
 * @returns {Promise<Array|null>} Records or null if unavailable/error
 */
export async function runCypher(query, params = {}, opts = {}) {
  if (!available || !driver) return null;
  const session = driver.session({
    defaultAccessMode: opts.readOnly ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    console.error('[graph] Cypher error:', err.message);
    return null;
  } finally {
    await session.close();
  }
}

export async function closeGraph() {
  if (driver) {
    await driver.close();
    driver = null;
    available = false;
  }
}

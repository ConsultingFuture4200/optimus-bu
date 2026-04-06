// Re-export shim — real implementation in lib/db.js
export {
  initializeDatabase, query, withTransaction, setAgentContext,
  withAgentScope, sha256, getMode, getPool,
  close
} from '../../lib/db.js';

// Re-export shim — real implementation in lib/runtime/agent-replacement.js
export {
  initiateReplacement, recordShadowComparison, checkShadowExitCriteria, advanceTrustLevel,
  checkTrustReset, getReplacementStatus, getActiveReplacements
} from '../../../lib/runtime/agent-replacement.js';

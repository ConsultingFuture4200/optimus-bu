// Re-export shim — real implementation in lib/comms/gateway.js
export {
  submitIntent, processInbound, requestQuorumReview, submitQuorumVote,
  getGatewayStatus
} from '../../../lib/comms/gateway.js';

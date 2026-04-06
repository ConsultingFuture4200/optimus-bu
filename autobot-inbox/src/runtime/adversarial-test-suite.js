// Re-export shim — real implementation in lib/runtime/adversarial-test-suite.js
export {
  runAdversarialTests, getTestReport, getTestCaseCount, getTestCasesByCategory,
  runLocalTests
} from '../../../lib/runtime/adversarial-test-suite.js';

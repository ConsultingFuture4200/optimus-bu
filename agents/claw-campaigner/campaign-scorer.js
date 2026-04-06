/**
 * Campaign Scorer (ADR-021) — Constraint-Based Evaluation
 *
 * Replaced self-assessment (LLM reports own quality) with heuristic constraint checking:
 * 1. Word count in expected range for task type
 * 2. Required structural elements present
 * 3. No prohibited patterns (self-assessment, execution reports)
 * 4. Format compliance (deliverable matches requested format)
 * 5. Output envelope detection
 */

/**
 * Constraint-based quality evaluation.
 * Checks structural quality of output rather than trusting LLM self-scores.
 *
 * @param {string} output - The raw LLM output text
 * @param {Array} successCriteria - Board-defined criteria (used for format expectations)
 * @param {Object} [options] - Additional evaluation options
 * @param {string} [options.expectedFormat] - 'html', 'json', 'sql', 'markdown', 'text'
 * @param {number} [options.minWords] - Minimum word count
 * @param {number} [options.maxWords] - Maximum word count
 * @returns {{score: number, passed: boolean, details: Object}}
 */
export function evaluateSuccessCriteria(output, successCriteria, options = {}) {
  if (!output || typeof output !== 'string') {
    return { score: 0, passed: false, details: { error: 'No output to evaluate' } };
  }

  const checks = {};
  let totalPoints = 0;
  let earnedPoints = 0;

  // --- Check 1: Word count ---
  const words = output.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const minWords = options.minWords || 20;
  const maxWords = options.maxWords || 50000;
  const wordCountOk = wordCount >= minWords && wordCount <= maxWords;
  checks.word_count = { met: wordCountOk, actual: wordCount, min: minWords, max: maxWords };
  totalPoints += 1;
  if (wordCountOk) earnedPoints += 1;

  // --- Check 2: No self-assessment artifacts ---
  const selfAssessmentPatterns = [
    /quality\s*score\s*[:=]\s*\d/i,
    /estimated\s*accuracy\s*[:=]\s*\d/i,
    /confidence\s*[:=]\s*\d/i,
    /self[_-]?assessment/i,
    /execution\s*report/i,
    /task\s*completion\s*summary/i,
    /##?\s*quality\s*(assessment|evaluation|score)/i,
  ];
  const selfAssessmentFound = selfAssessmentPatterns.filter(p => p.test(output));
  checks.no_self_assessment = { met: selfAssessmentFound.length === 0, violations: selfAssessmentFound.map(p => p.source) };
  totalPoints += 2; // weighted higher — this is the core fix
  if (selfAssessmentFound.length === 0) earnedPoints += 2;

  // --- Check 3: Format compliance ---
  const expectedFormat = options.expectedFormat || detectExpectedFormat(successCriteria);
  if (expectedFormat) {
    const formatOk = checkFormatCompliance(output, expectedFormat);
    checks.format_compliance = { met: formatOk, expectedFormat };
    totalPoints += 2;
    if (formatOk) earnedPoints += 2;
  }

  // --- Check 4: No execution report envelope ---
  // If fenced code block exists and surrounding narrative > 2x code length, it's wrapped
  const envelopeCheck = checkOutputEnvelope(output);
  checks.no_envelope = { met: !envelopeCheck.isWrapped, ...envelopeCheck };
  totalPoints += 1;
  if (!envelopeCheck.isWrapped) earnedPoints += 1;

  // --- Check 5: Required sections (from success criteria) ---
  const requiredSections = extractRequiredSections(successCriteria);
  if (requiredSections.length > 0) {
    const found = requiredSections.filter(s => output.toLowerCase().includes(s.toLowerCase()));
    const sectionsPassed = found.length >= requiredSections.length * 0.5; // 50% threshold
    checks.required_sections = { met: sectionsPassed, required: requiredSections, found: found.length, total: requiredSections.length };
    totalPoints += 1;
    if (sectionsPassed) earnedPoints += 1;
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 10000 : 0;
  const passed = score >= 0.7; // 70% threshold for passing

  return { score, passed, details: checks, raw: { quality_score: score } };
}

/**
 * Build-mode scorer: evaluates code blocks extracted from narrative output.
 * Build campaigns produce text-only output (tools disabled), so code is embedded
 * in fenced blocks. This scorer extracts and evaluates the code directly,
 * skipping self-assessment and envelope checks that penalize narrative wrapping.
 *
 * @param {string} output - Raw LLM text output
 * @param {Array} successCriteria - Board-defined criteria
 * @param {Object} [options] - Evaluation options
 * @returns {{score: number, passed: boolean, details: Object}}
 */
export function evaluateBuildOutput(output, successCriteria, options = {}) {
  if (!output || typeof output !== 'string') {
    return { score: 0, passed: false, details: { error: 'No output to evaluate' } };
  }

  const checks = {};
  let totalPoints = 0;
  let earnedPoints = 0;

  // --- Extract all fenced code blocks ---
  const codeBlocks = [];
  for (const match of output.matchAll(/```[\w]*\n([\s\S]*?)```/g)) {
    const block = match[1].trim();
    if (block.length > 10) codeBlocks.push(block); // Skip trivial blocks
  }
  const totalCodeLength = codeBlocks.reduce((sum, b) => sum + b.length, 0);

  // --- Check 1: Has code blocks ---
  const hasCode = codeBlocks.length >= 1;
  checks.has_code_blocks = { met: hasCode, count: codeBlocks.length, totalChars: totalCodeLength };
  totalPoints += 2;
  if (hasCode) earnedPoints += 2;

  // --- Check 2: Code volume (meaningful amount of code) ---
  const minCodeChars = options.minCodeChars || 100;
  const volumeOk = totalCodeLength >= minCodeChars;
  checks.code_volume = { met: volumeOk, actual: totalCodeLength, min: minCodeChars };
  totalPoints += 2;
  if (volumeOk) earnedPoints += 2;

  // --- Check 3: No placeholder stubs ---
  const allCode = codeBlocks.join('\n');
  const stubPatterns = [
    /\/\/\s*TODO/gi,
    /\/\/\s*\.\.\./g,
    /\/\*\s*\.\.\.\s*\*\//g,
    /pass\s*#\s*TODO/gi,
    /raise\s+NotImplementedError/g,
    /placeholder/gi,
  ];
  const stubCount = stubPatterns.reduce((count, p) => count + (allCode.match(p) || []).length, 0);
  const stubRatio = stubCount / Math.max(codeBlocks.length, 1);
  const noStubs = stubRatio < 2; // Allow some TODOs, penalize excessive
  checks.no_placeholder_stubs = { met: noStubs, stubCount, stubRatio: Math.round(stubRatio * 100) / 100 };
  totalPoints += 1;
  if (noStubs) earnedPoints += 1;

  // --- Check 4: Word count (overall output has substance) ---
  const words = output.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const minWords = options.minWords || 50;
  const wordCountOk = wordCount >= minWords;
  checks.word_count = { met: wordCountOk, actual: wordCount, min: minWords };
  totalPoints += 1;
  if (wordCountOk) earnedPoints += 1;

  // --- Check 5: Required sections (from success criteria) ---
  const requiredSections = extractRequiredSections(successCriteria);
  if (requiredSections.length > 0) {
    const found = requiredSections.filter(s => output.toLowerCase().includes(s.toLowerCase()));
    const sectionsPassed = found.length >= requiredSections.length * 0.5;
    checks.required_sections = { met: sectionsPassed, required: requiredSections, found: found.length, total: requiredSections.length };
    totalPoints += 1;
    if (sectionsPassed) earnedPoints += 1;
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 10000 : 0;
  const passed = score >= 0.7;

  return { score, passed, details: checks, raw: { quality_score: score } };
}

/**
 * Evaluate content against campaign content policy.
 *
 * @param {string} content - The produced content/artifact
 * @param {Object} contentPolicy - Board-defined policy
 *   Format: {"no_pii": true, "prohibited_content": [...], "require_review_before_deploy": true}
 * @returns {{compliant: boolean, violations: string[]}}
 */
export function evaluateContentPolicy(content, contentPolicy) {
  if (!contentPolicy || Object.keys(contentPolicy).length === 0) {
    return { compliant: true, violations: [] };
  }

  const violations = [];

  // PII check
  if (contentPolicy.no_pii && content) {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
      /\b\d{16}\b/, // credit card (basic)
      /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
    ];
    for (const pattern of piiPatterns) {
      if (pattern.test(content)) {
        violations.push(`PII detected: matches ${pattern.source}`);
      }
    }
  }

  // Prohibited content
  if (contentPolicy.prohibited_content && content) {
    for (const prohibited of contentPolicy.prohibited_content) {
      if (content.toLowerCase().includes(prohibited.toLowerCase())) {
        violations.push(`Prohibited content: "${prohibited}"`);
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * Detect expected format from success criteria.
 */
function detectExpectedFormat(criteria) {
  if (!criteria || !Array.isArray(criteria)) return null;
  for (const c of criteria) {
    const metric = (c.metric || '').toLowerCase();
    if (metric.includes('html')) return 'html';
    if (metric.includes('json')) return 'json';
    if (metric.includes('sql')) return 'sql';
    if (metric.includes('markdown') || metric.includes('md')) return 'markdown';
  }
  return null;
}

/**
 * Check if output matches expected format.
 */
function checkFormatCompliance(output, format) {
  switch (format) {
    case 'html':
      return /<html[\s>]/i.test(output) || /<body[\s>]/i.test(output) || /<div[\s>]/i.test(output);
    case 'json':
      try { JSON.parse(output.trim()); return true; } catch {
        // Check if there's a JSON block in fenced code
        return /```json[\s\S]*?```/.test(output);
      }
    case 'sql':
      return /\b(SELECT|CREATE|INSERT|ALTER|UPDATE)\b/i.test(output);
    case 'markdown':
      return /^#/m.test(output) || /\*\*/m.test(output);
    default:
      return true;
  }
}

/**
 * Detect if output is wrapped in an execution report envelope.
 */
function checkOutputEnvelope(output) {
  const codeBlocks = [...output.matchAll(/```[\w]*\n([\s\S]*?)```/g)];
  if (codeBlocks.length === 0) return { isWrapped: false };

  const codeLength = codeBlocks.reduce((sum, m) => sum + m[1].length, 0);
  const totalLength = output.length;
  const narrativeLength = totalLength - codeLength;

  // If narrative is > 3x the code, the output is wrapped (relaxed from 2x)
  const isWrapped = narrativeLength > codeLength * 3 && codeLength > 50;
  return { isWrapped, codeLength, narrativeLength, ratio: narrativeLength / Math.max(codeLength, 1) };
}

/**
 * Extract required section names from success criteria.
 */
function extractRequiredSections(criteria) {
  if (!criteria || !Array.isArray(criteria)) return [];
  const sections = [];
  for (const c of criteria) {
    if (c.required_sections) {
      sections.push(...c.required_sections);
    }
  }
  return sections;
}

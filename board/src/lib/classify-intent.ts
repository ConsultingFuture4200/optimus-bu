/**
 * Two-layer intent classifier for Board Workstation CommandBar.
 *
 * Layer 1: Deterministic heuristics (instant, zero-cost).
 * Layer 2: DeepSeek v3 via OpenRouter (fallback for ambiguous input).
 */

export type IntentType = "change" | "ask" | "research" | "intake" | "build";

interface ClassifyResult {
  intent: IntentType;
  confidence: "high" | "medium" | "low";
  source: "heuristic" | "llm";
}

const URL_ONLY = /^\s*https?:\/\/\S+\s*$/i;
const QUESTION_SHORT = /\?\s*$/;
const CHANGE_KEYWORDS = /\b(update|add|fix|change|modify|remove|refactor|implement|create|delete|rename|move|replace|rewrite)\b/i;
const BUILD_KEYWORDS = /\b(build|generate|make|design|scaffold|create|deploy|write)\b.*\b(app|site|page|api|service|landing|dashboard|tool|system|project|component)\b/i;
const INTAKE_KEYWORDS = /\b(submit|propose|spec amendment|governance|intake)\b/i;

/**
 * Layer 1: Fast heuristic classification.
 * Returns null when confidence is too low to route without LLM.
 */
function classifyHeuristic(
  input: string,
  opts: { hasContextFiles: boolean },
): ClassifyResult | null {
  const trimmed = input.trim();

  // Bare URL with no surrounding text → research
  if (URL_ONLY.test(trimmed)) {
    return { intent: "research", confidence: "high", source: "heuristic" };
  }

  // Short question (ends with ?, under 50 words) → ask
  const wordCount = trimmed.split(/\s+/).length;
  if (QUESTION_SHORT.test(trimmed) && wordCount < 50) {
    return { intent: "ask", confidence: "high", source: "heuristic" };
  }

  // Build keywords (e.g. "build a landing page", "create an API") → build pipeline
  if (BUILD_KEYWORDS.test(trimmed)) {
    return { intent: "build", confidence: "high", source: "heuristic" };
  }

  // Context files attached + change keywords → change
  if (opts.hasContextFiles && CHANGE_KEYWORDS.test(trimmed)) {
    return { intent: "change", confidence: "high", source: "heuristic" };
  }

  // Intake keywords → medium confidence (could still use LLM)
  if (INTAKE_KEYWORDS.test(trimmed)) {
    return { intent: "intake", confidence: "medium", source: "heuristic" };
  }

  // Change keywords without context files → medium confidence
  if (CHANGE_KEYWORDS.test(trimmed)) {
    return { intent: "change", confidence: "medium", source: "heuristic" };
  }

  return null;
}

/**
 * Layer 2: DeepSeek v3 classification via backend proxy.
 */
async function classifyWithLLM(input: string): Promise<ClassifyResult> {
  try {
    const res = await fetch("/api/governance/classify-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const intent = data.intent as IntentType;
    if (["change", "ask", "research", "intake", "build"].includes(intent)) {
      return { intent, confidence: "high", source: "llm" };
    }
  } catch (err) {
    console.warn("[classify-intent] LLM fallback failed:", err);
  }

  // Default to "ask" if LLM fails
  return { intent: "ask", confidence: "low", source: "heuristic" };
}

/**
 * Classify user input into a CommandBar intent.
 * Tries heuristics first, falls back to LLM for ambiguous cases.
 */
export async function classifyIntent(
  input: string,
  opts: { hasContextFiles: boolean } = { hasContextFiles: false },
): Promise<ClassifyResult> {
  const heuristic = classifyHeuristic(input, opts);

  // High confidence heuristic → route immediately
  if (heuristic?.confidence === "high") {
    return heuristic;
  }

  // Medium confidence → use heuristic result (skip LLM cost)
  if (heuristic?.confidence === "medium") {
    return heuristic;
  }

  // No heuristic match → call LLM
  return classifyWithLLM(input);
}

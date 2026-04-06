/**
 * LLM Provider Abstraction (ADR-020)
 *
 * Thin factory + response normalizer for multi-provider LLM support.
 * Two paths:
 *   - "anthropic" (default): Anthropic SDK directly (zero proxy overhead)
 *   - "openrouter": OpenAI SDK with OpenRouter base URL
 *
 * No over-engineering. Factory + normalizer, not a framework.
 */

import Anthropic from '@anthropic-ai/sdk';

let _OpenAI = null;

/**
 * Lazily load the OpenAI SDK (only when an OpenRouter model is used).
 */
async function getOpenAI() {
  if (!_OpenAI) {
    const mod = await import('openai');
    _OpenAI = mod.default || mod.OpenAI;
  }
  return _OpenAI;
}

// stopReason normalization (Linus blocker #2)
const ANTHROPIC_STOP_MAP = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'end_turn',
};

const OPENAI_STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

/**
 * Create an LLM client for the given model.
 * Fail-fast: throws at construction time if the required API key is missing.
 *
 * @param {string} modelKey - Key in models config (also the model ID sent to API)
 * @param {object} modelsConfig - The `models` object from agents.json
 * @returns {{ client: object, provider: string, modelId: string, modelConfig: object }}
 */
export function createLLMClient(modelKey, modelsConfig) {
  const modelConfig = modelsConfig[modelKey];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelKey}. Add it to agents.json models config.`);
  }

  const provider = modelConfig.provider || 'anthropic';

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(`ANTHROPIC_API_KEY required for model ${modelKey}`);
    }
    return {
      client: new Anthropic(),
      provider: 'anthropic',
      modelId: modelKey,
      modelConfig,
      // Lazy OpenAI client for openrouter — not needed here
      _openaiClientPromise: null,
    };
  }

  if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(`OPENROUTER_API_KEY required for model ${modelKey}. Set it in .env.`);
    }
    // Return a deferred client — actual SDK loaded lazily on first call
    return {
      client: null, // populated on first callProvider
      provider: 'openrouter',
      modelId: modelKey,
      modelConfig,
      _openaiClientPromise: null,
    };
  }

  throw new Error(`Unknown provider "${provider}" for model ${modelKey}. Supported: anthropic, openrouter.`);
}

/**
 * Ensure the OpenRouter client is initialized (lazy load).
 */
async function ensureOpenRouterClient(llm) {
  if (llm.client) return llm.client;
  const OpenAI = await getOpenAI();
  llm.client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/staqsIO/optimus',
      'X-Title': 'Optimus',
    },
  });
  return llm.client;
}

/**
 * Call the LLM provider and return a normalized response.
 *
 * @param {object} llm - Result from createLLMClient()
 * @param {object} params
 * @param {string} params.system - System prompt
 * @param {Array} params.messages - Messages array
 * @param {number} params.maxTokens
 * @param {number} [params.temperature]
 * @param {Array} [params.tools] - Tool definitions (Anthropic format)
 * @param {AbortSignal} [params.signal] - AbortController signal
 * @returns {Promise<NormalizedResponse>}
 */
export async function callProvider(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  if (llm.provider === 'anthropic') {
    return callAnthropic(llm, { system, messages, maxTokens, temperature, tools, signal });
  }
  if (llm.provider === 'openrouter') {
    return callOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal });
  }
  throw new Error(`Unsupported provider: ${llm.provider}`);
}

/**
 * Anthropic SDK path — existing behavior, zero overhead.
 */
async function callAnthropic(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  const body = {
    model: llm.modelId,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await llm.client.messages.create(body, signal ? { signal } : undefined);

  const text = response.content?.find(b => b.type === 'text')?.text || '';
  const toolCalls = response.content?.filter(b => b.type === 'tool_use') || [];

  return {
    text,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    stopReason: ANTHROPIC_STOP_MAP[response.stop_reason] || response.stop_reason,
    toolCalls,
    raw: response,
  };
}

/**
 * OpenRouter path — OpenAI SDK with base URL override.
 * Converts Anthropic-format tools to OpenAI format, normalizes response back.
 */
async function callOpenRouter(llm, { system, messages, maxTokens, temperature, tools, signal }) {
  const client = await ensureOpenRouterClient(llm);

  // Convert messages: Anthropic uses {system, messages}, OpenAI uses messages with system role
  const openaiMessages = [];
  if (system) {
    openaiMessages.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    openaiMessages.push({ role: msg.role, content: msg.content });
  }

  const body = {
    model: llm.modelId,
    max_tokens: maxTokens,
    temperature,
    messages: openaiMessages,
  };

  // Convert tool format: Anthropic {name, input_schema} -> OpenAI {type:"function", function:{name, parameters}}
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }));
  }

  const response = await client.chat.completions.create(body, signal ? { signal } : undefined);

  const choice = response.choices?.[0];
  const text = choice?.message?.content || '';

  // Normalize tool calls from OpenAI format back to Anthropic-like shape
  const rawToolCalls = choice?.message?.tool_calls || [];
  const toolCalls = rawToolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id,
    name: tc.function?.name,
    input: safeParseJSON(tc.function?.arguments),
  }));

  const inputTokens = response.usage?.prompt_tokens || 0;
  const outputTokens = response.usage?.completion_tokens || 0;

  // Token sanity check (Liotta): warn if 0 tokens for non-empty response
  if (inputTokens === 0 && (text.length > 0 || toolCalls.length > 0)) {
    const estimated = Math.ceil(text.length / 4);
    console.warn(`[llm/provider] OpenRouter returned 0 input tokens for non-empty response (model: ${llm.modelId}). Estimated ~${estimated} tokens from text length.`);
  }

  return {
    text,
    inputTokens,
    outputTokens,
    stopReason: OPENAI_STOP_MAP[choice?.finish_reason] || choice?.finish_reason || 'end_turn',
    toolCalls,
    raw: response,
  };
}

/**
 * Compute cost in USD from token counts and model config.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {object} modelConfig - Must have inputCostPer1M and outputCostPer1M
 * @returns {number} Cost in USD
 */
export function computeCost(inputTokens, outputTokens, modelConfig) {
  if (!modelConfig) return 0;
  return (inputTokens * modelConfig.inputCostPer1M / 1_000_000) +
         (outputTokens * modelConfig.outputCostPer1M / 1_000_000);
}

function safeParseJSON(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}

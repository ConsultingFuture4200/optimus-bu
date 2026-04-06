import { validateInputAdapter } from './input-adapter.js';

/**
 * Adapter registry: singleton Map from provider string → adapter instance.
 * Registered at startup in index.js. Resolved by context-loader via message.provider.
 */

const adapters = new Map();

/**
 * Register an adapter for a provider.
 * Validates that the adapter implements the InputAdapter interface.
 * @param {string} provider - Provider key ('gmail', 'outlook', 'slack')
 * @param {import('./input-adapter.js').InputAdapter} adapter
 */
export function registerAdapter(provider, adapter) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('provider must be a non-empty string');
  }
  const { valid, errors } = validateInputAdapter(adapter);
  if (!valid) {
    throw new Error(`Invalid adapter for "${provider}": ${errors.join(', ')}`);
  }
  adapters.set(provider, adapter);
}

/**
 * Get a registered adapter by provider key.
 * @param {string} provider
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function getAdapter(provider) {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(`No adapter registered for provider "${provider}"`);
  }
  return adapter;
}

/**
 * Resolve the adapter for a message, using message.provider or defaulting to 'gmail'.
 * @param {Object} message - Message row from inbox.messages
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function getAdapterForMessage(message) {
  const provider = message.provider || 'gmail';
  return getAdapter(provider);
}

/**
 * Clear all registered adapters. For tests only.
 */
export function clearAdapters() {
  adapters.clear();
}

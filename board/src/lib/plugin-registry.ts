import type { OptimusPlugin } from './plugin-types';

const registry = new Map<string, OptimusPlugin>();
const enabledSet = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function registerPlugin(plugin: OptimusPlugin): void {
  if (registry.has(plugin.manifest.id)) {
    console.warn(`[plugin-registry] Duplicate plugin ID: ${plugin.manifest.id}`);
  }
  registry.set(plugin.manifest.id, plugin);
  // New plugins start enabled
  enabledSet.add(plugin.manifest.id);
  notify();
}

export function getPlugin(id: string): OptimusPlugin | undefined {
  return registry.get(id);
}

export function getAllPlugins(): OptimusPlugin[] {
  return Array.from(registry.values());
}

export function getPluginIds(): string[] {
  return Array.from(registry.keys());
}

export function isPluginEnabled(id: string): boolean {
  return enabledSet.has(id);
}

export function enablePlugin(id: string): void {
  if (registry.has(id)) {
    enabledSet.add(id);
    notify();
  }
}

export function disablePlugin(id: string): void {
  enabledSet.delete(id);
  notify();
}

export function getEnabledPluginIds(): string[] {
  return Array.from(enabledSet);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

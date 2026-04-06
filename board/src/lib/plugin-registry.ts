import type { OptimusPlugin } from './plugin-types';

const registry = new Map<string, OptimusPlugin>();

export function registerPlugin(plugin: OptimusPlugin): void {
  if (registry.has(plugin.manifest.id)) {
    console.warn(`[plugin-registry] Duplicate plugin ID: ${plugin.manifest.id}`);
  }
  registry.set(plugin.manifest.id, plugin);
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

'use client';

import { useSyncExternalStore, useCallback } from 'react';
import {
  getAllPlugins,
  getEnabledPluginIds,
  isPluginEnabled,
  enablePlugin,
  disablePlugin,
  subscribe,
} from '@/lib/plugin-registry';
import type { OptimusPlugin } from '@/lib/plugin-types';

function getSnapshot(): string {
  // Serialize to string so useSyncExternalStore detects changes
  return JSON.stringify(getEnabledPluginIds());
}

export function usePluginRegistry() {
  const _snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const plugins = getAllPlugins();
  const enabledIds = getEnabledPluginIds();

  const toggle = useCallback((id: string) => {
    if (isPluginEnabled(id)) {
      disablePlugin(id);
    } else {
      enablePlugin(id);
    }
  }, []);

  return { plugins, enabledIds, isEnabled: isPluginEnabled, toggle, enablePlugin, disablePlugin };
}

export function useEnabledPlugins(): OptimusPlugin[] {
  const _snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getAllPlugins().filter((p) => isPluginEnabled(p.manifest.id));
}

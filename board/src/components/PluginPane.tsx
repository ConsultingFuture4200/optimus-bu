'use client';

import { useEffect, useRef } from 'react';
import { PluginErrorBoundary } from './PluginErrorBoundary';
import type { OptimusPlugin } from '@/lib/plugin-types';

interface PluginPaneProps {
  plugin: OptimusPlugin;
  size: { w: number; h: number };
  config?: Record<string, unknown>;
}

export default function PluginPane({ plugin, size, config = {} }: PluginPaneProps) {
  const activatedRef = useRef(false);

  useEffect(() => {
    if (!activatedRef.current) {
      activatedRef.current = true;
      plugin.onActivate?.(); // SHELL-03: called when pane opens
    }
    return () => {
      plugin.onDeactivate?.(); // SHELL-03: called when pane closes
    };
  }, [plugin]);

  const Component = plugin.component;

  return (
    <PluginErrorBoundary pluginName={plugin.manifest.name}>
      <div className="h-full overflow-hidden rounded-lg border border-white/5 animate-fade-in">
        {/* Drag handle: top 36px acts as drag target (SHELL-01) */}
        <div
          className="plugin-drag-handle h-9 cursor-grab active:cursor-grabbing"
          aria-label={`Drag ${plugin.manifest.name}`}
        />
        <div className="h-[calc(100%-2.25rem)] overflow-hidden">
          <Component config={config} size={size} />
        </div>
      </div>
    </PluginErrorBoundary>
  );
}

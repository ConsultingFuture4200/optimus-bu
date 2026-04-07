'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
// CSS loaded via globals.css (react-grid-layout + react-resizable styles)

// Register stub plugins (side-effect import — triggers registerPlugin calls)
import '@/plugins/stubs';

import { getPlugin } from '@/lib/plugin-registry';
import { useEnabledPlugins } from '@/hooks/usePluginRegistry';
import PluginPane from './PluginPane';

// Daily Ops default layout (D-10): Today Brief + Approval Queue top row, Agent Status full-width bottom
// Layout = readonly LayoutItem[] in react-grid-layout v2
const DAILY_OPS_DEFAULT_LAYOUT: Layout = [
  { i: 'optimus.today-brief',      x: 0, y: 0,  w: 6,  h: 8 },
  { i: 'optimus.approval-queue',   x: 6, y: 0,  w: 6,  h: 8 },
  { i: 'optimus.agent-status',     x: 0, y: 8,  w: 12, h: 6 },
  { i: 'optimus.project-builder',  x: 0, y: 14, w: 12, h: 10 },
] as const;

// Debounce hook — delays value propagation by `delay` ms.
// Used to batch rapid drag/resize events before triggering auto-save (D-14).
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function GridArea() {
  // useContainerWidth provides width measurement and a mounted flag (SHELL-07)
  const { width, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });
  const [layout, setLayout] = useState<Layout>(DAILY_OPS_DEFAULT_LAYOUT);
  const enabledPlugins = useEnabledPlugins();

  // Guard: skip auto-save on first debounce trigger (before saved layout loads)
  const isInitialLoad = useRef(true);

  // Debounced layout for auto-save — 2500ms per D-14 (within 2-3s range)
  const debouncedLayout = useDebounce(layout, 2500);

  // Load saved workspace on mount (SHELL-06 round-trip fidelity)
  // Non-blocking: grid renders with default layout immediately, swaps when fetch resolves
  useEffect(() => {
    fetch('/api/workspaces?name=Daily+Ops')
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (data?.items && Array.isArray(data.items) && data.items.length > 0) {
          setLayout(data.items as Layout);
        }
      })
      .catch(() => {
        // Per UI-SPEC: silent failure — fall back to DAILY_OPS_DEFAULT_LAYOUT already in state
        console.warn('[GridArea] Could not load workspace, using default layout');
      })
      .finally(() => {
        // Mark initial load complete so auto-save can begin watching
        isInitialLoad.current = false;
      });
  }, []);

  // Auto-save on debounced layout change (D-14)
  // Skips the first trigger to avoid saving the default layout before the real one loads
  useEffect(() => {
    if (isInitialLoad.current) return;

    fetch('/api/workspaces', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily Ops',
        layout: {
          schemaVersion: 1,
          items: debouncedLayout,
          pluginConfigs: {},
        },
      }),
    }).catch(() => {
      // Per UI-SPEC: silent failure in Phase 1 — no user-visible error
      console.warn('[GridArea] Auto-save failed');
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedLayout]);

  // Sync layout when plugins are enabled/disabled
  useEffect(() => {
    const enabledIds = new Set(enabledPlugins.map((p) => p.manifest.id));
    setLayout((prev) => {
      // Remove panes for disabled plugins
      const kept = prev.filter((item) => enabledIds.has(item.i));
      // Add panes for newly enabled plugins not yet in layout
      const existingIds = new Set(kept.map((item) => item.i));
      const bottomY = kept.reduce((max, item) => Math.max(max, item.y + item.h), 0);
      let nextX = 0;
      const added: LayoutItem[] = [];
      for (const plugin of enabledPlugins) {
        if (!existingIds.has(plugin.manifest.id)) {
          const { w, h } = plugin.manifest.defaultSize;
          added.push({ i: plugin.manifest.id, x: nextX, y: bottomY, w, h });
          nextX += w;
          if (nextX >= 12) nextX = 0;
        }
      }
      if (added.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...added];
    });
  }, [enabledPlugins]);

  const onLayoutChange = useCallback((newLayout: Layout) => {
    setLayout(newLayout);
    // Layout serializes to JSON for round-trip fidelity (SHELL-06)
  }, []);

  // Don't render the grid until client-side width is measured (SHELL-07 mounted guard)
  if (!mounted) {
    return (
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-2 bg-surface"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-2 bg-surface"
    >
      <GridLayout
        width={width}
        layout={layout}
        gridConfig={{
          cols: 12,
          rowHeight: 30,
          margin: [8, 8] as readonly [number, number],
          containerPadding: [8, 8] as readonly [number, number],
          maxRows: Infinity,
        }}
        dragConfig={{
          enabled: true,
          bounded: false,
          handle: '.plugin-drag-handle',
          threshold: 3,
        }}
        onLayoutChange={onLayoutChange}
        className="relative"
      >
        {layout.map((item: LayoutItem) => {
          const plugin = getPlugin(item.i);
          if (!plugin) return null;
          return (
            <div key={item.i}>
              <PluginPane
                plugin={plugin}
                size={{ w: item.w, h: item.h }}
              />
            </div>
          );
        })}
      </GridLayout>
    </div>
  );
}

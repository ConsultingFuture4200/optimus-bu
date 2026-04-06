'use client';

import { useState, useCallback } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// Register stub plugins (side-effect import — triggers registerPlugin calls)
import '@/plugins/stubs';

import { getPlugin } from '@/lib/plugin-registry';
import PluginPane from './PluginPane';

// Daily Ops default layout (D-10): Today Brief + Approval Queue top row, Agent Status full-width bottom
// Layout = readonly LayoutItem[] in react-grid-layout v2
const DAILY_OPS_DEFAULT_LAYOUT: Layout = [
  { i: 'optimus.today-brief',    x: 0, y: 0, w: 6,  h: 8 },
  { i: 'optimus.approval-queue', x: 6, y: 0, w: 6,  h: 8 },
  { i: 'optimus.agent-status',   x: 0, y: 8, w: 12, h: 6 },
] as const;

export default function GridArea() {
  // useContainerWidth provides width measurement and a mounted flag (SHELL-07)
  const { width, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });
  const [layout, setLayout] = useState<Layout>(DAILY_OPS_DEFAULT_LAYOUT);

  const onLayoutChange = useCallback((newLayout: Layout) => {
    setLayout(newLayout);
    // Layout serializes to JSON for round-trip fidelity (SHELL-06)
    // Auto-save will be wired in Plan 03 — for now, layout is held in-memory
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

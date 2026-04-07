'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import SideNav from '@/components/SideNav';
import PluginManager from '@/components/PluginManager';

const GridArea = dynamic(() => import('./GridArea'), {
  ssr: false,
  loading: () => (
    <div
      className="flex-1 bg-neutral-900 animate-pulse"
      aria-label="Loading workspace"
      aria-live="polite"
    />
  ),
});

export default function PluginShell() {
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <SideNav onOpenPluginManager={() => setPluginManagerOpen(true)} />
      <GridArea />
      <PluginManager open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />
    </div>
  );
}

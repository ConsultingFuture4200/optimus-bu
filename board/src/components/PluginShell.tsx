'use client';

import dynamic from 'next/dynamic';
import SideNav from '@/components/SideNav';

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
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <SideNav />
      <GridArea />
    </div>
  );
}

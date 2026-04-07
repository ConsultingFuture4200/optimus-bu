'use client';

import type { OptimusPlugin, PluginProps } from '@/lib/plugin-types';

function TodayBriefStubComponent({ config: _config, size: _size }: PluginProps) {
  return (
    <div className="h-full flex flex-col bg-surface-raised border border-dashed border-white/10 rounded-lg p-4">
      <div className="text-sm font-semibold text-zinc-400">Today Brief</div>
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-zinc-600">Coming in Phase 3</span>
      </div>
    </div>
  );
}

export const todayBriefPlugin: OptimusPlugin = {
  manifest: {
    id: 'optimus.today-brief',
    name: 'Today Brief',
    description: 'Daily summary of pending approvals, agent activity, and key signals.',
    author: 'Optimus Core',
    version: '0.1.0',
    category: 'ops',
    dataDependencies: ['useTodayBrief', 'useDrafts', 'useSignals'],
    defaultSize: { w: 6, h: 8 },
    minSize: { w: 3, h: 4 },
    mobileSupported: true,
  },
  component: TodayBriefStubComponent,
  onActivate: () => { console.log('[plugin] Today Brief activated'); },
  onDeactivate: () => { console.log('[plugin] Today Brief deactivated'); },
};

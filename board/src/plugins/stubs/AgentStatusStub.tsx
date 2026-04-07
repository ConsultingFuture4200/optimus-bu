'use client';

import type { OptimusPlugin, PluginProps } from '@/lib/plugin-types';

function AgentStatusStubComponent({ config: _config, size: _size }: PluginProps) {
  return (
    <div className="h-full flex flex-col bg-surface-raised border border-dashed border-white/10 rounded-lg p-4">
      <div className="text-sm font-semibold text-zinc-400">Agent Status</div>
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-zinc-600">Coming in Phase 3</span>
      </div>
    </div>
  );
}

export const agentStatusPlugin: OptimusPlugin = {
  manifest: {
    id: 'optimus.agent-status',
    name: 'Agent Status',
    description: 'Live status of all agents — tiers, activity, errors, and throughput.',
    author: 'Optimus Core',
    version: '0.1.0',
    category: 'system',
    dataDependencies: ['useAgents'],
    defaultSize: { w: 12, h: 6 },
    minSize: { w: 6, h: 4 },
    mobileSupported: true,
  },
  component: AgentStatusStubComponent,
  onActivate: () => { console.log('[plugin] Agent Status activated'); },
  onDeactivate: () => { console.log('[plugin] Agent Status deactivated'); },
};

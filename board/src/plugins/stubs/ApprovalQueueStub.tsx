'use client';

import type { OptimusPlugin, PluginProps } from '@/lib/plugin-types';

function ApprovalQueueStubComponent({ config: _config, size: _size }: PluginProps) {
  return (
    <div className="h-full flex flex-col bg-surface-raised border border-dashed border-white/10 rounded-lg p-4">
      <div className="text-sm font-semibold text-zinc-400">Approval Queue</div>
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-zinc-600">Coming in Phase 3</span>
      </div>
    </div>
  );
}

export const approvalQueuePlugin: OptimusPlugin = {
  manifest: {
    id: 'optimus.approval-queue',
    name: 'Approval Queue',
    description: 'Review, approve, edit, or reject agent-drafted messages before they send.',
    author: 'Optimus Core',
    version: '0.1.0',
    category: 'workflow',
    dataDependencies: ['useDrafts'],
    writeCapabilities: ['approveDraft', 'rejectDraft', 'editDraft'],
    defaultSize: { w: 6, h: 8 },
    minSize: { w: 4, h: 6 },
    mobileSupported: true,
  },
  component: ApprovalQueueStubComponent,
  onActivate: () => { console.log('[plugin] Approval Queue activated'); },
  onDeactivate: () => { console.log('[plugin] Approval Queue deactivated'); },
};

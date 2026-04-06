import type { ComponentType } from 'react';

export interface PluginManifest {
  id: string;                  // e.g., 'optimus.approval-queue'
  name: string;                // e.g., 'Approval Queue'
  version: string;             // semver
  category: 'workflow' | 'analytics' | 'system' | 'governance' | 'ops';
  dataDependencies: string[];  // hook names this plugin requires (e.g., ['useDrafts'])
  writeCapabilities?: string[];// mutation names (e.g., ['approveDraft', 'rejectDraft'])
  defaultSize: { w: number; h: number };  // 12-col grid units
  minSize?: { w: number; h: number };
  mobileSupported: boolean;
}

export interface PluginProps {
  config: Record<string, unknown>;
  size: { w: number; h: number };   // current pane dimensions in grid units
}

export interface OptimusPlugin {
  manifest: PluginManifest;
  component: ComponentType<PluginProps>;
  onActivate?: () => void | Promise<void>;   // SHELL-03: called when pane opens
  onDeactivate?: () => void;                 // SHELL-03: called when pane closes
}

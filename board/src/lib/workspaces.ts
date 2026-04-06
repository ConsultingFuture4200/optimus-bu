// Workspace persistence library — CRUD for board.workspaces table.
// Per P4 (boring infrastructure): raw pg + parameterized queries. No ORM.
// Per P1: auth enforced at the API route level, not here.

import { query } from './db';
import type { Layout } from 'react-grid-layout';

export interface WorkspaceLayout {
  schemaVersion: number;
  items: Layout;
  pluginConfigs: Record<string, Record<string, unknown>>;
}

// D-10: Daily Ops preset — default first-visit layout
// Today Brief + Approval Queue top row, Agent Status full-width bottom
export const DAILY_OPS_PRESET: WorkspaceLayout = {
  schemaVersion: 1,
  items: [
    { i: 'optimus.today-brief',    x: 0, y: 0, w: 6, h: 8 },
    { i: 'optimus.approval-queue', x: 6, y: 0, w: 6, h: 8 },
    { i: 'optimus.agent-status',   x: 0, y: 8, w: 12, h: 6 },
  ],
  pluginConfigs: {},
};

// D-15: Migration function — runs before any layout is used (on every load).
// Phase 1: v1 is baseline. Future phases add migration steps here.
export function migrateWorkspace(raw: unknown): WorkspaceLayout {
  const data = raw as Partial<WorkspaceLayout>;
  const _version = data?.schemaVersion ?? 0;

  // Future migrations go here:
  // if (_version < 2) { /* migrate v1 -> v2 */ }

  return {
    schemaVersion: 1,
    items: Array.isArray(data?.items) ? (data.items as Layout) : DAILY_OPS_PRESET.items,
    pluginConfigs:
      data?.pluginConfigs && typeof data.pluginConfigs === 'object'
        ? data.pluginConfigs
        : {},
  };
}

// Get workspace for a member. Falls back to Daily Ops preset if no row exists.
// Per P1: memberId must come from the session — caller is responsible.
export async function getWorkspace(
  memberId: string,
  name: string = 'Daily Ops'
): Promise<WorkspaceLayout> {
  const result = await query(
    'SELECT layout, schema_version FROM board.workspaces WHERE member_id = $1 AND name = $2',
    [memberId, name]
  );

  if (result.rows.length === 0) {
    return DAILY_OPS_PRESET;
  }

  const row = result.rows[0];
  return migrateWorkspace(row.layout);
}

// Save workspace layout (upsert). Per D-14: called by debounced auto-save in GridArea.
// Per P1: memberId must come from the session — caller is responsible.
export async function saveWorkspace(
  memberId: string,
  name: string,
  layout: WorkspaceLayout
): Promise<void> {
  await query(
    `INSERT INTO board.workspaces (member_id, name, layout, schema_version, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (member_id, name)
     DO UPDATE SET layout = $3, schema_version = $4, updated_at = now()`,
    [memberId, name, JSON.stringify(layout), layout.schemaVersion]
  );
}

-- Board schema: workspace persistence
-- Runs against existing Supabase Postgres instance
-- Separate from autobot-inbox/sql/ — board owns its schema
-- Per CLAUDE.md: member_id is TEXT (GitHub username from NextAuth),
--   NOT a foreign key to agent_graph tables (no cross-schema foreign keys).

CREATE SCHEMA IF NOT EXISTS board;

CREATE TABLE IF NOT EXISTS board.workspaces (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  layout         JSONB       NOT NULL,
  schema_version INT         NOT NULL DEFAULT 1,
  is_preset      BOOL        NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, name)
);

-- Index for fast workspace lookup by member
CREATE INDEX IF NOT EXISTS idx_workspaces_member_id ON board.workspaces (member_id);

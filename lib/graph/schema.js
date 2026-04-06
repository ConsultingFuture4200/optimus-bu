// graph/schema.js — Initial graph constraints and indexes
import { runCypher, isGraphAvailable } from './client.js';

export async function ensureSchema() {
  if (!isGraphAvailable()) return;

  const constraints = [
    'CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
    'CREATE CONSTRAINT capability_name IF NOT EXISTS FOR (c:Capability) REQUIRE c.name IS UNIQUE',
    'CREATE CONSTRAINT task_outcome_id IF NOT EXISTS FOR (t:TaskOutcome) REQUIRE t.id IS UNIQUE',
    'CREATE CONSTRAINT pattern_id IF NOT EXISTS FOR (p:Pattern) REQUIRE p.id IS UNIQUE',
    'CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (d:Decision) REQUIRE d.id IS UNIQUE',
    // Spec graph constraints
    'CREATE CONSTRAINT spec_section_id IF NOT EXISTS FOR (s:SpecSection) REQUIRE s.id IS UNIQUE',
    'CREATE CONSTRAINT design_principle_id IF NOT EXISTS FOR (p:DesignPrinciple) REQUIRE p.id IS UNIQUE',
    'CREATE CONSTRAINT constitutional_gate_id IF NOT EXISTS FOR (g:ConstitutionalGate) REQUIRE g.id IS UNIQUE',
    'CREATE CONSTRAINT db_table_name IF NOT EXISTS FOR (t:DbTable) REQUIRE t.name IS UNIQUE',
  ];

  const indexes = [
    'CREATE INDEX task_outcome_created IF NOT EXISTS FOR (t:TaskOutcome) ON (t.created_at)',
    'CREATE INDEX pattern_domain IF NOT EXISTS FOR (p:Pattern) ON (p.domain)',
    'CREATE INDEX decision_type IF NOT EXISTS FOR (d:Decision) ON (d.type)',
    // Spec graph indexes
    'CREATE INDEX spec_section_domain IF NOT EXISTS FOR (s:SpecSection) ON (s.domain)',
    'CREATE INDEX spec_section_phase IF NOT EXISTS FOR (s:SpecSection) ON (s.phase)',
  ];

  for (const stmt of [...constraints, ...indexes]) {
    await runCypher(stmt);
  }

  console.log('[graph] Schema constraints and indexes ensured');
}

// Board Directive endpoint — receives commands from the board during a build.
// Per P1 (deny by default): session check before any action.
//
// Integration path (Phase 2+):
//   POST directive → create DIRECTIVE work_item in task graph →
//   orchestrator reads it next loop → adjusts GSD execution accordingly.
//
// Current: stub that acknowledges the directive.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { directive } = await req.json();

  if (!directive || typeof directive !== 'string') {
    return NextResponse.json({ error: 'Missing directive' }, { status: 400 });
  }

  // TODO (Phase 2): Insert DIRECTIVE work_item into agent_graph
  // await db.query(
  //   `INSERT INTO agent_graph.work_items (type, payload, created_by)
  //    VALUES ('DIRECTIVE', $1, $2)`,
  //   [JSON.stringify({ directive, source: 'project-builder' }), session.user.name]
  // );

  console.log(`[project-builder] Board directive from ${session.user.name}: ${directive}`);

  return NextResponse.json({ ok: true, directive });
}

// Workspace API route — GET (load) and PUT (save) with auth guard.
// Per P1 (deny by default): session check returns 401 before any DB access.
// Per P2 (infrastructure enforces): auth is in the API route, not in the client.
// member_id is always session.user.name — never trust client-supplied member_id.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getWorkspace, saveWorkspace, migrateWorkspace } from '@/lib/workspaces';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const name = req.nextUrl.searchParams.get('name') ?? 'Daily Ops';
  const workspace = await getWorkspace(session.user.name, name);
  return NextResponse.json(workspace);
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  // migrateWorkspace() runs on every save — ensures forward compatibility (D-15)
  const layout = migrateWorkspace(body.layout);
  const name = (body.name as string) ?? 'Daily Ops';

  await saveWorkspace(session.user.name, name, layout);
  return NextResponse.json({ ok: true });
}

// Project Build SSE endpoint — streams agent activity back to the Project Builder plugin.
// Per P1 (deny by default): session check before any action.
// Per P3 (transparency by structure): every agent action is logged through the SSE stream.
//
// Integration path (Phase 2+):
//   1. POST project brief → Optimus task graph (agent_graph.work_items)
//   2. Orchestrator agent picks up → runs GSD workflow (new-project → roadmap → plan → execute)
//   3. Agent state_transitions → pg_notify → Redis pub/sub → this SSE handler
//
// Current: stub implementation that simulates the GSD workflow phases.

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.name) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const name = req.nextUrl.searchParams.get('name') ?? 'untitled';
  const directory = req.nextUrl.searchParams.get('directory') ?? '/projects/untitled';
  const brief = req.nextUrl.searchParams.get('brief') ?? '';

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      // --- Stub: Simulate GSD workflow phases ---
      // Replace with real task graph integration in Phase 2+.
      // The real flow: create work_item → orchestrator assigns to agents →
      // listen on pg_notify/Redis for state_transitions → relay as SSE events.

      const phases = [
        { delay: 800, event: 'gsd', data: { phase: '/new-project', message: `Initializing project "${name}" at ${directory}` } },
        { delay: 1200, event: 'agent', data: { agent: 'Strategist', phase: 'research', message: `Analyzing project brief: "${brief.slice(0, 80)}${brief.length > 80 ? '...' : ''}"` } },
        { delay: 1500, event: 'agent', data: { agent: 'Architect', phase: 'research', message: 'Researching domain ecosystem and technology landscape' } },
        { delay: 2000, event: 'gsd', data: { phase: '/new-project', message: 'Research complete — synthesizing findings' } },
        { delay: 1000, event: 'agent', data: { agent: 'Architect', phase: 'roadmap', message: 'Creating project roadmap with phase breakdown' } },
        { delay: 1800, event: 'gsd', data: { phase: '/new-project', message: 'PROJECT.md created — roadmap ready for board review' } },
        { delay: 1200, event: 'status', data: { status: 'paused', message: 'Awaiting board approval on roadmap before execution' } },
        { delay: 2000, event: 'agent', data: { agent: 'Orchestrator', phase: 'plan-phase', message: 'Planning Phase 1 implementation' } },
        { delay: 1500, event: 'agent', data: { agent: 'Executor', phase: 'execute', message: 'Scaffolding project structure' } },
        { delay: 1200, event: 'agent', data: { agent: 'Executor', phase: 'execute', message: 'Installing dependencies' } },
        { delay: 1000, event: 'agent', data: { agent: 'Reviewer', phase: 'verify', message: 'Verifying Phase 1 deliverables' } },
        { delay: 800, event: 'gsd', data: { phase: '/verify-work', message: 'Phase 1 verification passed' } },
        { delay: 500, event: 'complete', data: { message: `Project "${name}" scaffolded at ${directory}` } },
      ];

      try {
        send('status', { status: 'running', message: `Build started for "${name}"` });

        for (const phase of phases) {
          await new Promise((resolve) => setTimeout(resolve, phase.delay));
          send(phase.event, phase.data);
        }
      } catch {
        send('error', { message: 'Build stream interrupted' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Railway nginx passthrough
    },
  });
}

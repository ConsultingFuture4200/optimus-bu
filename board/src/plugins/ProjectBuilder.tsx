'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { OptimusPlugin, PluginProps } from '@/lib/plugin-types';

// --- Types ---

interface LogEntry {
  id: string;
  timestamp: string;
  agent?: string;
  phase?: string;
  level: 'info' | 'agent' | 'gsd' | 'error' | 'board';
  message: string;
}

type BuildStatus = 'idle' | 'configuring' | 'running' | 'paused' | 'completed' | 'failed';

// --- Helpers ---

function logId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const AGENT_COLORS: Record<string, string> = {
  orchestrator: 'text-indigo-400',
  architect: 'text-cyan-400',
  executor: 'text-amber-400',
  reviewer: 'text-emerald-400',
  strategist: 'text-purple-400',
  gsd: 'text-blue-400',
  board: 'text-rose-400',
};

function agentColor(agent?: string): string {
  if (!agent) return 'text-zinc-400';
  const key = Object.keys(AGENT_COLORS).find((k) => agent.toLowerCase().includes(k));
  return key ? AGENT_COLORS[key] : 'text-zinc-400';
}

const LEVEL_PREFIX: Record<LogEntry['level'], string> = {
  info: '\u2022',
  agent: '\u25B6',
  gsd: '\u2699',
  error: '\u2718',
  board: '\u2691',
};

// --- Sub-components ---

function ProjectForm({ onSubmit, disabled }: { onSubmit: (cfg: { name: string; directory: string; brief: string }) => void; disabled: boolean }) {
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [brief, setBrief] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !brief.trim()) return;
    onSubmit({ name: name.trim(), directory: directory.trim() || `/projects/${name.trim().toLowerCase().replace(/\s+/g, '-')}`, brief: brief.trim() });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-3">
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Project Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-saas-app"
            disabled={disabled}
            className="w-full bg-white/[0.04] border border-white/10 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 disabled:opacity-40"
          />
        </div>
        <div className="flex-1">
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Directory</label>
          <input
            type="text"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/projects/my-saas-app"
            disabled={disabled}
            className="w-full bg-white/[0.04] border border-white/10 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 disabled:opacity-40"
          />
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Project Brief</label>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Describe what you want Optimus to build..."
          rows={3}
          disabled={disabled}
          className="w-full bg-white/[0.04] border border-white/10 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 disabled:opacity-40 resize-none"
        />
      </div>
      <button
        type="submit"
        disabled={disabled || !name.trim() || !brief.trim()}
        className="self-end px-4 py-1.5 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        Build Project
      </button>
    </form>
  );
}

function LogPanel({ logs, logEndRef }: { logs: LogEntry[]; logEndRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-relaxed bg-black/30 border-y border-white/5">
      {logs.length === 0 ? (
        <div className="h-full flex items-center justify-center text-zinc-600 text-xs">
          Waiting for build to start...
        </div>
      ) : (
        <div className="p-2 space-y-0.5">
          {logs.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span className="text-zinc-600 shrink-0 select-none">{entry.timestamp}</span>
              <span className="shrink-0 w-3 text-center select-none">{LEVEL_PREFIX[entry.level]}</span>
              {entry.agent && (
                <span className={`shrink-0 ${agentColor(entry.agent)}`}>[{entry.agent}]</span>
              )}
              {entry.phase && (
                <span className="shrink-0 text-zinc-500">{entry.phase}</span>
              )}
              <span className={entry.level === 'error' ? 'text-red-400' : 'text-zinc-300'}>{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

function DirectiveInput({ onSend, disabled, status }: { onSend: (cmd: string) => void; disabled: boolean; status: BuildStatus }) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput('');
  };

  const statusLabel: Record<BuildStatus, { text: string; color: string }> = {
    idle: { text: 'IDLE', color: 'text-zinc-600' },
    configuring: { text: 'CONFIGURING', color: 'text-yellow-500' },
    running: { text: 'RUNNING', color: 'text-emerald-400' },
    paused: { text: 'PAUSED', color: 'text-amber-400' },
    completed: { text: 'COMPLETED', color: 'text-indigo-400' },
    failed: { text: 'FAILED', color: 'text-red-400' },
  };

  const { text, color } = statusLabel[status];

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 p-2 border-t border-white/5">
      <span className={`text-[10px] font-mono uppercase tracking-wider ${color} shrink-0`}>{text}</span>
      <span className="text-zinc-600 text-xs shrink-0">$</span>
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={status === 'running' ? 'Send directive to board...' : 'Start a build first'}
        disabled={disabled}
        className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none disabled:opacity-30 font-mono"
      />
      <button
        type="submit"
        disabled={disabled || !input.trim()}
        className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 disabled:opacity-20 transition-colors"
      >
        Send
      </button>
    </form>
  );
}

// --- Main Plugin Component ---

function ProjectBuilderComponent({ config: _config, size: _size }: PluginProps) {
  const [status, setStatus] = useState<BuildStatus>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogs((prev) => [...prev, { ...entry, id: logId(), timestamp: timestamp() }]);
  }, []);

  const handleStartBuild = useCallback((cfg: { name: string; directory: string; brief: string }) => {
    setStatus('running');
    setLogs([]);

    addLog({ level: 'info', message: `Initializing project: ${cfg.name}` });
    addLog({ level: 'info', message: `Target directory: ${cfg.directory}` });
    addLog({ level: 'gsd', agent: 'GSD', phase: '/new-project', message: 'Submitting project brief to Optimus task graph...' });

    // Connect to SSE endpoint for build progress
    const params = new URLSearchParams({
      name: cfg.name,
      directory: cfg.directory,
      brief: cfg.brief,
    });

    const es = new EventSource(`/api/projects/build?${params}`);
    eventSourceRef.current = es;

    es.addEventListener('agent', (e) => {
      const data = JSON.parse(e.data);
      addLog({ level: 'agent', agent: data.agent, phase: data.phase, message: data.message });
    });

    es.addEventListener('gsd', (e) => {
      const data = JSON.parse(e.data);
      addLog({ level: 'gsd', agent: 'GSD', phase: data.phase, message: data.message });
    });

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      setStatus(data.status);
      addLog({ level: 'info', message: data.message });
    });

    es.addEventListener('error', (e) => {
      // SSE error events may not have data (connection lost)
      if (e instanceof MessageEvent && e.data) {
        const data = JSON.parse(e.data);
        addLog({ level: 'error', message: data.message });
      }
      setStatus('failed');
      es.close();
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      addLog({ level: 'info', message: data.message });
      setStatus('completed');
      es.close();
    });

    es.onerror = () => {
      // Connection-level error — SSE dropped
      if (status === 'running') {
        addLog({ level: 'error', message: 'Connection to build stream lost' });
        setStatus('failed');
      }
      es.close();
    };
  }, [addLog, status]);

  const handleDirective = useCallback((cmd: string) => {
    addLog({ level: 'board', agent: 'Board', message: cmd });

    // Send directive to API
    fetch('/api/projects/build/directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directive: cmd }),
    }).catch(() => {
      addLog({ level: 'error', message: 'Failed to send directive' });
    });
  }, [addLog]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  return (
    <div className="h-full flex flex-col bg-[#0c0c14]">
      {/* Project config form — collapsible once build starts */}
      {(status === 'idle' || status === 'completed' || status === 'failed') && (
        <ProjectForm onSubmit={handleStartBuild} disabled={false} />
      )}

      {/* Running header when form is hidden */}
      {(status === 'running' || status === 'paused') && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
          <span className="text-xs text-zinc-400">Build in progress</span>
          <button
            onClick={() => {
              eventSourceRef.current?.close();
              setStatus('idle');
              addLog({ level: 'info', message: 'Build cancelled by board' });
            }}
            className="text-[10px] uppercase tracking-wider text-red-500/70 hover:text-red-400 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Streaming log panel */}
      <LogPanel logs={logs} logEndRef={logEndRef} />

      {/* Board directive input */}
      <DirectiveInput
        onSend={handleDirective}
        disabled={status !== 'running' && status !== 'paused'}
        status={status}
      />
    </div>
  );
}

// --- Plugin Export ---

export const projectBuilderPlugin: OptimusPlugin = {
  manifest: {
    id: 'optimus.project-builder',
    name: 'Project Builder',
    description: 'Launch new projects via Optimus agents orchestrated through GSD workflow.',
    author: 'Optimus Core',
    version: '0.1.0',
    category: 'ops',
    dataDependencies: [],
    writeCapabilities: ['createProject', 'sendDirective'],
    defaultSize: { w: 12, h: 10 },
    minSize: { w: 6, h: 8 },
    mobileSupported: false,
  },
  component: ProjectBuilderComponent,
  onActivate: () => { console.log('[plugin] Project Builder activated'); },
  onDeactivate: () => { console.log('[plugin] Project Builder deactivated'); },
};

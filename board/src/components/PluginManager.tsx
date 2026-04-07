'use client';

import { useState, useMemo } from 'react';
import { usePluginRegistry } from '@/hooks/usePluginRegistry';
import type { OptimusPlugin, PluginManifest } from '@/lib/plugin-types';

const CATEGORY_LABELS: Record<PluginManifest['category'], string> = {
  ops: 'Operations',
  workflow: 'Workflow',
  analytics: 'Analytics',
  system: 'System',
  governance: 'Governance',
};

const CATEGORY_ICONS: Record<PluginManifest['category'], string> = {
  ops: '⊙',
  workflow: '↻',
  analytics: '◈',
  system: '⚙',
  governance: '⛊',
};

interface PluginManagerProps {
  open: boolean;
  onClose: () => void;
}

export default function PluginManager({ open, onClose }: PluginManagerProps) {
  const { plugins, isEnabled, toggle } = usePluginRegistry();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = plugins;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.manifest.name.toLowerCase().includes(q) ||
          p.manifest.description?.toLowerCase().includes(q) ||
          p.manifest.id.toLowerCase().includes(q)
      );
    }
    if (filterCategory) {
      list = list.filter((p) => p.manifest.category === filterCategory);
    }
    return list;
  }, [plugins, search, filterCategory]);

  const categories = useMemo(() => {
    const cats = new Set(plugins.map((p) => p.manifest.category));
    return Array.from(cats).sort();
  }, [plugins]);

  const selected = plugins.find((p) => p.manifest.id === selectedId) ?? null;
  const enabledCount = plugins.filter((p) => isEnabled(p.manifest.id)).length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-[800px] max-w-[90vw] h-[600px] max-h-[80vh] bg-surface-raised border border-white/10 rounded-xl shadow-2xl flex overflow-hidden animate-fade-in">
        {/* Left panel: plugin list */}
        <div className="w-[300px] border-r border-white/5 flex flex-col">
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-white/5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-200">Plugins</h2>
              <span className="text-[10px] text-zinc-600">
                {enabledCount}/{plugins.length} active
              </span>
            </div>

            {/* Search */}
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter plugins..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white/5 border border-white/5 rounded-md text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent/40"
              />
            </div>

            {/* Category pills */}
            <div className="flex gap-1 mt-2 flex-wrap">
              <button
                onClick={() => setFilterCategory(null)}
                className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                  !filterCategory
                    ? 'bg-accent/20 text-accent-bright'
                    : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/5'
                }`}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                  className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                    filterCategory === cat
                      ? 'bg-accent/20 text-accent-bright'
                      : 'text-zinc-500 hover:text-zinc-400 hover:bg-white/5'
                  }`}
                >
                  {CATEGORY_LABELS[cat as PluginManifest['category']] ?? cat}
                </button>
              ))}
            </div>
          </div>

          {/* Plugin list */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-zinc-600">
                No plugins match your search.
              </div>
            ) : (
              filtered.map((plugin) => (
                <PluginRow
                  key={plugin.manifest.id}
                  plugin={plugin}
                  enabled={isEnabled(plugin.manifest.id)}
                  selected={selectedId === plugin.manifest.id}
                  onSelect={() => setSelectedId(plugin.manifest.id)}
                  onToggle={() => toggle(plugin.manifest.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right panel: detail */}
        <div className="flex-1 flex flex-col">
          {/* Close button */}
          <div className="flex justify-end px-3 pt-3">
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-white/5 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {selected ? (
            <PluginDetail plugin={selected} enabled={isEnabled(selected.manifest.id)} onToggle={() => toggle(selected.manifest.id)} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-zinc-600 text-sm mb-1">Select a plugin</div>
                <div className="text-zinc-700 text-xs">Click any plugin to view details</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  enabled,
  selected,
  onSelect,
  onToggle,
}: {
  plugin: OptimusPlugin;
  enabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const m = plugin.manifest;
  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer border-l-2 transition-colors ${
        selected
          ? 'border-accent bg-white/[0.04]'
          : 'border-transparent hover:bg-white/[0.02]'
      }`}
    >
      {/* Category icon */}
      <span className="text-sm text-zinc-600 w-5 text-center shrink-0">
        {CATEGORY_ICONS[m.category] ?? '◻'}
      </span>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-zinc-300 truncate">{m.name}</div>
        <div className="text-[10px] text-zinc-600 truncate">
          {m.author ?? 'Unknown'} &middot; v{m.version}
        </div>
      </div>

      {/* Toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
          enabled ? 'bg-accent' : 'bg-white/10'
        }`}
      >
        <span
          className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
            enabled ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </button>
    </div>
  );
}

function PluginDetail({
  plugin,
  enabled,
  onToggle,
}: {
  plugin: OptimusPlugin;
  enabled: boolean;
  onToggle: () => void;
}) {
  const m = plugin.manifest;

  return (
    <div className="flex-1 px-6 pb-6 overflow-y-auto">
      {/* Title row */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-200">{m.name}</h3>
          <div className="text-xs text-zinc-500 mt-0.5">
            {m.author ?? 'Unknown'} &middot; v{m.version} &middot;{' '}
            {CATEGORY_LABELS[m.category] ?? m.category}
          </div>
        </div>
        <button
          onClick={onToggle}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            enabled
              ? 'bg-white/5 text-zinc-400 hover:bg-red-500/10 hover:text-red-400'
              : 'bg-accent text-white hover:bg-accent-dim'
          }`}
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      {/* Description */}
      {m.description && (
        <p className="text-sm text-zinc-400 leading-relaxed mb-6">{m.description}</p>
      )}

      {/* Info grid */}
      <div className="space-y-4">
        <DetailSection title="Details">
          <DetailRow label="Plugin ID" value={m.id} />
          <DetailRow label="Category" value={CATEGORY_LABELS[m.category] ?? m.category} />
          <DetailRow label="Default Size" value={`${m.defaultSize.w} x ${m.defaultSize.h}`} />
          {m.minSize && (
            <DetailRow label="Min Size" value={`${m.minSize.w} x ${m.minSize.h}`} />
          )}
          <DetailRow label="Mobile" value={m.mobileSupported ? 'Supported' : 'Desktop only'} />
        </DetailSection>

        {m.dataDependencies.length > 0 && (
          <DetailSection title="Data Dependencies">
            <div className="flex gap-1.5 flex-wrap">
              {m.dataDependencies.map((dep) => (
                <span
                  key={dep}
                  className="px-2 py-0.5 text-[10px] bg-white/5 text-zinc-400 rounded-md font-mono"
                >
                  {dep}
                </span>
              ))}
            </div>
          </DetailSection>
        )}

        {m.writeCapabilities && m.writeCapabilities.length > 0 && (
          <DetailSection title="Write Capabilities">
            <div className="flex gap-1.5 flex-wrap">
              {m.writeCapabilities.map((cap) => (
                <span
                  key={cap}
                  className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 rounded-md font-mono"
                >
                  {cap}
                </span>
              ))}
            </div>
          </DetailSection>
        )}
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-2">
        {title}
      </h4>
      <div className="bg-white/[0.02] rounded-lg border border-white/5 p-3">{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300 font-mono text-[11px]">{value}</span>
    </div>
  );
}

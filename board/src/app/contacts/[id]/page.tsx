"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

const TIER_COLORS: Record<string, string> = {
  inner_circle: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  active: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  inbound_only: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  newsletter: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  automated: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  unknown: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
};

const PLATFORM_COLORS: Record<string, string> = {
  github: "bg-purple-500/10 text-purple-400",
  shopify: "bg-green-500/10 text-green-400",
  wordpress: "bg-blue-500/10 text-blue-400",
  vercel: "bg-zinc-500/10 text-zinc-300",
  linear: "bg-indigo-500/10 text-indigo-400",
  database: "bg-yellow-500/10 text-yellow-400",
  other: "bg-zinc-500/10 text-zinc-400",
};

const CHANNEL_COLORS: Record<string, string> = {
  email: "bg-blue-500/10 text-blue-400",
  linkedin: "bg-sky-500/10 text-sky-400",
  phone: "bg-green-500/10 text-green-400",
  slack: "bg-purple-500/10 text-purple-400",
  github: "bg-zinc-500/10 text-zinc-300",
  linear: "bg-indigo-500/10 text-indigo-400",
  telegram: "bg-cyan-500/10 text-cyan-400",
  other: "bg-zinc-500/10 text-zinc-400",
};

const TIER_OPTIONS = ["inner_circle", "active", "inbound_only", "newsletter", "automated", "unknown"] as const;
const TYPE_OPTIONS = ["person", "service", "team", "unknown"] as const;
const CHANNEL_OPTIONS = ["email", "linkedin", "phone", "slack", "github", "linear", "ashby", "telegram", "other"] as const;
const PLATFORM_OPTIONS = ["github", "shopify", "wordpress", "vercel", "linear", "database", "other"] as const;

interface ContactDetail {
  id: string;
  name: string | null;
  email_address: string | null;
  organization: string | null;
  contact_type: string;
  tier: string | null;
  is_vip: boolean;
  notes: string | null;
  phone: string | null;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  created_at: string;
  relationship_strength: number | null;
}

interface Identity {
  id: string;
  channel: string;
  identifier: string;
  verified_at: string | null;
  source: string | null;
  created_at: string;
}

interface Project {
  id: string;
  project_name: string;
  platform: string;
  locator: string;
  is_primary: boolean;
  platform_config?: Record<string, unknown>;
  created_at: string;
}

interface Signal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  resolved: boolean;
  resolved_at: string | null;
  direction: string;
  domain: string | null;
  created_at: string;
  subject: string | null;
  channel: string | null;
}

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);

  // Editable fields
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editTier, setEditTier] = useState("");
  const [editType, setEditType] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Add identity form
  const [addingIdentity, setAddingIdentity] = useState(false);
  const [newChannel, setNewChannel] = useState("email");
  const [newIdentifier, setNewIdentifier] = useState("");

  // Add project form
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newPlatform, setNewPlatform] = useState("github");
  const [newLocator, setNewLocator] = useState("");

  const load = useCallback(async () => {
    const data = await opsFetch<{
      contact: ContactDetail;
      identities: Identity[];
      projects: Project[];
      signals: Signal[];
    }>(`/api/contacts/${id}`);
    if (data) {
      setContact(data.contact);
      setIdentities(data.identities || []);
      setProjects(data.projects || []);
      setSignals(data.signals || []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit() {
    if (!contact) return;
    setEditName(contact.name || "");
    setEditOrg(contact.organization || "");
    setEditTier(contact.tier || "unknown");
    setEditType(contact.contact_type || "unknown");
    setEditNotes(contact.notes || "");
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    const result = await opsPost(`/api/contacts/${id}`, {
      name: editName || null,
      organization: editOrg || null,
      notes: editNotes || null,
    });
    // Tier and type are separate fields in the update handler
    if (result.ok) {
      // Also update tier/type if changed
      await opsPost(`/api/contacts/${id}`, {
        name: editName || null,
        organization: editOrg || null,
        contact_type: editType,
        notes: editNotes || null,
      });
      setEditing(false);
      await load();
    }
    setSaving(false);
  }

  async function handleAddIdentity() {
    if (!newIdentifier.trim()) return;
    const result = await opsPost(`/api/contacts/${id}/identities`, {
      channel: newChannel,
      identifier: newIdentifier.trim(),
    });
    if (result.ok) {
      setNewChannel("email");
      setNewIdentifier("");
      setAddingIdentity(false);
      await load();
    }
  }

  async function handleAddProject() {
    if (!newProjectName.trim() || !newLocator.trim()) return;
    const result = await opsPost(`/api/contacts/${id}/projects`, {
      project_name: newProjectName.trim(),
      platform: newPlatform,
      locator: newLocator.trim(),
    });
    if (result.ok) {
      setNewProjectName("");
      setNewPlatform("github");
      setNewLocator("");
      setAddingProject(false);
      await load();
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading contact...</div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Contact not found</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Link href="/contacts" className="hover:text-zinc-300 transition-colors">Contacts</Link>
          <span>/</span>
          <span className="text-zinc-300">{contact.name || contact.email_address || contact.id.slice(0, 8)}</span>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              {editing ? (
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-2xl font-bold bg-zinc-800 border border-white/10 rounded-lg px-3 py-1 text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                />
              ) : (
                <h1 className="text-2xl font-bold tracking-tight">{contact.name || "Unnamed Contact"}</h1>
              )}
              {contact.is_vip && (
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  VIP
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${TIER_COLORS[contact.tier ?? "unknown"] || TIER_COLORS.unknown}`}>
                {contact.tier ? contact.tier.replace("_", " ") : "unknown"}
              </span>
              {contact.contact_type && contact.contact_type !== "unknown" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                  {contact.contact_type}
                </span>
              )}
              {contact.organization && (
                <span className="text-xs text-zinc-500">{contact.organization}</span>
              )}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {!editing ? (
              <button
                onClick={startEdit}
                className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors"
              >
                Edit
              </button>
            ) : (
              <>
                <button
                  onClick={saveEdit}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: editable fields */}
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-2">Details</h3>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Organization</label>
                  <input
                    value={editOrg}
                    onChange={(e) => setEditOrg(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Tier</label>
                  <select
                    value={editTier}
                    onChange={(e) => setEditTier(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                  >
                    {TIER_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t.replace("_", " ")}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Type</label>
                  <select
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Notes</label>
                  <textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={3}
                    className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Organization</span>
                  <span className="text-zinc-200">{contact.organization || "--"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Email</span>
                  <span className="text-zinc-200">{contact.email_address || "--"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Phone</span>
                  <span className="text-zinc-200">{contact.phone || "--"}</span>
                </div>
                {contact.notes && (
                  <div className="pt-2 border-t border-white/5">
                    <span className="text-zinc-500 text-xs block mb-1">Notes</span>
                    <p className="text-zinc-300 text-xs whitespace-pre-wrap">{contact.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: stats */}
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-2">Stats</h3>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Emails Received" value={String(contact.emails_received || 0)} />
              <StatCard label="Emails Sent" value={String(contact.emails_sent || 0)} />
              <StatCard
                label="Last Received"
                value={contact.last_received_at ? new Date(contact.last_received_at).toLocaleDateString() : "Never"}
              />
              <StatCard
                label="Relationship"
                value={contact.relationship_strength != null ? `${(contact.relationship_strength * 100).toFixed(0)}%` : "N/A"}
              />
            </div>
          </div>
        </div>

        {/* Identities */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Identities</h3>
            {!addingIdentity && (
              <button
                onClick={() => setAddingIdentity(true)}
                className="px-2.5 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
              >
                + Identity
              </button>
            )}
          </div>
          <div className="p-4 space-y-2">
            {identities.length === 0 && !addingIdentity && (
              <p className="text-xs text-zinc-500">No identities linked yet.</p>
            )}
            {identities.map((identity) => (
              <div key={identity.id} className="flex items-center gap-3 text-sm">
                <span className={`text-[10px] px-2 py-0.5 rounded ${CHANNEL_COLORS[identity.channel] || CHANNEL_COLORS.other}`}>
                  {identity.channel}
                </span>
                <span className="text-zinc-200">{identity.identifier}</span>
                {identity.verified_at && (
                  <span className="text-[10px] text-emerald-400">verified</span>
                )}
                {identity.source && (
                  <span className="text-[10px] text-zinc-600">{identity.source}</span>
                )}
              </div>
            ))}
            {addingIdentity && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/5">
                <select
                  value={newChannel}
                  onChange={(e) => setNewChannel(e.target.value)}
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                >
                  {CHANNEL_OPTIONS.map((ch) => (
                    <option key={ch} value={ch}>{ch}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newIdentifier}
                  onChange={(e) => setNewIdentifier(e.target.value)}
                  placeholder="Identifier..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddIdentity();
                    if (e.key === "Escape") { setAddingIdentity(false); setNewIdentifier(""); }
                  }}
                />
                <button
                  onClick={handleAddIdentity}
                  className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAddingIdentity(false); setNewIdentifier(""); }}
                  className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Projects */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Projects</h3>
            {!addingProject && (
              <button
                onClick={() => setAddingProject(true)}
                className="px-2.5 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
              >
                + Project
              </button>
            )}
          </div>
          <div className="p-4 space-y-2">
            {projects.length === 0 && !addingProject && (
              <p className="text-xs text-zinc-500">No projects linked yet.</p>
            )}
            {projects.map((project) => (
              <div key={project.id} className="flex items-center gap-3 text-sm">
                <span className={`text-[10px] px-2 py-0.5 rounded ${PLATFORM_COLORS[project.platform] || PLATFORM_COLORS.other}`}>
                  {project.platform}
                </span>
                <span className="text-zinc-200 font-medium">{project.project_name}</span>
                <span className="text-zinc-500 text-xs">{project.locator}</span>
                {project.is_primary && (
                  <span className="text-[10px] text-emerald-400">primary</span>
                )}
              </div>
            ))}
            {addingProject && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/5">
                <select
                  value={newPlatform}
                  onChange={(e) => setNewPlatform(e.target.value)}
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                >
                  {PLATFORM_OPTIONS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project name..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[160px]"
                />
                <input
                  type="text"
                  value={newLocator}
                  onChange={(e) => setNewLocator(e.target.value)}
                  placeholder="Locator (URL/slug)..."
                  className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[200px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddProject();
                    if (e.key === "Escape") { setAddingProject(false); setNewProjectName(""); setNewLocator(""); }
                  }}
                />
                <button
                  onClick={handleAddProject}
                  className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAddingProject(false); setNewProjectName(""); setNewLocator(""); }}
                  className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Recent Signals */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <h3 className="text-sm font-medium text-zinc-300">Recent Signals</h3>
          </div>
          {signals.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">No signals found for this contact.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-white/5">
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">Content</th>
                    <th className="text-left px-4 py-2 font-medium">Subject</th>
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {signals.map((signal) => (
                    <tr key={signal.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                          {signal.signal_type}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-zinc-300 max-w-xs truncate">
                        {signal.content}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 max-w-[200px] truncate">
                        {signal.subject || "--"}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">
                        {new Date(signal.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
                        {signal.resolved ? (
                          <span className="text-emerald-400">resolved</span>
                        ) : (
                          <span className="text-zinc-500">open</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-800/50 border border-white/5 rounded-lg p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-sm font-medium text-zinc-200">{value}</div>
    </div>
  );
}

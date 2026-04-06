"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { usePageContext } from "@/contexts/PageContext";

// Tier color mapping
const TIER_COLORS: Record<string, string> = {
  inner_circle: "bg-emerald-500/10 text-emerald-400",
  active: "bg-blue-500/10 text-blue-400",
  inbound_only: "bg-zinc-500/10 text-zinc-400",
  newsletter: "bg-violet-500/10 text-violet-400",
  automated: "bg-orange-500/10 text-orange-400",
  unknown: "bg-zinc-500/10 text-zinc-500",
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

const CHANNEL_OPTIONS = [
  "email", "linkedin", "phone", "slack", "github", "linear", "ashby", "telegram", "other",
] as const;

const PLATFORM_OPTIONS = [
  "github", "shopify", "wordpress", "vercel", "linear", "database", "other",
] as const;

interface Contact {
  id: string;
  name: string | null;
  email_address: string | null;
  organization: string | null;
  contact_type: string;
  tier: string | null;
  is_vip: boolean;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  identities?: { id: string; channel: string; identifier: string }[];
  projects?: { id: string; project_name: string; platform: string; locator: string; is_primary: boolean }[];
}

interface DuplicatePair {
  id_a: string;
  name_a: string | null;
  email_a: string | null;
  id_b: string;
  name_b: string | null;
  email_b: string | null;
  name_sim: number;
}

export default function ContactsPage() {
  const { setCurrentPage } = usePageContext();
  useEffect(() => { setCurrentPage({ route: "/contacts", title: "Contacts" }); return () => setCurrentPage(null); }, [setCurrentPage]);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);
  const [addingIdentity, setAddingIdentity] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState("email");
  const [newIdentifier, setNewIdentifier] = useState("");
  const [addingProject, setAddingProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newPlatform, setNewPlatform] = useState("github");
  const [newLocator, setNewLocator] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [search, setSearch] = useState("");
  const [githubRepos, setGithubRepos] = useState<{ full_name: string; html_url: string; description?: string }[]>([]);

  // Fetch GitHub repos for the repo picker
  useEffect(() => {
    opsFetch<{ repos: { full_name: string; html_url: string; description?: string }[] }>("/api/github/repos")
      .then((data) => { if (data?.repos) setGithubRepos(data.repos); })
      .catch(() => {});
  }, []);

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch("/api/ops?path=/api/contacts");
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts || data || []);
      }
    } catch {
      // silent
    }
  }, []);

  const fetchDuplicates = useCallback(async () => {
    try {
      const res = await fetch("/api/ops?path=/api/contacts/duplicates");
      if (res.ok) {
        const data = await res.json();
        setDuplicates(data.duplicates || data || []);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchContacts(), fetchDuplicates()]).finally(() => setLoading(false));
  }, [fetchContacts, fetchDuplicates]);

  const handleMerge = async (primaryId: string, secondaryId: string) => {
    const key = `${primaryId}-${secondaryId}`;
    setMerging(key);
    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/contacts/merge", body: { primaryId, secondaryId } }),
      });
      if (res.ok) {
        setDuplicates((prev) => prev.filter((d) => !(d.id_a === primaryId && d.id_b === secondaryId)));
        await fetchContacts();
      }
    } catch {
      // silent
    } finally {
      setMerging(null);
    }
  };

  const handleAddIdentity = async (contactId: string) => {
    if (!newIdentifier.trim()) return;
    try {
      const res = await fetch("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/contacts/${contactId}/identities`,
          body: { channel: newChannel, identifier: newIdentifier.trim() },
        }),
      });
      if (res.ok) {
        setNewChannel("email");
        setNewIdentifier("");
        setAddingIdentity(null);
        await fetchContacts();
      }
    } catch {
      // silent
    }
  };

  const handleAddProject = async (contactId: string) => {
    if (!newProjectName.trim() || !newLocator.trim()) return;
    const result = await opsPost(`/api/contacts/${contactId}/projects`, {
      project_name: newProjectName.trim(),
      platform: newPlatform,
      locator: newLocator.trim(),
    });
    if (result.ok) {
      setNewProjectName("");
      setNewPlatform("github");
      setNewLocator("");
      setAddingProject(null);
      await fetchContacts();
    }
  };

  const handleClassify = async () => {
    setClassifying(true);
    await opsPost("/api/contacts/classify");
    await fetchContacts();
    setClassifying(false);
  };

  const filtered = contacts.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.organization && c.organization.toLowerCase().includes(q)) ||
      (c.email_address && c.email_address.toLowerCase().includes(q)) ||
      (c.identities && c.identities.some((id) => id.identifier.toLowerCase().includes(q)))
    );
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleClassify}
            disabled={classifying}
            className="px-3 py-1.5 text-xs rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors border border-indigo-500/20 disabled:opacity-50"
          >
            {classifying ? "Classifying..." : "Auto-classify"}
          </button>
          <span className="text-sm text-zinc-500">{contacts.length} total</span>
        </div>
      </div>

      {/* Potential Duplicates */}
      {duplicates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-amber-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            Potential Duplicates ({duplicates.length})
          </h2>
          <div className="space-y-2">
            {duplicates.map((dup) => {
              const key = `${dup.id_a}-${dup.id_b}`;
              return (
                <div
                  key={key}
                  className="bg-zinc-900 rounded-lg border border-amber-500/20 px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 min-w-0 flex-1">
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-200 font-medium">
                        {dup.name_a || "Unnamed"}
                      </span>
                      {dup.email_a && (
                        <span className="text-xs text-zinc-500 ml-1.5">{dup.email_a}</span>
                      )}
                    </div>
                    <span className="text-zinc-600 text-xs shrink-0">may be same as</span>
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-200 font-medium">
                        {dup.name_b || "Unnamed"}
                      </span>
                      {dup.email_b && (
                        <span className="text-xs text-zinc-500 ml-1.5">{dup.email_b}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {dup.name_sim != null && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 tabular-nums">
                        {Math.round(dup.name_sim * 100)}% match
                      </span>
                    )}
                    <button
                      onClick={() => handleMerge(dup.id_a, dup.id_b)}
                      disabled={merging === key}
                      className="px-3 py-1.5 text-xs rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                    >
                      {merging === key ? "Merging..." : "Merge"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search */}
      <div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts by name, org, or identifier..."
          className="w-full max-w-md px-3 py-2 text-sm bg-zinc-900 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-accent-bright"
        />
      </div>

      {/* Contact List */}
      {filtered.length === 0 ? (
        <div className="bg-surface-raised rounded-lg border border-white/5 py-12 text-center">
          <div className="text-zinc-500 text-sm">
            {search ? "No contacts match your search." : "No contacts found."}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((contact) => (
            <div
              key={contact.id}
              className="bg-surface-raised rounded-lg border border-white/10 px-4 py-3"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                {/* Left: contact info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="text-sm font-medium text-zinc-100 hover:text-white hover:underline transition-colors"
                    >
                      {contact.name || "Unnamed Contact"}
                    </Link>
                    {contact.organization && (
                      <span className="text-xs text-zinc-500">{contact.organization}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    {contact.contact_type && contact.contact_type !== "unknown" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400">
                        {contact.contact_type}
                      </span>
                    )}
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        TIER_COLORS[contact.tier ?? "unknown"] || TIER_COLORS.unknown
                      }`}
                    >
                      {contact.tier ? contact.tier.replace("_", " ") : "unknown"}
                    </span>
                  </div>
                  {/* Identities / Email */}
                  {contact.identities && contact.identities.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {contact.identities.map((identity) => (
                        <span
                          key={identity.id}
                          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/5"
                        >
                          <span className="text-zinc-500">{identity.channel}:</span>{" "}
                          {identity.identifier}
                        </span>
                      ))}
                    </div>
                  ) : contact.email_address ? (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/5">
                        <span className="text-zinc-500">email:</span>{" "}
                        {contact.email_address}
                      </span>
                    </div>
                  ) : null}
                  {/* Project badges */}
                  {contact.projects && contact.projects.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {contact.projects.map((project) => (
                        <span
                          key={project.id}
                          className={`text-[10px] px-2 py-0.5 rounded border border-white/5 ${
                            PLATFORM_COLORS[project.platform] || PLATFORM_COLORS.other
                          }`}
                        >
                          {project.project_name}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Add Identity form (inline) */}
                  {addingIdentity === contact.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={newChannel}
                        onChange={(e) => setNewChannel(e.target.value)}
                        className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                      >
                        {CHANNEL_OPTIONS.map((ch) => (
                          <option key={ch} value={ch}>
                            {ch}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={newIdentifier}
                        onChange={(e) => setNewIdentifier(e.target.value)}
                        placeholder="Identifier..."
                        className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-xs"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddIdentity(contact.id);
                          if (e.key === "Escape") {
                            setAddingIdentity(null);
                            setNewIdentifier("");
                          }
                        }}
                      />
                      <button
                        onClick={() => handleAddIdentity(contact.id)}
                        className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => {
                          setAddingIdentity(null);
                          setNewIdentifier("");
                        }}
                        className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {/* Add Project form (inline) */}
                  {addingProject === contact.id && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={newPlatform}
                          onChange={(e) => {
                            setNewPlatform(e.target.value);
                            setNewProjectName("");
                            setNewLocator("");
                          }}
                          className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright"
                        >
                          {PLATFORM_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        {newPlatform === "github" && githubRepos.length > 0 ? (
                          <>
                            <select
                              value={newLocator}
                              onChange={(e) => {
                                const repo = githubRepos.find((r) => r.html_url === e.target.value);
                                if (repo) {
                                  setNewLocator(repo.html_url);
                                  setNewProjectName(repo.full_name.split("/").pop() || repo.full_name);
                                }
                              }}
                              className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-accent-bright flex-1 max-w-[220px]"
                            >
                              <option value="">Select a repo...</option>
                              {githubRepos.map((r) => (
                                <option key={r.full_name} value={r.html_url}>
                                  {r.full_name}
                                </option>
                              ))}
                            </select>
                            <span className="text-zinc-600 text-[10px]">or</span>
                            <input
                              type="text"
                              value={newLocator}
                              onChange={(e) => setNewLocator(e.target.value)}
                              placeholder="Paste URL..."
                              className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[180px]"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleAddProject(contact.id);
                                if (e.key === "Escape") { setAddingProject(null); setNewProjectName(""); setNewLocator(""); }
                              }}
                            />
                          </>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={newProjectName}
                              onChange={(e) => setNewProjectName(e.target.value)}
                              placeholder="Project name..."
                              className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[140px]"
                            />
                            <input
                              type="text"
                              value={newLocator}
                              onChange={(e) => setNewLocator(e.target.value)}
                              placeholder="Locator (URL/slug)..."
                              className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright flex-1 max-w-[180px]"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleAddProject(contact.id);
                                if (e.key === "Escape") { setAddingProject(null); setNewProjectName(""); setNewLocator(""); }
                              }}
                            />
                          </>
                        )}
                      </div>
                      {newPlatform === "github" && newLocator && (
                        <input
                          type="text"
                          value={newProjectName}
                          onChange={(e) => setNewProjectName(e.target.value)}
                          placeholder="Display name (auto-filled from repo)..."
                          className="px-2 py-1 text-xs bg-zinc-800 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-accent-bright w-full max-w-[300px]"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleAddProject(contact.id)}
                          disabled={!newProjectName.trim() || !newLocator.trim()}
                          className="px-2.5 py-1 text-xs rounded bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => {
                            setAddingProject(null);
                            setNewProjectName("");
                            setNewLocator("");
                          }}
                          className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right: action buttons */}
                <div className="shrink-0 flex items-center gap-2">
                  {addingIdentity !== contact.id && addingProject !== contact.id && (
                    <>
                      <button
                        onClick={() => {
                          setAddingIdentity(contact.id);
                          setAddingProject(null);
                          setNewChannel("email");
                          setNewIdentifier("");
                        }}
                        className="px-3 py-1.5 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
                      >
                        + Identity
                      </button>
                      <button
                        onClick={() => {
                          setAddingProject(contact.id);
                          setAddingIdentity(null);
                          setNewProjectName("");
                          setNewPlatform("github");
                          setNewLocator("");
                        }}
                        className="px-3 py-1.5 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors border border-white/10"
                      >
                        + Project
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

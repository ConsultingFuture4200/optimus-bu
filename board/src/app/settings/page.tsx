"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { inboxGet } from "@/components/inbox/shared";

interface Status {
  gmail_connected: boolean;
  gmail_credentials: boolean;
  anthropic_configured: boolean;
  openai_configured: boolean;
  voyage_configured: boolean;
  slack_configured: boolean;
  demo_mode: boolean;
  gmail_email: string | null;
}

interface Account {
  id: string;
  channel: string;
  label: string;
  identifier: string;
  is_active: boolean;
  last_sync_at: string | null;
  sync_status: string;
  last_error: string | null;
  created_at: string;
}

interface DriveWatch {
  id: string;
  account_id: string;
  folder_id: string;
  folder_url: string | null;
  label: string;
  preset: string | null;
  is_active: boolean;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface VoiceStatus {
  sentEmails: number;
  embeddingsGenerated: number;
  globalProfile: { sampleCount: number; formality: number; lastUpdated: string } | null;
  recipientProfiles: number;
  editDeltas: number;
  embeddingProvider: "voyage" | "openai" | null;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const currentUser = session?.user?.name || "";
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [resyncingId, setResyncingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [addingLabel, setAddingLabel] = useState("");
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [syncingContactsId, setSyncingContactsId] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState<string | null>(null);
  const [driveWatches, setDriveWatches] = useState<DriveWatch[]>([]);
  const [driveAdding, setDriveAdding] = useState(false);
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [driveLabel, setDriveLabel] = useState("");
  const [drivePreset, setDrivePreset] = useState("tldv");
  const [driveAccountId, setDriveAccountId] = useState("");
  const [driveRemovingId, setDriveRemovingId] = useState<string | null>(null);
  const refresh = useCallback(() => {
    inboxGet("/api/status", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    inboxGet(`/api/accounts${currentUser ? `?owner=${encodeURIComponent(currentUser)}` : ''}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => setAccounts(data.accounts || data || []))
      .catch(() => {});
    inboxGet("/api/voice/status", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setVoiceStatus)
      .catch(() => {});
    inboxGet("/api/drive/watches", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => setDriveWatches(data.watches || []))
      .catch(() => {});
  }, [currentUser]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connectGmail = async (label?: string) => {
    setConnecting(true);
    try {
      const ownerParam = currentUser ? `&owner=${encodeURIComponent(currentUser)}` : '';
      const path = label
        ? `/api/auth/gmail?label=${encodeURIComponent(label)}${ownerParam}`
        : `/api/auth/gmail-url?owner=${encodeURIComponent(currentUser)}`;
      const res = await inboxGet(path);
      const { url, error } = await res.json();
      if (error) {
        alert(error);
        setConnecting(false);
        return;
      }
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  const disconnectAccount = async (accountId: string) => {
    setDisconnectingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/disconnect", body: { accountId } }),
      });
      refresh();
    } catch {}
    setDisconnectingId(null);
  };

  const deleteAccount = async (accountId: string) => {
    if (!confirm("Permanently delete this account and all its data? This cannot be undone.")) return;
    setDisconnectingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/delete", body: { accountId } }),
      });
      refresh();
    } catch {}
    setDisconnectingId(null);
  };

  const resyncAccount = async (accountId: string) => {
    setResyncingId(accountId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/api/accounts/resync", body: { accountId } }),
        });
        if (res.ok) { refresh(); break; }
        if (res.status !== 503 || attempt === 2) break;
        // Agents busy — wait and retry
        await new Promise(r => setTimeout(r, 3000));
      } catch { break; }
    }
    setResyncingId(null);
  };

  const syncContacts = async (accountId: string) => {
    setSyncingContactsId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/contacts/sync", body: { accountId } }),
      });
      refresh();
    } catch {}
    setSyncingContactsId(null);
  };

  const [trainingId, setTrainingId] = useState<string | null>(null);

  const trainVoice = async (accountId: string) => {
    setTrainingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/voice/bootstrap", body: { accountId, sampleSize: 500 } }),
      });
      refresh();
    } catch {}
    setTrainingId(null);
  };

  const activateAccount = async (accountId: string) => {
    setActivatingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/activate", body: { accountId } }),
      });
      refresh();
    } catch {}
    setActivatingId(null);
  };

  const saveKey = async (key: string) => {
    const value = keyInputs[key];
    if (!value || value.length < 8) return;
    setKeySaving(key);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/settings/keys", body: { key, value } }),
      });
      const data = await res.json();
      if (data.ok) {
        setKeySaved(key);
        setKeyInputs((prev) => ({ ...prev, [key]: "" }));
        setTimeout(() => setKeySaved(null), 2000);
        refresh();
      }
    } catch {}
    setKeySaving(null);
  };

  const addDriveWatch = async () => {
    if (!driveFolderUrl || !driveLabel || !driveAccountId) return;
    setDriveAdding(true);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/drive/watches",
          body: {
            folder_url: driveFolderUrl,
            label: driveLabel,
            preset: drivePreset || null,
            account_id: driveAccountId,
          },
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setDriveFolderUrl("");
        setDriveLabel("");
        setDrivePreset("tldv");
        refresh();
      }
    } catch {}
    setDriveAdding(false);
  };

  const removeDriveWatch = async (id: string) => {
    setDriveRemovingId(id);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/drive/watches/remove", body: { id } }),
      });
      refresh();
    } catch {}
    setDriveRemovingId(null);
  };

  if (!status) {
    return (
      <div className="space-y-8">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  const API_KEYS: { key: string; label: string; configured: boolean }[] = [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API", configured: status.anthropic_configured },
    { key: "OPENAI_API_KEY", label: "OpenAI API", configured: status.openai_configured },
    { key: "VOYAGE_API_KEY", label: "Voyage AI", configured: status.voyage_configured },
    { key: "SLACK_BOT_TOKEN", label: "Slack Bot", configured: status.slack_configured },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Connected Accounts */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Connected Accounts</h2>
          <span className="text-xs text-zinc-500">{accounts.filter((a) => a.is_active).length} active</span>
        </div>

        {accounts.length > 0 ? (
          <div className="space-y-3 mb-4">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-md bg-surface-overlay px-4 py-3 gap-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      acc.channel === "slack"
                        ? "bg-purple-500/20 text-purple-400"
                        : "bg-blue-500/20 text-blue-400"
                    }`}
                  >
                    {acc.channel === "slack" ? "# Slack" : "\u2709 Email"}
                  </span>
                  <div>
                    <div className="text-sm text-white font-medium">{acc.label}</div>
                    <div className="text-xs text-zinc-500">{acc.identifier}</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <div
                        className={`h-2 w-2 rounded-full ${
                          !acc.is_active
                            ? "bg-zinc-600"
                            : acc.sync_status === "active"
                              ? "bg-status-approved"
                              : acc.sync_status === "error"
                                ? "bg-status-action"
                              : acc.sync_status === "setup"
                                ? "bg-orange-400"
                                : acc.sync_status === "syncing" || acc.sync_status === "pending"
                                  ? "bg-yellow-400"
                                  : "bg-zinc-600"
                        }`}
                      />
                      <span className="text-xs text-zinc-400">
                        {!acc.is_active
                          ? "Disconnected"
                          : acc.sync_status === "setup"
                            ? "Needs activation"
                            : acc.sync_status === "pending"
                              ? "Waiting for first sync"
                              : acc.sync_status === "active"
                                ? "Active"
                                : acc.sync_status === "syncing"
                                  ? "Syncing"
                                  : acc.sync_status === "error"
                                    ? "Error"
                                    : acc.sync_status}
                      </span>
                    </div>
                    {acc.last_sync_at && (
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Last sync: {new Date(acc.last_sync_at).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                  {acc.is_active && acc.sync_status === "setup" ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => trainVoice(acc.id)}
                        disabled={trainingId === acc.id}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
                      >
                        {trainingId === acc.id ? "Training..." : "Train Voice"}
                      </button>
                      <button
                        onClick={() => activateAccount(acc.id)}
                        disabled={activatingId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                      >
                        {activatingId === acc.id ? "..." : "Skip & Activate"}
                      </button>
                    </div>
                  ) : acc.is_active ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => syncContacts(acc.id)}
                        disabled={syncingContactsId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                      >
                        {syncingContactsId === acc.id ? "..." : "Sync Contacts"}
                      </button>
                      <button
                        onClick={() => resyncAccount(acc.id)}
                        disabled={resyncingId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                      >
                        {resyncingId === acc.id ? "..." : "Resync"}
                      </button>
                      <button
                        onClick={() => disconnectAccount(acc.id)}
                        disabled={disconnectingId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
                      >
                        {disconnectingId === acc.id ? "..." : "Disconnect"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => deleteAccount(acc.id)}
                      disabled={disconnectingId === acc.id}
                      className="rounded-md border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {disconnectingId === acc.id ? "..." : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500 mb-4">No accounts connected yet.</div>
        )}

        {/* Add Account */}
        {status.gmail_credentials ? (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              type="text"
              value={addingLabel}
              onChange={(e) => setAddingLabel(e.target.value)}
              placeholder="Label (e.g., Work Email)"
              className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
            />
            <button
              onClick={() => connectGmail(addingLabel || "Gmail")}
              disabled={connecting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 whitespace-nowrap"
            >
              {connecting ? "Connecting..." : "+ Add Gmail Account"}
            </button>
          </div>
        ) : (
          <div className="rounded-md bg-surface-overlay p-4 text-sm text-zinc-400">
            <p className="font-medium text-zinc-300 mb-1">
              OAuth credentials required
            </p>
            <p>
              Set <code className="text-accent-bright">GMAIL_CLIENT_ID</code>{" "}
              and{" "}
              <code className="text-accent-bright">GMAIL_CLIENT_SECRET</code>{" "}
              in your .env file, then restart.
            </p>
          </div>
        )}

        <p className="text-xs text-zinc-500 mt-3">
          Add multiple Gmail accounts to aggregate all inboxes. Each account is polled independently.
        </p>
      </div>

      {/* Drive Folder Watches */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Drive Folder Watches</h2>
          <span className="text-xs text-zinc-500">{driveWatches.filter(w => w.is_active).length} active</span>
        </div>

        {driveWatches.length > 0 ? (
          <div className="space-y-3 mb-4">
            {driveWatches.map((watch) => (
              <div
                key={watch.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-md bg-surface-overlay px-4 py-3 gap-3"
              >
                <div className="flex items-center gap-3">
                  {watch.preset && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400">
                      {watch.preset}
                    </span>
                  )}
                  <div>
                    <div className="text-sm text-white font-medium">{watch.label}</div>
                    <div className="text-xs text-zinc-500">
                      {watch.folder_url ? (
                        <a href={watch.folder_url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
                          {watch.folder_id}
                        </a>
                      ) : watch.folder_id}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <div className={`h-2 w-2 rounded-full ${
                        watch.last_error ? "bg-status-action"
                          : watch.is_active ? "bg-status-approved"
                          : "bg-zinc-600"
                      }`} />
                      <span className="text-xs text-zinc-400">
                        {watch.last_error ? "Error" : watch.is_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {watch.last_poll_at && (
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Last poll: {new Date(watch.last_poll_at).toLocaleTimeString()}
                      </div>
                    )}
                    {watch.last_error && (
                      <div className="text-xs text-red-400 mt-0.5 max-w-48 truncate" title={watch.last_error}>
                        {watch.last_error}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => removeDriveWatch(watch.id)}
                    disabled={driveRemovingId === watch.id}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
                  >
                    {driveRemovingId === watch.id ? "..." : "Remove"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500 mb-4">No folder watches configured.</div>
        )}

        {/* Add Watch Form */}
        {accounts.filter(a => a.is_active && a.channel === "email").length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                type="text"
                value={driveFolderUrl}
                onChange={(e) => setDriveFolderUrl(e.target.value)}
                placeholder="Google Drive folder URL"
                className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
              />
              <input
                type="text"
                value={driveLabel}
                onChange={(e) => setDriveLabel(e.target.value)}
                placeholder="Label (e.g., Meeting Notes)"
                className="w-full sm:w-48 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
              />
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <select
                value={drivePreset}
                onChange={(e) => setDrivePreset(e.target.value)}
                className="rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
              >
                <option value="tldv">tl;dv Meeting Transcripts</option>
                <option value="generic">Generic</option>
              </select>
              <select
                value={driveAccountId}
                onChange={(e) => setDriveAccountId(e.target.value)}
                className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
              >
                <option value="">Select Gmail account...</option>
                {accounts.filter(a => a.is_active && a.channel === "email").map(a => (
                  <option key={a.id} value={a.id}>{a.label} ({a.identifier})</option>
                ))}
              </select>
              <button
                onClick={addDriveWatch}
                disabled={driveAdding || !driveFolderUrl || !driveLabel || !driveAccountId}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 whitespace-nowrap"
              >
                {driveAdding ? "Adding..." : "+ Add Watch"}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-md bg-surface-overlay p-4 text-sm text-zinc-400">
            Connect a Gmail account first — Drive watches use Gmail OAuth credentials with Drive read access.
          </div>
        )}

        <p className="text-xs text-zinc-500 mt-3">
          Watch a Google Drive folder for new documents. New files are fed into the signal pipeline for extraction.
          Requires re-authenticating your Gmail account to grant Drive read access.
        </p>
      </div>

      {/* Voice Training */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">Voice Training</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Analyze sent emails to learn your writing style — greetings, closings,
          vocabulary, and tone.
        </p>

        {voiceStatus === null ? (
          <div className="text-sm text-zinc-500">Loading voice status...</div>
        ) : voiceStatus.sentEmails === 0 ? (
          <div className="rounded-md bg-surface-overlay p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-2 w-2 rounded-full bg-zinc-600" />
              <span className="text-sm text-zinc-300 font-medium">Not trained</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">
              No sent emails analyzed yet. Connect an account and run voice training to enable reply drafting in your style.
            </p>
            <code className="text-xs text-accent-bright">npm run bootstrap-voice</code>
          </div>
        ) : (
          <div className="space-y-3">
            <StatusRow
              label="Voice Profile"
              ok={!!voiceStatus.globalProfile}
              detail={
                voiceStatus.globalProfile
                  ? `${voiceStatus.globalProfile.sampleCount} samples, formality ${voiceStatus.globalProfile.formality.toFixed(2)}`
                  : "Not built"
              }
            />
            <StatusRow
              label="Sent Emails"
              ok={voiceStatus.sentEmails > 0}
              detail={`${voiceStatus.sentEmails} analyzed`}
            />
            <StatusRow
              label="Embeddings"
              ok={voiceStatus.embeddingsGenerated > 0}
              detail={
                voiceStatus.embeddingProvider
                  ? `${voiceStatus.embeddingsGenerated} via ${voiceStatus.embeddingProvider}`
                  : `${voiceStatus.embeddingsGenerated} (no provider configured)`
              }
            />
            <StatusRow
              label="Recipient Profiles"
              ok={voiceStatus.recipientProfiles > 0}
              detail={`${voiceStatus.recipientProfiles} profiles`}
            />
            <StatusRow
              label="Edit Deltas"
              ok={null}
              detail={`${voiceStatus.editDeltas} recorded`}
            />
            <div className="pt-2">
              <code className="text-xs text-accent-bright">npm run bootstrap-voice</code>
              <span className="text-xs text-zinc-500 ml-2">to re-train</span>
            </div>
          </div>
        )}
      </div>

      {/* API Keys */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">API Keys</h2>
        <div className="space-y-3">
          {API_KEYS.map(({ key, label, configured }) => (
            <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    configured ? "bg-status-approved" : "bg-status-action"
                  }`}
                />
                <span className="text-sm text-zinc-300">{label}</span>
                {configured && !keyInputs[key] && keySaved !== key && (
                  <span className="text-xs text-zinc-500 sm:hidden">Configured</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {configured && !keyInputs[key] && keySaved !== key && (
                  <span className="text-xs text-zinc-500 hidden sm:inline">Configured</span>
                )}
                {keySaved === key && (
                  <span className="text-xs text-green-400">Saved</span>
                )}
                <input
                  type="password"
                  value={keyInputs[key] || ""}
                  onChange={(e) =>
                    setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={configured ? "Replace key..." : "sk-..."}
                  className="w-full sm:w-48 rounded-md bg-surface-overlay border border-white/10 px-2 py-1 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none font-mono"
                />
                <button
                  onClick={() => saveKey(key)}
                  disabled={keySaving === key || !keyInputs[key] || (keyInputs[key]?.length || 0) < 8}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 shrink-0"
                >
                  {keySaving === key ? "..." : "Save"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Keys are saved to .env and loaded into the running process. Anthropic is required; OpenAI or Voyage enable embeddings.
        </p>
      </div>

      {/* System Status */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">System Status</h2>
        <div className="space-y-3">
          <StatusRow
            label="Gmail"
            ok={status.gmail_connected}
            detail={status.gmail_connected ? status.gmail_email || "Connected" : "No active account"}
          />
          <StatusRow
            label="Accounts"
            ok={accounts.filter((a) => a.is_active).length > 0}
            detail={`${accounts.filter((a) => a.is_active).length} active`}
          />
          <StatusRow
            label="Demo Mode"
            ok={null}
            detail={status.demo_mode ? "Active" : "Off"}
          />
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div
          className={`h-2 w-2 rounded-full ${
            ok === null
              ? "bg-zinc-500"
              : ok
                ? "bg-status-approved"
                : "bg-status-action"
          }`}
        />
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <span className="text-sm text-zinc-500">{detail}</span>
    </div>
  );
}

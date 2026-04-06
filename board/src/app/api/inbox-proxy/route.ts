import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";

const INBOX_API_URL = process.env.INBOX_API_URL || process.env.OPS_API_URL || "http://localhost:3001";
const INBOX_API_SECRET = process.env.INBOX_API_SECRET || process.env.OPS_API_SECRET || "";

// Exact-match paths
const ALLOWED_PATHS = [
  // Settings / system
  "/api/gates",
  "/api/gates/readiness",
  "/api/gates/measure",
  "/api/phase/current",
  "/api/phase/dead-man-switch",
  "/api/phase/dead-man-switch/renew",
  "/api/phase/exploration",
  "/api/phase/activate",
  "/api/system/halt",
  "/api/system/resume",
  "/api/stats",
  "/api/status",
  "/api/accounts",
  "/api/emails/archive",
  "/api/emails/unarchive",
  "/api/voice/bootstrap",
  "/api/voice/rebuild",
  "/api/drive/watches",
  // Drafts
  "/api/drafts",
  "/api/drafts/approve",
  "/api/drafts/reject",
  "/api/drafts/send",
  "/api/drafts/send-approved",
  "/api/drafts/bulk",
  // Today / Signals
  "/api/today",
  "/api/signals",
  "/api/signals/feed",
  "/api/signals/resolve",
  "/api/signals/feedback",
  // Pipeline
  "/api/debug/pipeline",
  // Briefing (used by drafts page for stats)
  "/api/briefing",
  // Signals unresolve (used by undo)
  "/api/signals/unresolve",
  // Drafts edit
  "/api/drafts/edit",
  // Email body (used by expanded views)
  "/api/emails/body",
  // Pipeline retry
  "/api/pipeline/stuck/retry",
  // Settings (connected accounts, voice, keys, auth)
  "/api/voice/status",
  "/api/accounts/disconnect",
  "/api/accounts/delete",
  "/api/accounts/resync",
  "/api/accounts/activate",
  "/api/contacts/sync",
  "/api/settings/keys",
  "/api/drive/watches/remove",
  "/api/auth/gmail-url",
  "/api/board-members",
  // Knowledge Base
  "/api/documents",
  "/api/documents/stats",
  "/api/documents/detail",
  "/api/documents/ingest",
  "/api/documents/ingest-email",
  "/api/documents/ingest-drive",
  "/api/documents/embed-pending",
  "/api/documents/reembed",
  "/api/documents/search",
  "/api/search",
  "/api/search/stats",
];

// Prefix-match paths (dynamic segments like /api/contacts/:id)
const ALLOWED_PREFIXES = [
  "/api/contacts/",
  "/api/accounts/",
  "/api/drive/",
  "/api/emails/",
  "/api/auth/",
  "/api/documents/",
];

function isPathAllowed(path: string): boolean {
  const pathOnly = path.split("?")[0]; // strip query params for allowlist check
  if (ALLOWED_PATHS.includes(pathOnly)) return true;
  return ALLOWED_PREFIXES.some((prefix) => pathOnly.startsWith(prefix));
}

/**
 * Generic GET proxy -- forwards authenticated GET requests to the inbox backend.
 * Client sends ?path=/api/... and this route adds the Authorization header.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!INBOX_API_SECRET) {
    return NextResponse.json({ error: "INBOX_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const path = req.nextUrl.searchParams.get("path");
    if (!path || !isPathAllowed(path)) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }

    const res = await fetch(`${INBOX_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${INBOX_API_SECRET}` },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Backend error" }));
      return NextResponse.json(err, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}

/**
 * Generic POST proxy -- forwards any POST to the inbox backend with Bearer auth.
 * The client sends { path, body } and this route adds the Authorization header
 * server-side so the secret never reaches the browser.
 */
export async function POST(req: NextRequest) {
  const postSession = await getServerSession(authOptions);
  if (!postSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!INBOX_API_SECRET) {
    return NextResponse.json({ error: "INBOX_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body, method: methodOverride } = await req.json();
    if (!path || typeof path !== "string" || !isPathAllowed(path)) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }

    const httpMethod = (methodOverride === "GET" ? "GET" : "POST");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${INBOX_API_SECRET}`,
    };
    if (httpMethod === "POST") {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${INBOX_API_URL}${path}`, {
      method: httpMethod,
      headers,
      body: httpMethod === "POST" && body != null ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Backend error" }));
      return NextResponse.json(err, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}

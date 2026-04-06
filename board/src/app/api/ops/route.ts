import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";
const FETCH_TIMEOUT_MS = 10_000;
const CHAT_FETCH_TIMEOUT_MS = 60_000; // Chat responses can take longer

function validatePath(path: string | null): path is string {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/api/")) return false;
  if (path.includes("..") || /[@#]/.test(path)) return false;
  // Verify constructed URL resolves to expected origin
  try {
    const url = new URL(path, API_URL);
    const expected = new URL(API_URL);
    if (url.origin !== expected.origin) return false;
  } catch {
    return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const path = req.nextUrl.searchParams.get("path");
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.name || "unknown";
    const isChat = path.startsWith("/api/chat/");

    const res = await fetch(`${API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      signal: AbortSignal.timeout(isChat ? CHAT_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS),
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

export async function PATCH(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.name || "unknown";

    const res = await fetch(`${API_URL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

export async function POST(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.name || "unknown";
    const isChat = path.startsWith("/api/chat/");

    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(isChat ? CHAT_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS),
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

export async function DELETE(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.name || "unknown";

    const res = await fetch(`${API_URL}${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

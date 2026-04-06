import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * HTML preview proxy — streams raw HTML from autobot-inbox preview endpoints.
 *
 * GET /api/preview?path=/api/redesign/preview/:id
 * GET /api/preview?path=/api/blueprint/view/:id
 * GET /api/preview?path=/api/redesign/strategy/:id
 *
 * Unlike /api/ops (which parses JSON), this passes through the HTML body directly.
 */
export async function GET(req: NextRequest) {
  if (!API_SECRET) {
    return new NextResponse("OPS_API_SECRET not configured", { status: 500 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path || !path.startsWith("/api/")) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  // Only allow known preview paths
  const allowedPrefixes = [
    "/api/redesign/preview/",
    "/api/redesign/strategy/",
    "/api/blueprint/view/",
  ];
  if (!allowedPrefixes.some((p) => path.startsWith(p))) {
    return new NextResponse("Path not allowed", { status: 403 });
  }

  // Validate URL resolves to expected origin
  try {
    const url = new URL(path, API_URL);
    const expected = new URL(API_URL);
    if (url.origin !== expected.origin) {
      return new NextResponse("Invalid path", { status: 400 });
    }
  } catch {
    return new NextResponse("Invalid path", { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Backend error");
      return new NextResponse(text, { status: res.status });
    }

    const html = await res.text();
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Backend unreachable", { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { default as nextAuthMiddleware } from "next-auth/middleware";

// Bypass auth entirely in development
export default process.env.NODE_ENV === "development"
  ? () => NextResponse.next()
  : nextAuthMiddleware;

export const config = {
  matcher: [
    // Protect all routes except auth API and static assets
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};

export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    // Protect all routes except auth API and static assets
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};

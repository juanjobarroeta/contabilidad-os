/**
 * CORS middleware for cross-origin API clients (construccion-admin,
 * fleet-maintenance, marketing-zionx, etc.).
 *
 * Scoped narrowly: only the endpoints those clients actually need. The rest
 * of the app — UI routes, NextAuth callbacks, and any route not listed in
 * the matcher — is unaffected and stays same-origin only.
 *
 * Allowed origins come from the `API_ALLOWED_ORIGINS` env var, comma-
 * separated (e.g. `https://construccion-admin.vercel.app,http://localhost:5173`).
 * If the env var is unset we allow nothing cross-origin, which is a safer
 * default than `*` for a multi-tenant SaaS.
 *
 * The routes gated here use bearer-token auth (see src/lib/authz.ts), so we
 * do NOT set `Access-Control-Allow-Credentials: true` — cookies are not
 * needed, and omitting credentials keeps the surface area smaller.
 */

import { NextRequest, NextResponse } from "next/server";

const ALLOWED = (process.env.API_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED.includes(origin);
}

function withCors(res: NextResponse, origin: string | null): NextResponse {
  if (isAllowed(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin!);
    res.headers.set("Vary", "Origin");
    res.headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,DELETE,OPTIONS"
    );
    res.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");

  // Preflight: respond 204 with CORS headers, never hit the route handler.
  if (req.method === "OPTIONS") {
    if (!isAllowed(origin)) {
      return new NextResponse(null, { status: 403 });
    }
    return withCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Non-preflight: let the route run, then decorate the response with
  // CORS headers so the browser can read it.
  const res = NextResponse.next();
  return withCors(res, origin);
}

/**
 * Matcher: only run on routes cross-origin clients are expected to hit.
 * Everything else (UI pages, NextAuth /api/auth/[...nextauth], signup, etc.)
 * is untouched.
 */
export const config = {
  matcher: [
    "/api/auth/token",
    "/api/companies/:path*",
    "/api/construccion/:path*",
  ],
};

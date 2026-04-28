// Admin auth proxy (Next.js 16's renamed `middleware`). Public dashboard,
// gated mutations.
//
// Strategy: every read endpoint (GET /api/status, /api/actions, /api/forecast,
// /api/history, /api/preview-decision, /api/rates) stays public so portfolio
// visitors see live data. Every write or sensitive endpoint requires a cookie
// matching ADMIN_TOKEN.
//
// Cookie is set by POST /api/admin/login when the user supplies the matching
// password; cleared by POST /api/admin/logout. The cookie is httpOnly + secure
// in production, so JS can't read it (defense against XSS) and HTTPS prevents
// network capture.
//
// In dev (ADMIN_TOKEN unset), the proxy allows everything — same pattern
// as CRON_SECRET in /api/cron/decide. Keeps local dev frictionless.
//
// The matcher pattern excludes OAuth callbacks (/api/auth/*/callback) because
// those are invoked by external providers (Tesla, Smartcar) and authenticate
// via OAuth state, not our cookie. The catch-all gating happens at the
// `auth/<provider>/start` initiation routes instead.

import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: [
    // --- Mutations ---
    "/api/config/:path*",
    "/api/reserve/:path*",
    // Note: /api/integrations is intentionally NOT gated. It returns
    // provider connection state for the public demo (with system_id
    // redacted server-side). The mutations against it (connect/
    // disconnect) hit the /api/auth/<provider> routes, which are
    // gated below.

    // --- Diagnostics + admin tools ---
    "/api/admin/:path*",

    // --- OAuth flow initiations (callbacks themselves stay public) ---
    "/api/auth/enphase",
    "/api/auth/smartcar",
    "/api/auth/tesla",
    "/api/auth/rivian",
    "/api/auth/rivian/start",
    "/api/auth/rivian/otp",
  ],
};

// Sub-paths under /api/admin/* that must remain public so the user can
// actually authenticate. The login/logout routes check ADMIN_TOKEN
// themselves; we just exclude them from the cookie-based gate here.
const ADMIN_PUBLIC_PATHS = new Set([
  "/api/admin/login",
  "/api/admin/logout",
]);

// Routes where GET is public but mutations (POST/PUT/DELETE) require
// admin. /api/config falls into this bucket: the Settings page renders
// for unauthenticated visitors and needs the config values to show
// current state, but only authenticated admins can save changes.
const PUBLIC_READ_PATHS = new Set(["/api/config"]);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow login/logout endpoints through unauthenticated.
  if (ADMIN_PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // Allow GET on read-also routes through unauthenticated.
  if (req.method === "GET" && PUBLIC_READ_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const expected = process.env.ADMIN_TOKEN;

  // Dev escape hatch: no ADMIN_TOKEN set → allow everything. Mirrors the
  // CRON_SECRET pattern. Production must always have ADMIN_TOKEN set.
  if (!expected) return NextResponse.next();

  const cookie = req.cookies.get("helios_admin")?.value;

  // Constant-time comparison would be marginally better, but the cookie
  // is sent over HTTPS and the value is a 32+ byte random — timing
  // attacks aren't a realistic concern at this app's scale.
  if (cookie === expected) return NextResponse.next();

  return NextResponse.json(
    { error: "admin only — sign in at /admin/login" },
    { status: 401 },
  );
}

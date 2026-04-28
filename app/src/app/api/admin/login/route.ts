// POST /api/admin/login
//
// Body: { password: string }
//
// On match: sets helios_admin cookie, returns 200 { ok: true }.
// On mismatch: 401 { error: "invalid password" }.
// In dev with ADMIN_TOKEN unset: 200 + cookie set to literal "dev" so the
// rest of the auth UI behaves as expected. The middleware short-circuits
// in dev anyway, so this just keeps the UX consistent.

import { cookies } from "next/headers";
import { z } from "zod";

const loginSchema = z.object({
  password: z.string().min(1).max(512),
});

const COOKIE_NAME = "helios_admin";
const COOKIE_MAX_AGE_DAYS = 30;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "password required" }, { status: 400 });
  }

  const expected = process.env.ADMIN_TOKEN;

  // Dev mode: accept any password, set a placeholder cookie so /api/me
  // reports admin=true and the Settings UI behaves consistently.
  if (!expected) {
    await setCookie("dev");
    return Response.json({ ok: true, dev: true });
  }

  if (parsed.data.password !== expected) {
    return Response.json({ error: "invalid password" }, { status: 401 });
  }

  await setCookie(expected);
  return Response.json({ ok: true });
}

async function setCookie(value: string) {
  const c = await cookies();
  c.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * COOKIE_MAX_AGE_DAYS,
    path: "/",
  });
}

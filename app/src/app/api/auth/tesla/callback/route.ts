// Tesla OAuth callback. Same shape as the Enphase callback — verify
// state, exchange code, look up the user's first energy site, store
// token + system_id, redirect back to /settings.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { saveToken } from "@/lib/db";
import {
  exchangeCode,
  listProducts,
  tokenResponseToRecord,
} from "@/lib/tesla";

const STATE_COOKIE = "tesla_oauth_state";

function fail(request: Request, reason: string): Response {
  const url = new URL(`/settings?tesla=error&reason=${encodeURIComponent(reason)}`, request.url);
  return NextResponse.redirect(url, 302);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const teslaError = params.get("error");

  if (teslaError) return fail(request, teslaError);
  if (!code || !state) return fail(request, "missing-code-or-state");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return fail(request, "state-mismatch");
  }
  store.delete(STATE_COOKIE);

  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(request, "server-misconfigured");

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/tesla/callback`;

  let tokenResp;
  try {
    tokenResp = await exchangeCode({ clientId, clientSecret, redirectUri, code });
  } catch (err) {
    console.error("[tesla/callback] exchange failed:", err);
    return fail(request, "exchange-failed");
  }

  // Stash the token so listProducts() (which uses it via the client) works.
  await saveToken(tokenResponseToRecord(tokenResp, null));

  // Pin the first energy_site we see — most accounts have one.
  let siteId: string | null = null;
  try {
    const products = await listProducts();
    const energy = products.find(
      (p) => p.energy_site_id != null && p.resource_type !== "vehicle",
    );
    if (energy?.energy_site_id) siteId = String(energy.energy_site_id);
  } catch (err) {
    console.error("[tesla/callback] listProducts failed:", err);
  }

  if (siteId) {
    await saveToken(tokenResponseToRecord(tokenResp, siteId));
  }

  const successUrl = new URL("/settings?tesla=connected", request.url);
  return NextResponse.redirect(successUrl, 302);
}

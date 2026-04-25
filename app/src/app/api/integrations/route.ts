// Read-only status of each provider integration. Drives the Settings
// page's Integrations card without leaking token values.
//
// `state` resolves to one of:
//   "configured"    — env credentials present and a valid token is stored
//   "creds-missing" — env credentials missing on the server
//   "not-connected" — credentials present but user hasn't run OAuth yet
//   "error"         — token exists but a recent call failed (best-effort)

import { getToken } from "@/lib/db";
import { getSummary } from "@/lib/enphase";

type ProviderState =
  | "configured"
  | "creds-missing"
  | "not-connected"
  | "error";

type ProviderStatus = {
  provider: "enphase" | "smartcar" | "tesla";
  state: ProviderState;
  system_id?: string;
  last_check?: string;
  /** Most recent solar power in W when configured, for the UI to display. */
  current_power_w?: number;
  message?: string;
};

async function enphaseStatus(): Promise<ProviderStatus> {
  const haveCreds =
    !!process.env.ENPHASE_CLIENT_ID &&
    !!process.env.ENPHASE_CLIENT_SECRET &&
    !!process.env.ENPHASE_API_KEY;
  if (!haveCreds) {
    return { provider: "enphase", state: "creds-missing" };
  }

  const tok = await getToken("enphase");
  if (!tok) {
    return { provider: "enphase", state: "not-connected" };
  }

  // Best-effort live ping — don't break the page if Enphase is flaky.
  try {
    if (tok.system_id) {
      const summary = await getSummary(tok.system_id);
      return {
        provider: "enphase",
        state: "configured",
        system_id: tok.system_id,
        last_check: new Date().toISOString(),
        current_power_w: summary.current_power,
      };
    }
    return {
      provider: "enphase",
      state: "configured",
      system_id: undefined,
      message: "Token saved but no system_id pinned.",
    };
  } catch (err) {
    return {
      provider: "enphase",
      state: "error",
      system_id: tok.system_id ?? undefined,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function GET() {
  const enphase = await enphaseStatus();
  return Response.json({
    enphase,
    smartcar: { provider: "smartcar", state: "creds-missing" } as ProviderStatus,
    tesla: { provider: "tesla", state: "creds-missing" } as ProviderStatus,
  });
}

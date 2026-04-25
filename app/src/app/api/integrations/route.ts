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
import { getLiveStatus, getSiteInfo } from "@/lib/tesla";

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
  /** Domain-appropriate "what's it doing right now" summary number for the UI. */
  current_power_w?: number;
  /** Tesla-only: live PW SoC + reserve target. */
  pw_soc?: number;
  pw_reserve?: number;
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

async function teslaStatus(): Promise<ProviderStatus> {
  const haveCreds = !!process.env.TESLA_CLIENT_ID && !!process.env.TESLA_CLIENT_SECRET;
  if (!haveCreds) return { provider: "tesla", state: "creds-missing" };

  const tok = await getToken("tesla");
  if (!tok) return { provider: "tesla", state: "not-connected" };

  try {
    if (tok.system_id) {
      const [live, info] = await Promise.all([
        getLiveStatus(tok.system_id),
        getSiteInfo(tok.system_id).catch(() => null),
      ]);
      return {
        provider: "tesla",
        state: "configured",
        system_id: tok.system_id,
        last_check: new Date().toISOString(),
        current_power_w: Math.round(live.battery_power ?? 0),
        pw_soc: Math.round(live.percentage_charged ?? 0),
        pw_reserve: info ? Math.round(info.backup_reserve_percent) : undefined,
      };
    }
    return {
      provider: "tesla",
      state: "configured",
      system_id: undefined,
      message: "Token saved but no energy_site_id pinned.",
    };
  } catch (err) {
    return {
      provider: "tesla",
      state: "error",
      system_id: tok.system_id ?? undefined,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function GET() {
  const [enphase, tesla] = await Promise.all([enphaseStatus(), teslaStatus()]);
  return Response.json({
    enphase,
    tesla,
    smartcar: { provider: "smartcar", state: "creds-missing" } as ProviderStatus,
  });
}

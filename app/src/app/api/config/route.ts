// Policy config. GET returns the full ConfigResponse, POST applies a
// partial update (Zod-validated). The cron tick reads via getConfig()
// so changes here take effect on the next 5-min cycle.

import { bustCache } from "@/lib/cache";
import { getConfig, setConfig } from "@/lib/db";
import { configUpdateSchema } from "@/lib/schemas";

export async function GET() {
  return Response.json(await getConfig());
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = configUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const updated = await setConfig(parsed.data);

  // assembleStatus() stamps `nem_export_rate` (and computes derived
  // cost fields against it) from the live config. The cached status
  // payload otherwise serves the old rate for up to TTL after a save
  // — a "did it save?" UX failure on the CostCard. Bust both status
  // keys so the next read fetches fresh numbers immediately. See
  // app/src/lib/cache.ts for the contract.
  bustCache("status:full");
  bustCache("status:engine");

  return Response.json(updated);
}

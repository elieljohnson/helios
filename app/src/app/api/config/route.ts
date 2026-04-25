// Policy config. GET returns the full ConfigResponse, POST applies a
// partial update (Zod-validated). The cron tick reads via getConfig()
// so changes here take effect on the next 5-min cycle.

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
  return Response.json(updated);
}

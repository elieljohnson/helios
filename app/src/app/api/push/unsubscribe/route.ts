// POST /api/push/unsubscribe
//
// Body: { endpoint: string }. Removes the row keyed by that endpoint.
// Idempotent — deleting a non-existent endpoint returns ok:true.

import { eq } from "drizzle-orm";

import { pushSubscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { endpoint } = body as { endpoint?: string };
  if (!endpoint) {
    return Response.json({ error: "missing endpoint" }, { status: 400 });
  }

  const db = getDb();
  if (!db) {
    return Response.json({ error: "db unavailable" }, { status: 503 });
  }

  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return Response.json({ ok: true });
}

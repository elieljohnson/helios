import { DEFAULT_CONFIG } from "@/lib/config";

// Stub: returns the default policy. Swap to read from the user_config row
// once Postgres is wired.
export async function GET() {
  return Response.json(DEFAULT_CONFIG);
}

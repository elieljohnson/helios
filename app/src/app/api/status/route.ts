import { assembleStatus } from "@/lib/status";

// Composed snapshot. Starts from the validated mock; every connected
// provider (Enphase today, Tesla + Smartcar later) overlays its fields.
// `sources` tells the UI which fields are live vs. mocked.
export async function GET() {
  return Response.json(await assembleStatus());
}

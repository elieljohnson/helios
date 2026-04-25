import { mockStatus } from "@/lib/mock";

// Temporary: returns the mocked "optimized" scenario. Swap to a provider
// adapter (Enphase + Tesla + Rivian) once OAuth flows are wired.
export async function GET() {
  return Response.json(mockStatus());
}

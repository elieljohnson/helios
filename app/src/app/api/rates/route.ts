import { mockRates } from "@/lib/mock";

export async function GET() {
  return Response.json(mockRates());
}

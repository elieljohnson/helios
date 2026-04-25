import { mockForecast } from "@/lib/mock";

export async function GET() {
  return Response.json(mockForecast());
}

// 7-day + 24-hour forecast. Backed by Open-Meteo (free, keyless).
// Falls back to mockForecast() if the upstream is unreachable so the UI
// never breaks on transient network errors.

import { mockForecast } from "@/lib/mock";
import { fetchForecast } from "@/lib/weather";

export async function GET() {
  try {
    return Response.json(await fetchForecast());
  } catch (err) {
    console.error("[forecast] Open-Meteo failed, serving mock:", err);
    return Response.json(mockForecast());
  }
}

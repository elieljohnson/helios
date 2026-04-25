// Stub: historical energy snapshots. Will return time-bucketed rows from
// the snapshots table once the cron + Postgres are wired.
export async function GET() {
  return Response.json({ series: [] });
}

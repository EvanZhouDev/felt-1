import { loadTraceGraph } from "../../trace-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await loadTraceGraph(), {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: "Trace graph unavailable.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 404 },
    );
  }
}

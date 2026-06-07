import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const tracePath = join(
    repoRoot(),
    ".agent",
    "traces",
    "volta-run-traces.json",
  );

  try {
    const body = await readFile(tracePath, "utf8");
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json(
      {
        error: "Trace snapshot not found.",
        expectedPath: tracePath,
      },
      { status: 404 },
    );
  }
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/apps/web") ? resolve(cwd, "../..") : cwd;
}

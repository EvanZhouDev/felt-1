import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TraceExplorer } from "./TraceExplorer";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <TraceExplorer initialGraph={await loadTraceGraph()} />;
}

async function loadTraceGraph() {
  const tracePath = join(
    repoRoot(),
    ".agent",
    "traces",
    "volta-run-traces.json",
  );
  const body = await readFile(tracePath, "utf8");
  return JSON.parse(body);
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/apps/web") ? resolve(cwd, "../..") : cwd;
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentWorkspace } from "./types.ts";

export async function createAgentWorkspace(args: {
  runsRoot: string;
  runId: string;
  iteration: number;
  agentId: string;
}): Promise<AgentWorkspace> {
  const iterationId = String(args.iteration).padStart(3, "0");
  const rootPath = join(
    args.runsRoot,
    args.runId,
    "iterations",
    iterationId,
    "agents",
    args.agentId,
  );
  const cwd = join(rootPath, "workspace");
  const outputPath = join(rootPath, "output");
  const logsPath = join(rootPath, "logs");

  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(outputPath, { recursive: true }),
    mkdir(logsPath, { recursive: true }),
  ]);

  return {
    rootPath,
    cwd,
    outputPath,
    logsPath,
  };
}

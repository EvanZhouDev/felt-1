import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type OracleMode = "mock" | "tribe" | "http";

export type OrchestratorConfig = {
  port: number;
  databasePath: string;
  runsRoot: string;
  oracleMode: OracleMode;
  pythonPath: string;
  repoRoot: string;
  tribeUrl: string;
  fluxUrl: string;
  candidateCount: number;
  maxIterations: number;
  candidateModel?: string;
  judgeModel?: string;
};

export function loadConfig(): OrchestratorConfig {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return {
    port: Number(process.env.VOLTA_PORT ?? 8787),
    databasePath:
      process.env.VOLTA_DATABASE_PATH ?? join(repoRoot, "data/volta.sqlite"),
    runsRoot: process.env.VOLTA_RUNS_ROOT ?? join(repoRoot, ".volta/runs"),
    oracleMode:
      process.env.VOLTA_ORACLE === "tribe" ||
      process.env.VOLTA_ORACLE === "http"
        ? process.env.VOLTA_ORACLE
        : "mock",
    pythonPath:
      process.env.VOLTA_PYTHON ??
      join(repoRoot, "vendor/tribev2/.venv/bin/python"),
    repoRoot,
    tribeUrl: process.env.VOLTA_TRIBE_URL ?? "https://tribe.bryanhu.com",
    fluxUrl: process.env.VOLTA_FLUX_URL ?? "https://images.bryanhu.com",
    candidateCount: Math.max(1, Number(process.env.VOLTA_CANDIDATE_COUNT ?? 2)),
    maxIterations: Math.max(1, Number(process.env.VOLTA_MAX_ITERATIONS ?? 1)),
    candidateModel: process.env.VOLTA_CANDIDATE_MODEL,
    judgeModel: process.env.VOLTA_JUDGE_MODEL,
  };
}

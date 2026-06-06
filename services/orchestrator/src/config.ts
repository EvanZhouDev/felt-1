import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type OrchestratorConfig = {
  port: number;
  databasePath: string;
  oracleMode: "mock" | "tribe";
  pythonPath: string;
  repoRoot: string;
};

export function loadConfig(): OrchestratorConfig {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return {
    port: Number(process.env.VOLTA_PORT ?? 8787),
    databasePath:
      process.env.VOLTA_DATABASE_PATH ?? join(repoRoot, "data/volta.sqlite"),
    oracleMode: process.env.VOLTA_ORACLE === "tribe" ? "tribe" : "mock",
    pythonPath:
      process.env.VOLTA_PYTHON ??
      join(repoRoot, "vendor/tribev2/.venv/bin/python"),
    repoRoot,
  };
}

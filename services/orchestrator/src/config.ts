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
  audioUrl: string;
  describeAudio: boolean;
  // 0 = perception-faithful scoring (default); 1 = score affective/association
  // networks and suppress primary sensory cortex ("feels like" over
  // "looks/sounds like"). Sharpens cross-target specificity.
  vibeWeight: number;
  // Blend weight for battery-contrastive scoring (0 disables; see
  // contrastiveNeuralSimilarity). Needs anchors-battery.json.
  contrastWeight: number;
  candidateModel?: string;
  judgeModel?: string;
  agentBackend: AgentBackendConfig;
  loop: LoopConfig;
  weave: WeaveConfig;
};

export type SingleBackendConfig =
  | {
      mode: "codex";
      command: string;
      model?: string;
      profile?: string;
      timeoutMs: number;
    }
  | {
      mode: "claude";
      command: string;
      model?: string;
      timeoutMs: number;
    }
  | {
      mode: "deepseek";
      model?: string;
      baseUrl?: string;
      timeoutMs: number;
    };

// Priority list: first entry is primary; later entries take over when the
// primary throws a usage/rate-cap error (VOLTA_AGENT_BACKEND="codex,claude").
export type AgentBackendConfig = {
  chain: SingleBackendConfig[];
};

export type LoopConfig = {
  maxIterations: number;
  similarityThreshold: number;
  candidateCount: number;
  scoringConcurrency: number;
};

export type WeaveConfig = {
  enabled: boolean;
  project?: string;
  capturePayloads: boolean;
};

export function loadConfig(): OrchestratorConfig {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return {
    port: Number(process.env.VOLTA_PORT ?? 8787),
    databasePath:
      process.env.VOLTA_DATABASE_PATH ?? join(repoRoot, "data/volta.sqlite"),
    runsRoot: process.env.VOLTA_RUNS_ROOT ?? join(repoRoot, ".volta/runs"),
    oracleMode: loadOracleMode(),
    pythonPath:
      process.env.VOLTA_PYTHON ??
      join(repoRoot, "vendor/tribev2/.venv/bin/python"),
    repoRoot,
    tribeUrl: process.env.VOLTA_TRIBE_URL ?? "https://tribe.bryanhu.com",
    fluxUrl: process.env.VOLTA_FLUX_URL ?? "https://images.bryanhu.com",
    audioUrl: process.env.VOLTA_AUDIO_URL ?? "https://audio.bryanhu.com",
    describeAudio: process.env.VOLTA_DESCRIBE_AUDIO !== "false",
    vibeWeight: numberFromEnv("VOLTA_VIBE_WEIGHT", 0),
    contrastWeight: numberFromEnv("VOLTA_CONTRAST_WEIGHT", 0),
    candidateModel: process.env.VOLTA_CANDIDATE_MODEL,
    judgeModel: process.env.VOLTA_JUDGE_MODEL,
    agentBackend: loadAgentBackendConfig(),
    loop: normalizeLoopConfig({
      maxIterations: numberFromEnv("VOLTA_MAX_ITERATIONS", 1),
      similarityThreshold: numberFromEnv("VOLTA_SIMILARITY_THRESHOLD", 0.9),
      candidateCount: numberFromEnv("VOLTA_CANDIDATE_COUNT", 2),
      scoringConcurrency: numberFromEnv("VOLTA_SCORING_CONCURRENCY", 1),
    }),
    weave: {
      enabled: process.env.VOLTA_WEAVE_ENABLED === "true",
      project: process.env.VOLTA_WEAVE_PROJECT,
      capturePayloads: process.env.VOLTA_WEAVE_CAPTURE_PAYLOADS === "true",
    },
  };
}

export function normalizeLoopConfig(
  config: Partial<LoopConfig> | undefined,
): LoopConfig {
  return {
    maxIterations: positiveInteger(config?.maxIterations, 1),
    similarityThreshold: finiteNumber(config?.similarityThreshold, 0.9),
    candidateCount: positiveInteger(config?.candidateCount, 2),
    scoringConcurrency: positiveInteger(config?.scoringConcurrency, 1),
  };
}

function loadOracleMode(): OracleMode {
  if (process.env.VOLTA_ORACLE === "tribe") {
    return "tribe";
  }
  if (process.env.VOLTA_ORACLE === "http") {
    return "http";
  }
  return "mock";
}

function loadAgentBackendConfig(): AgentBackendConfig {
  const spec = process.env.VOLTA_AGENT_BACKEND ?? "codex";
  const chain = spec
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean)
    .map((mode): SingleBackendConfig => {
      if (mode === "claude") {
        return {
          mode: "claude",
          command: process.env.VOLTA_CLAUDE_COMMAND ?? "claude",
          model: process.env.VOLTA_CLAUDE_MODEL,
          timeoutMs: numberFromEnv("VOLTA_CLAUDE_TIMEOUT_MS", 600_000),
        };
      }
      if (mode === "deepseek") {
        return {
          mode: "deepseek",
          model: process.env.VOLTA_DEEPSEEK_MODEL,
          baseUrl: process.env.VOLTA_DEEPSEEK_URL,
          timeoutMs: numberFromEnv("VOLTA_DEEPSEEK_TIMEOUT_MS", 300_000),
        };
      }
      if (mode !== "codex") {
        throw new Error(
          `Unknown agent backend '${mode}' in VOLTA_AGENT_BACKEND.`,
        );
      }
      return {
        mode: "codex",
        command: process.env.VOLTA_CODEX_COMMAND ?? "codex",
        model: process.env.VOLTA_CODEX_MODEL,
        profile: process.env.VOLTA_CODEX_PROFILE,
        timeoutMs: numberFromEnv("VOLTA_CODEX_TIMEOUT_MS", 900_000),
      };
    });
  if (chain.length === 0) {
    throw new Error("VOLTA_AGENT_BACKEND resolved to an empty backend chain.");
  }
  return { chain };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return finiteNumber(Number(value), fallback);
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function finiteNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

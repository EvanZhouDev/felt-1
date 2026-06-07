import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type AgentBackend,
  CodexCliBackend,
  DeterministicAgentBackend,
} from "@volta/agent-sdk";
import type { ImagePayload, InputObj, OutputObj } from "@volta/core";
import {
  type AgentBackendConfig,
  loadConfig,
  normalizeLoopConfig,
  type OracleMode,
} from "./config.ts";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

type BenchmarkScenario = {
  id: string;
  description: string;
  input: InputObj;
  output: OutputObj;
  tags: string[];
  skipReason?: (args: { oracleMode: OracleMode }) => string | undefined;
};

type BenchmarkResult = {
  scenarioId: string;
  runId?: string;
  status: "completed" | "failed" | "skipped";
  description: string;
  tags: string[];
  outputType: OutputObj["outputType"];
  runPath?: string;
  bestScore?: number;
  bestNeuralSimilarity?: number;
  bestAdjustedSimilarity?: number;
  iterationCount?: number;
  selectedAgentId?: string;
  error?: string;
};

const args = parseArgs(process.argv.slice(2));
const baseConfig = loadConfig();
const runsRoot = args.runsRoot
  ? resolve(args.runsRoot)
  : join(baseConfig.repoRoot, ".volta/benchmarks/runs");
const databasePath = args.databasePath
  ? resolve(args.databasePath)
  : join(baseConfig.repoRoot, ".volta/benchmarks/volta.sqlite");
const oracleMode = args.oracle ?? baseConfig.oracleMode;
const loop = normalizeLoopConfig({
  ...baseConfig.loop,
  maxIterations: args.maxIterations ?? baseConfig.loop.maxIterations,
  candidateCount: args.candidateCount ?? baseConfig.loop.candidateCount,
  scoringConcurrency:
    args.scoringConcurrency ?? baseConfig.loop.scoringConcurrency,
  reuseTargetArchive: args.reuseTargetArchive ?? false,
  textMicroMutations:
    args.textMicroMutations ?? baseConfig.loop.textMicroMutations,
  textProbeCount: args.textProbeCount ?? baseConfig.loop.textProbeCount,
  textProbeRecombinations:
    args.textProbeRecombinations ?? baseConfig.loop.textProbeRecombinations,
  textProbeLocalMutations:
    args.textProbeLocalMutations ?? baseConfig.loop.textProbeLocalMutations,
  contrastTargetRoots:
    args.contrastTargetRoots ?? baseConfig.loop.contrastTargetRoots,
});
const backendConfig = args.backend
  ? backendConfigFromMode(args.backend, baseConfig.agentBackend)
  : baseConfig.agentBackend;
const config = {
  ...baseConfig,
  databasePath,
  runsRoot,
  oracleMode,
  agentBackend: backendConfig,
  loop,
};
const selectedScenarioIds = new Set(args.scenarios ?? defaultScenarioIds());
const scenarios = buildScenarios().filter((scenario) =>
  selectedScenarioIds.has(scenario.id),
);
if (scenarios.length === 0) {
  throw new Error(
    `No benchmark scenarios selected. Available: ${buildScenarios()
      .map((scenario) => scenario.id)
      .join(", ")}`,
  );
}

const store = new RunStore(config.databasePath);
const oracle = createOracle(config);
const backend = createAgentBackend(config.agentBackend);
const createdAt = new Date().toISOString();
const results: BenchmarkResult[] = [];

try {
  for (const scenario of scenarios) {
    const skipReason = scenario.skipReason?.({ oracleMode });
    if (skipReason) {
      results.push({
        scenarioId: scenario.id,
        status: "skipped",
        description: scenario.description,
        tags: scenario.tags,
        outputType: scenario.output.outputType,
        error: skipReason,
      });
      continue;
    }

    const runId = `${scenario.id}-${randomUUID().slice(0, 8)}`;
    const runPath = join(config.runsRoot, runId);
    const record = store.create({
      id: runId,
      input: scenario.input,
      output: scenario.output,
      runPath,
    });

    try {
      await executeRun({
        id: record.id,
        input: scenario.input,
        output: scenario.output,
        store,
        oracle,
        runsRoot: config.runsRoot,
        backend,
        loop,
        candidateModel: config.candidateModel,
        judgeModel: config.judgeModel,
      });
      const artifact = store.getArtifact(record.id);
      const result = artifact?.result as BenchmarkRunResult | undefined;
      results.push({
        scenarioId: scenario.id,
        runId,
        status: "completed",
        description: scenario.description,
        tags: scenario.tags,
        outputType: scenario.output.outputType,
        runPath,
        bestScore: result?.bestScore,
        bestNeuralSimilarity: result?.bestNeuralSimilarity,
        bestAdjustedSimilarity: result?.bestAdjustedSimilarity,
        iterationCount: result?.iterations.length,
        selectedAgentId: result?.judge.selectedAgentId,
      });
    } catch (error) {
      results.push({
        scenarioId: scenario.id,
        runId,
        status: "failed",
        description: scenario.description,
        tags: scenario.tags,
        outputType: scenario.output.outputType,
        runPath,
        error: String(error),
      });
    }
  }
} finally {
  await oracle.shutdown?.();
}

const report = {
  createdAt,
  updatedAt: new Date().toISOString(),
  oracleMode,
  backend: backendConfig.mode,
  loop,
  runsRoot: config.runsRoot,
  databasePath: config.databasePath,
  results,
};
const outPath = args.out
  ? resolve(args.out)
  : join(
      baseConfig.repoRoot,
      ".agent/benchmarks",
      `${createdAt.replaceAll(/[:.]/g, "-")}-cold-benchmark.json`,
    );
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...report, outPath }, null, 2));

function buildScenarios(): BenchmarkScenario[] {
  const monaImage =
    process.env.VOLTA_MONA_LISA_IMAGE ??
    "/Users/evan/Desktop/project-volta/mona-lisa.jpg";
  const monaVideo =
    process.env.VOLTA_MONA_LISA_VIDEO ??
    "/Users/evan/Desktop/project-volta/.volta/demo-assets/mona-lisa-fast-0.5s.mp4";
  const hasMonaImage = existsSync(monaImage);
  const hasMonaVideo = existsSync(monaVideo);
  const monaSkipReason = ({ oracleMode }: { oracleMode: OracleMode }) => {
    if (!hasMonaImage) {
      return `Missing Mona Lisa image: ${monaImage}`;
    }
    if (oracleMode !== "mock" && !hasMonaVideo) {
      return `Missing Mona Lisa cached video for non-mock oracle: ${monaVideo}`;
    }
    return undefined;
  };
  const monaPayload: ImagePayload = {
    type: "image",
    source: {
      uri: monaImage,
      mime: "image/jpeg",
    },
    ...(hasMonaVideo
      ? {
          cachedVideo: {
            uri: monaVideo,
            mime: "video/mp4",
          },
        }
      : {}),
    timing: {
      durationSec: 0.5,
      fps: 2,
    },
    fit: "contain",
    background: "#000000",
  };
  const monaInput: InputObj = {
    inputNode: {
      type: "image",
      payload: monaPayload,
    },
  };
  const backroomsImage =
    process.env.VOLTA_BACKROOMS_IMAGE ??
    "/Users/evan/Desktop/project-volta/backrooms.jpeg";
  const backroomsVideo =
    process.env.VOLTA_BACKROOMS_VIDEO ??
    "/Users/evan/Desktop/project-volta/.volta/demo-assets/backrooms-0.5s.mp4";
  const hasBackroomsImage = existsSync(backroomsImage);
  const hasBackroomsVideo = existsSync(backroomsVideo);
  const backroomsSkipReason = ({ oracleMode }: { oracleMode: OracleMode }) => {
    if (!hasBackroomsImage) {
      return `Missing backrooms image: ${backroomsImage}`;
    }
    if (oracleMode !== "mock" && !hasBackroomsVideo) {
      return `Missing backrooms cached video for non-mock oracle: ${backroomsVideo}`;
    }
    return undefined;
  };
  const backroomsPayload: ImagePayload = {
    type: "image",
    source: {
      uri: backroomsImage,
      mime: "image/jpeg",
    },
    ...(hasBackroomsVideo
      ? {
          cachedVideo: {
            uri: backroomsVideo,
            mime: "video/mp4",
          },
        }
      : {}),
    timing: {
      durationSec: 0.5,
      fps: 2,
    },
    fit: "contain",
    background: "#000000",
  };
  const dogImage =
    process.env.VOLTA_DOG_IMAGE ?? "/Users/evan/Desktop/project-volta/dog.jpg";
  const dogVideo =
    process.env.VOLTA_DOG_VIDEO ??
    "/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-0.5s.mp4";
  const hasDogImage = existsSync(dogImage);
  const hasDogVideo = existsSync(dogVideo);
  const dogSkipReason = ({ oracleMode }: { oracleMode: OracleMode }) => {
    if (!hasDogImage) {
      return `Missing dog image: ${dogImage}`;
    }
    if (oracleMode !== "mock" && !hasDogVideo) {
      return `Missing dog cached video for non-mock oracle: ${dogVideo}`;
    }
    return undefined;
  };
  const dogPayload: ImagePayload = {
    type: "image",
    source: {
      uri: dogImage,
      mime: "image/jpeg",
    },
    ...(hasDogVideo
      ? {
          cachedVideo: {
            uri: dogVideo,
            mime: "video/mp4",
          },
        }
      : {}),
    timing: {
      durationSec: 0.5,
      fps: 2,
    },
    fit: "contain",
    background: "#000000",
  };

  return [
    {
      id: "seeded-text-to-text-dog",
      description:
        "Transfer a terse cold text target into dog-topic prose without copying the target topic.",
      input: {
        inputNode: {
          type: "text",
          payload: {
            type: "text",
            text: "A terse paragraph with cold urgency and clipped rhythm.",
          },
        },
        seed: {
          prompt:
            "Write about a dog while preserving the target's emotional pressure, pace, and perceptual feel. Do not copy the target topic or phrasing.",
        },
      },
      output: {
        outputType: "text",
      },
      tags: ["text", "seeded", "topic-transfer", "cold-start"],
    },
    {
      id: "mona-image-to-text",
      description:
        "Use the Mona Lisa image target as an image-to-text cold benchmark.",
      input: monaInput,
      output: {
        outputType: "text",
      },
      tags: ["image", "text", "mona-lisa", "cold-start"],
      skipReason: monaSkipReason,
    },
    {
      id: "backrooms-image-to-text",
      description:
        "Use the backrooms image target as a second image-to-text cold benchmark.",
      input: {
        inputNode: {
          type: "image",
          payload: backroomsPayload,
        },
      },
      output: {
        outputType: "text",
      },
      tags: ["image", "text", "backrooms", "cold-start"],
      skipReason: backroomsSkipReason,
    },
    {
      id: "dog-image-to-text",
      description:
        "Use the dog image target as an image-to-text cold benchmark.",
      input: {
        inputNode: {
          type: "image",
          payload: dogPayload,
        },
      },
      output: {
        outputType: "text",
      },
      tags: ["image", "text", "dog", "cold-start"],
      skipReason: dogSkipReason,
    },
    {
      id: "mona-image-to-image",
      description:
        "Use the Mona Lisa image target as an image-to-image schema benchmark.",
      input: {
        ...monaInput,
        seed: {
          prompt:
            "Create a different image subject that preserves the target's quiet, close, mysterious perceptual feel without copying the painting.",
        },
      },
      output: {
        outputType: "image",
      },
      tags: ["image", "mona-lisa", "seeded", "cold-start"],
      skipReason: monaSkipReason,
    },
  ];
}

function defaultScenarioIds(): string[] {
  return [
    "seeded-text-to-text-dog",
    "mona-image-to-text",
    "backrooms-image-to-text",
    "dog-image-to-text",
    "mona-image-to-image",
  ];
}

function createAgentBackend(config: AgentBackendConfig): AgentBackend {
  if (config.mode === "deterministic") {
    return new DeterministicAgentBackend();
  }
  return new CodexCliBackend({
    command: config.command,
    model: config.model,
    profile: config.profile,
    timeoutMs: config.timeoutMs,
  });
}

function backendConfigFromMode(
  mode: "codex" | "deterministic",
  fallback: AgentBackendConfig,
): AgentBackendConfig {
  if (mode === "deterministic") {
    return { mode };
  }
  if (fallback.mode === "codex") {
    return fallback;
  }
  return {
    mode,
    command: process.env.VOLTA_CODEX_COMMAND ?? "codex",
    model: process.env.VOLTA_CODEX_MODEL,
    profile: process.env.VOLTA_CODEX_PROFILE,
    timeoutMs: Number(process.env.VOLTA_CODEX_TIMEOUT_MS ?? 900_000),
  };
}

type BenchmarkRunResult = {
  bestScore?: number;
  bestNeuralSimilarity?: number;
  bestAdjustedSimilarity?: number;
  iterations: unknown[];
  judge: {
    selectedAgentId: string;
  };
};

function parseArgs(argv: string[]): {
  scenarios?: string[];
  out?: string;
  oracle?: OracleMode;
  backend?: "codex" | "deterministic";
  maxIterations?: number;
  candidateCount?: number;
  scoringConcurrency?: number;
  textMicroMutations?: number;
  textProbeCount?: number;
  textProbeRecombinations?: number;
  textProbeLocalMutations?: number;
  contrastTargetRoots?: string[];
  reuseTargetArchive?: boolean;
  runsRoot?: string;
  databasePath?: string;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--reuse-target-archive") {
      parsed.reuseTargetArchive = true;
      continue;
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (flag === "--scenario") {
      parsed.scenarios = [...(parsed.scenarios ?? []), value];
      index += 1;
    } else if (flag === "--scenarios") {
      parsed.scenarios = value.split(",").map((item) => item.trim());
      index += 1;
    } else if (flag === "--out") {
      parsed.out = value;
      index += 1;
    } else if (flag === "--oracle") {
      if (!["mock", "tribe", "http"].includes(value)) {
        throw new Error(`Invalid oracle mode: ${value}`);
      }
      parsed.oracle = value as OracleMode;
      index += 1;
    } else if (flag === "--backend") {
      if (!["codex", "deterministic"].includes(value)) {
        throw new Error(`Invalid backend: ${value}`);
      }
      parsed.backend = value as "codex" | "deterministic";
      index += 1;
    } else if (flag === "--max-iterations") {
      parsed.maxIterations = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--candidate-count") {
      parsed.candidateCount = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--scoring-concurrency") {
      parsed.scoringConcurrency = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--text-micro-mutations") {
      parsed.textMicroMutations = nonNegativeInteger(value, flag);
      index += 1;
    } else if (flag === "--text-probe-count") {
      parsed.textProbeCount = nonNegativeInteger(value, flag);
      index += 1;
    } else if (flag === "--text-probe-recombinations") {
      parsed.textProbeRecombinations = nonNegativeInteger(value, flag);
      index += 1;
    } else if (flag === "--text-probe-local-mutations") {
      parsed.textProbeLocalMutations = nonNegativeInteger(value, flag);
      index += 1;
    } else if (flag === "--contrast-target-root") {
      parsed.contrastTargetRoots = [
        ...(parsed.contrastTargetRoots ?? []),
        resolve(value),
      ];
      index += 1;
    } else if (flag === "--runs-root") {
      parsed.runsRoot = value;
      index += 1;
    } else if (flag === "--database-path") {
      parsed.databasePath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function nonNegativeInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return number;
}

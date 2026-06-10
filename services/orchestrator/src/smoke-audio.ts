import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InputObj, OutputNode, OutputObj } from "@volta/core";
import { loadAnchors, loadNetworkWeights } from "./anchors.ts";
import { createAgentBackend } from "./backend.ts";
import type { OrchestratorConfig } from "./config.ts";
import { createAudioDescriber } from "./describer.ts";
import { createImageGenerator } from "./imagegen.ts";
import { loadAudioNode } from "./loaders.ts";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

// End-to-end audio-input smoke. The loop is medium-agnostic — this drives the
// same executeRun as the text smoke, only the input Node differs. Output medium
// is a free parameter (VOLTA_SMOKE_OUTPUT, default text).
//
// Defaults to the MOCK oracle + describer OFF for a fast, offline run. Set
// VOLTA_ORACLE=http and VOLTA_DESCRIBE_AUDIO=true for a real audio run.

const repoRoot = resolve(import.meta.dir, "../../..");
const audioSource =
  process.env.VOLTA_SMOKE_AUDIO ??
  join(repoRoot, "services/orchestrator/fixtures/tone.wav");
const outputType = (process.env.VOLTA_SMOKE_OUTPUT ??
  "text") as OutputNode["type"];
const oracleMode =
  process.env.VOLTA_ORACLE === "http"
    ? "http"
    : process.env.VOLTA_ORACLE === "tribe"
      ? "tribe"
      : "mock";

const smokeRoot = await mkdtemp(join(tmpdir(), "volta-audio-smoke-"));
const store = new RunStore(join(smokeRoot, "volta.sqlite"));

const config: OrchestratorConfig = {
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot: join(smokeRoot, "runs"),
  oracleMode,
  pythonPath:
    process.env.VOLTA_PYTHON ??
    join(repoRoot, "vendor/tribev2/.venv/bin/python"),
  repoRoot,
  tribeUrl: process.env.VOLTA_TRIBE_URL ?? "https://tribe.bryanhu.com",
  fluxUrl: process.env.VOLTA_FLUX_URL ?? "https://images.bryanhu.com",
  audioUrl: process.env.VOLTA_AUDIO_URL ?? "https://qwen.bryanhu.com",
  describeAudio: process.env.VOLTA_DESCRIBE_AUDIO === "true",
  vibeWeight: Number(process.env.VOLTA_VIBE_WEIGHT ?? 0),
  agentBackend: {
    chain: [
      {
        mode: "codex" as const,
        command: process.env.VOLTA_CODEX_COMMAND ?? "codex",
        timeoutMs: 900_000,
      },
    ],
  },
  loop: {
    maxIterations: 1,
    similarityThreshold: 2,
    candidateCount: 2,
    scoringConcurrency: 1,
  },
  weave: {
    enabled: false,
    capturePayloads: false,
  },
};

const oracle = createOracle(config);
const backend = createAgentBackend(config.agentBackend);
const describeAudio = createAudioDescriber(config);

const input: InputObj = {
  inputNode: await loadAudioNode(audioSource),
  seed: {
    prompt: "Generate output that carries the vibe of this audio.",
  },
};

const output: OutputObj = {
  outputType,
};

const run = store.create({
  id: "smoke-audio-run",
  input,
  output,
  runPath: join(smokeRoot, "runs", "smoke-audio-run"),
});

await executeRun({
  id: run.id,
  input,
  output,
  store,
  oracle,
  backend,
  runsRoot: join(smokeRoot, "runs"),
  describeAudio,
  generateImage: createImageGenerator(config),
  anchors: loadAnchors(config.repoRoot),
  vertexWeights: loadNetworkWeights(config.repoRoot, config.vibeWeight),
  loop: {
    maxIterations: 1,
    similarityThreshold: 2,
    candidateCount: 2,
  },
});

const completed = store.get(run.id);
if (!completed) {
  throw new Error("Audio smoke run was not persisted.");
}
if (completed.status !== "completed") {
  throw new Error(`Audio smoke run did not complete: ${completed.status}`);
}
if (completed.inputNodeType !== "audio") {
  throw new Error(`Expected audio input, got ${completed.inputNodeType}.`);
}
if (!completed.selectedAgentId || completed.bestScore === null) {
  throw new Error("Audio smoke run did not update SQLite summary columns.");
}

const artifact = store.getArtifact(run.id);
if (!artifact?.result) {
  throw new Error("Audio smoke run has no result artifact.");
}
const result = artifact.result as SmokeResult;
if (result.candidates.length !== 2) {
  throw new Error(
    `Expected 2 candidates, received ${result.candidates.length}.`,
  );
}
if (result.candidates[0]?.outputNode.type !== outputType) {
  throw new Error(
    `Expected ${outputType} candidates, got ${result.candidates[0]?.outputNode.type}.`,
  );
}

await assertExists(join(smokeRoot, "runs", run.id, "target.json"));
await assertExists(join(smokeRoot, "runs", run.id, "input.json"));
await assertExists(join(smokeRoot, "runs", run.id, "evolution-journal.json"));

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: run.id,
      oracleMode,
      inputNodeType: completed.inputNodeType,
      outputType,
      describeAudio: Boolean(describeAudio),
      audioSource,
      selectedAgentId: result.judge.selectedAgentId,
      candidateCount: result.candidates.length,
      bestNeuralSimilarity: result.bestNeuralSimilarity,
      hasDescription: Boolean(result.target?.description),
      smokeRoot,
    },
    null,
    2,
  ),
);

type SmokeResult = {
  candidates: Array<{
    agentId: string;
    outputNode: OutputNode;
  }>;
  judge: {
    selectedAgentId: string;
  };
  bestNeuralSimilarity?: number;
  target?: {
    description?: unknown;
  };
};

async function assertExists(path: string): Promise<void> {
  await stat(path);
}

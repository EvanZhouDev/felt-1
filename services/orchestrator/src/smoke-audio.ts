import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentBackend,
  CodexCliBackend,
  DeterministicAgentBackend,
} from "@volta/agent-sdk";
import type { InputObj, OutputNode, OutputObj } from "@volta/core";
import {
  type AgentBackendConfig,
  loadConfig,
  type OrchestratorConfig,
} from "./config.ts";
import { createAudioDescriber } from "./describer.ts";
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

const base = loadConfig();
const smokeRoot = await mkdtemp(join(tmpdir(), "volta-audio-smoke-"));
const config: OrchestratorConfig = {
  ...base,
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot: join(smokeRoot, "runs"),
  // Mock unless an oracle is explicitly requested; describe off by default for
  // a fast offline smoke (set VOLTA_DESCRIBE_AUDIO=true to exercise it).
  oracleMode:
    process.env.VOLTA_ORACLE === "http"
      ? "http"
      : process.env.VOLTA_ORACLE === "tribe"
        ? "tribe"
        : "mock",
  describeAudio: process.env.VOLTA_DESCRIBE_AUDIO === "true",
  loop: { ...base.loop, maxIterations: 1, similarityThreshold: 2 },
};

const store = new RunStore(config.databasePath);
const oracle = createOracle(config);
const backend = createBackend(config.agentBackend);
const describeAudio = createAudioDescriber(config);

const input: InputObj = {
  inputNode: await loadAudioNode(audioSource),
  seed: {
    prompt: "Generate output that carries the vibe of this audio.",
  },
};
const output: OutputObj = { outputType };

const run = store.create({
  id: "smoke-audio-run",
  input,
  output,
  runPath: join(config.runsRoot, "smoke-audio-run"),
});

await executeRun({
  id: run.id,
  input,
  output,
  store,
  oracle,
  backend,
  runsRoot: config.runsRoot,
  describeAudio,
  loop: config.loop,
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

const artifact = store.getArtifact(run.id);
if (!artifact?.result) {
  throw new Error("Audio smoke run has no result artifact.");
}
const result = artifact.result as SmokeResult;
if (result.candidates[0]?.outputNode.type !== outputType) {
  throw new Error(
    `Expected ${outputType} candidates, got ${result.candidates[0]?.outputNode.type}.`,
  );
}

await assertExists(join(config.runsRoot, run.id, "target.json"));
await assertExists(join(config.runsRoot, run.id, "input.json"));

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: run.id,
      oracleMode: config.oracleMode,
      inputNodeType: completed.inputNodeType,
      outputType,
      describeAudio: Boolean(describeAudio),
      audioSource,
      candidateCount: result.candidates.length,
      bestNeuralSimilarity: result.bestNeuralSimilarity,
      hasDescription: Boolean(result.target?.description),
      smokeRoot,
    },
    null,
    2,
  ),
);

function createBackend(cfg: AgentBackendConfig): AgentBackend {
  if (cfg.mode === "deterministic") {
    return new DeterministicAgentBackend();
  }
  return new CodexCliBackend({
    command: cfg.command,
    model: cfg.model,
    profile: cfg.profile,
    timeoutMs: cfg.timeoutMs,
  });
}

type SmokeResult = {
  candidates: Array<{ agentId: string; outputNode: OutputNode }>;
  bestNeuralSimilarity?: number;
  target?: { description?: unknown };
};

async function assertExists(path: string): Promise<void> {
  await stat(path);
}

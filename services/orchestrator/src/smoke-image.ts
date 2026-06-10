import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexCliBackend } from "@volta/agent-sdk";
import type { InputObj, OutputNode, OutputObj } from "@volta/core";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { loadImageNode } from "./loaders.ts";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

// End-to-end image-input smoke. The loop is medium-agnostic — this drives the
// same executeRun as the text/audio smokes, only the input Node differs. Output
// medium is a free parameter (VOLTA_SMOKE_OUTPUT, default text).
//
// Defaults to the MOCK oracle for a fast, offline run. Set VOLTA_ORACLE=http for
// a real run scored by hosted TRIBE (the image is sent to /predict/image).
// Point at any image with VOLTA_SMOKE_IMAGE=<path|url>.

const repoRoot = resolve(import.meta.dir, "../../..");
const imageSource =
  process.env.VOLTA_SMOKE_IMAGE ??
  join(repoRoot, "services/orchestrator/fixtures/swatch.png");
const outputType = (process.env.VOLTA_SMOKE_OUTPUT ??
  "text") as OutputNode["type"];
const oracleMode =
  process.env.VOLTA_ORACLE === "http"
    ? "http"
    : process.env.VOLTA_ORACLE === "tribe"
      ? "tribe"
      : "mock";

const smokeRoot = await mkdtemp(join(tmpdir(), "volta-image-smoke-"));
const store = new RunStore(join(smokeRoot, "volta.sqlite"));

// Defer backend / loop depth / Weave to the env-driven config so the same knobs
// the service honors (VOLTA_AGENT_BACKEND, VOLTA_MAX_ITERATIONS,
// VOLTA_CANDIDATE_COUNT, VOLTA_WEAVE_*) drive this smoke too. Override only the
// smoke-specific bits: ephemeral paths, mock-default oracle, and no audio
// describe (image input has nothing to describe).
const base = loadConfig();
const config: OrchestratorConfig = {
  ...base,
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot: join(smokeRoot, "runs"),
  oracleMode,
  describeAudio: false,
};

const oracle = createOracle(config);
const backend = new CodexCliBackend({
  command: config.agentBackend.command,
  model: config.agentBackend.model,
  profile: config.agentBackend.profile,
  timeoutMs: config.agentBackend.timeoutMs,
});

const input: InputObj = {
  inputNode: await loadImageNode(imageSource),
  seed: {
    prompt: "Generate output that carries the vibe of this image.",
  },
};

const output: OutputObj = {
  outputType,
};

const run = store.create({
  id: "smoke-image-run",
  input,
  output,
  runPath: join(smokeRoot, "runs", "smoke-image-run"),
});

await executeRun({
  id: run.id,
  input,
  output,
  store,
  oracle,
  backend,
  runsRoot: join(smokeRoot, "runs"),
  loop: config.loop,
});

const completed = store.get(run.id);
if (!completed) {
  throw new Error("Image smoke run was not persisted.");
}
if (completed.status !== "completed") {
  throw new Error(`Image smoke run did not complete: ${completed.status}`);
}
if (completed.inputNodeType !== "image") {
  throw new Error(`Expected image input, got ${completed.inputNodeType}.`);
}
if (!completed.selectedAgentId || completed.bestScore === null) {
  throw new Error("Image smoke run did not update SQLite summary columns.");
}

const artifact = store.getArtifact(run.id);
if (!artifact?.result) {
  throw new Error("Image smoke run has no result artifact.");
}
const result = artifact.result as SmokeResult;
// The reigning best-so-far is re-ranked with the fresh candidates from
// iteration 2 onward, so the final ranking holds candidateCount fresh
// candidates plus (when one exists) the carried-forward best.
const { candidateCount } = config.loop;
if (
  result.candidates.length !== candidateCount &&
  result.candidates.length !== candidateCount + 1
) {
  throw new Error(
    `Expected ${candidateCount} or ${candidateCount + 1} candidates, received ${result.candidates.length}.`,
  );
}
if (result.candidates[0]?.outputNode.type !== outputType) {
  throw new Error(
    `Expected ${outputType} candidates, got ${result.candidates[0]?.outputNode.type}.`,
  );
}

await assertExists(join(smokeRoot, "runs", run.id, "target.json"));
await assertExists(join(smokeRoot, "runs", run.id, "input.json"));
const journalPath = join(smokeRoot, "runs", run.id, "evolution-journal.json");
await assertExists(journalPath);

// Pull the best-similarity-per-iteration curve straight from the journal so the
// run prints the search trajectory (what you'd plot) without re-reading files.
const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
  scoreCurve?: Array<{ iteration: number; bestNeuralSimilarity: number }>;
};
const curve = (journal.scoreCurve ?? []).map((it) => ({
  iteration: it.iteration,
  bestNeuralSimilarity: it.bestNeuralSimilarity,
}));

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: run.id,
      oracleMode,
      backend: config.agentBackend.mode,
      maxIterations: config.loop.maxIterations,
      candidateCount: config.loop.candidateCount,
      weaveEnabled: config.weave.enabled,
      inputNodeType: completed.inputNodeType,
      outputType,
      imageSource,
      selectedAgentId: result.judge.selectedAgentId,
      bestNeuralSimilarity: result.bestNeuralSimilarity,
      similarityCurve: curve,
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
};

async function assertExists(path: string): Promise<void> {
  await stat(path);
}

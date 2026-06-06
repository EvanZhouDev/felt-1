import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputObj, OutputObj } from "@volta/core";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

const smokeRoot = await mkdtemp(join(tmpdir(), "volta-agent-smoke-"));
const store = new RunStore(join(smokeRoot, "volta.sqlite"));
const oracle = createOracle({
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot: join(smokeRoot, "runs"),
  oracleMode: "mock",
  pythonPath: "python3",
  repoRoot: process.cwd(),
});

const input: InputObj = {
  inputNode: {
    type: "text",
    payload: {
      type: "text",
      text: "A calm, precise interface that feels focused and deliberate.",
    },
  },
  seed: {
    prompt: "Generate concise product copy for a local creative tool.",
  },
};

const output: OutputObj = {
  outputType: "text",
};

const run = store.create({
  id: "smoke-run",
  input,
  output,
  runPath: join(smokeRoot, "runs", "smoke-run"),
});

await executeRun({
  id: run.id,
  input,
  output,
  store,
  oracle,
  runsRoot: join(smokeRoot, "runs"),
});

const completed = store.get(run.id);
if (!completed) {
  throw new Error("Smoke run was not persisted.");
}
if (completed.status !== "completed") {
  throw new Error(`Smoke run did not complete: ${completed.status}`);
}
if (!completed.selectedAgentId || completed.bestScore === null) {
  throw new Error("Smoke run did not update SQLite summary columns.");
}
const artifact = store.getArtifact(run.id);
if (!artifact?.result) {
  throw new Error("Smoke run has no result artifact.");
}

const result = artifact.result as SmokeResult;
if (result.candidates.length !== 2) {
  throw new Error(
    `Expected 2 candidates, received ${result.candidates.length}.`,
  );
}
if (result.judge.selectedAgentId !== result.candidates[0]?.agentId) {
  throw new Error("Judge did not select the top ranked candidate.");
}

await assertExists(
  join(
    smokeRoot,
    "runs",
    run.id,
    "iterations",
    "001",
    "agents",
    "candidate-a",
    "workspace",
  ),
);
await assertExists(
  join(
    smokeRoot,
    "runs",
    run.id,
    "iterations",
    "001",
    "agents",
    "candidate-b",
    "workspace",
  ),
);
await assertExists(
  join(
    smokeRoot,
    "runs",
    run.id,
    "iterations",
    "001",
    "agents",
    "judge",
    "workspace",
  ),
);
await assertExists(join(smokeRoot, "runs", run.id, "input.json"));
await assertExists(join(smokeRoot, "runs", run.id, "output-request.json"));
await assertExists(join(smokeRoot, "runs", run.id, "run.json"));
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "target.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "candidates.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "scores.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "judge.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "next-seed.json"),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: run.id,
      selectedAgentId: result.judge.selectedAgentId,
      candidateCount: result.candidates.length,
      smokeRoot,
    },
    null,
    2,
  ),
);

type SmokeResult = {
  candidates: Array<{
    agentId: string;
  }>;
  judge: {
    selectedAgentId: string;
  };
};

async function assertExists(path: string): Promise<void> {
  await stat(path);
}

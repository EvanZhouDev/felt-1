import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputObj, OutputObj } from "@volta/core";
import { createAgentBackend } from "./backend.ts";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";
import { executeRun, resumeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

await assertTextTiming();

const smokeRoot = await mkdtemp(join(tmpdir(), "volta-agent-smoke-"));
const store = new RunStore(join(smokeRoot, "volta.sqlite"));
const oracle = createOracle({
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot: join(smokeRoot, "runs"),
  oracleMode: "mock",
  pythonPath: "python3",
  repoRoot: process.cwd(),
  tribeUrl: "https://tribe.bryanhu.com",
  fluxUrl: "https://images.bryanhu.com",
  audioUrl: "https://qwen.bryanhu.com",
  describeAudio: false,
  vibeWeight: 0,
  agentBackend: {
    chain: [
      {
        mode: "codex",
        command: process.env.VOLTA_CODEX_COMMAND ?? "codex",
        timeoutMs: 900_000,
      },
    ],
  },
  loop: {
    maxIterations: 2,
    similarityThreshold: 2,
    candidateCount: 2,
    scoringConcurrency: 1,
  },
  weave: {
    enabled: false,
    capturePayloads: false,
  },
});

const backend = createAgentBackend(loadConfig().agentBackend);

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
  backend,
  runsRoot: join(smokeRoot, "runs"),
  loop: {
    maxIterations: 1,
    similarityThreshold: 2,
    candidateCount: 2,
  },
});

await resumeRun({
  id: run.id,
  store,
  oracle,
  backend,
  runsRoot: join(smokeRoot, "runs"),
  loop: {
    maxIterations: 1,
    similarityThreshold: 2,
    candidateCount: 2,
  },
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
if (result.stopReason !== "max_iterations") {
  throw new Error(`Expected max_iterations, received ${result.stopReason}.`);
}
if (result.iterations.length !== 2) {
  throw new Error(
    `Expected 2 iterations, received ${result.iterations.length}.`,
  );
}
// From iteration 2 on, the reigning best-so-far is re-ranked with the fresh
// candidates, so the final ranking holds candidateCount fresh candidates plus
// (when one exists) the carried-forward best.
if (result.candidates.length !== 2 && result.candidates.length !== 3) {
  throw new Error(
    `Expected 2 or 3 candidates, received ${result.candidates.length}.`,
  );
}
if (
  !result.candidates.some(
    (candidate) => candidate.agentId === result.judge.selectedAgentId,
  )
) {
  throw new Error("Judge selected an agent outside the ranked candidates.");
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
await assertExists(join(smokeRoot, "runs", run.id, "target.json"));
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
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "001", "iteration.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "target.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "candidates.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "scores.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "judge.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "next-seed.json"),
);
await assertExists(
  join(smokeRoot, "runs", run.id, "iterations", "002", "iteration.json"),
);
await assertExists(join(smokeRoot, "runs", run.id, "evolution-journal.json"));

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: run.id,
      selectedAgentId: result.judge.selectedAgentId,
      candidateCount: result.candidates.length,
      iterationCount: result.iterations.length,
      stopReason: result.stopReason,
      smokeRoot,
    },
    null,
    2,
  ),
);

type SmokeResult = {
  stopReason: string;
  iterations: unknown[];
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

async function assertTextTiming(): Promise<void> {
  const rendered = await renderPayload({
    type: "text",
    text: "one two three",
  });
  const textEvent = rendered.encoderInput.events.find(
    (event) => event.type === "Text",
  );
  const wordEvents = rendered.encoderInput.events.filter(
    (event) => event.type === "Word",
  );
  if (!textEvent || !closeTo(textEvent.duration, 1.05)) {
    throw new Error(
      `Expected 3-word text duration to be 1.05s, received ${textEvent?.duration}.`,
    );
  }
  for (const event of wordEvents) {
    if (!closeTo(event.duration, 0.35)) {
      throw new Error(
        `Expected word duration 0.35s, received ${event.duration}.`,
      );
    }
  }
}

function closeTo(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputObj, OutputObj } from "@volta/core";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

type Scenario = {
  id: string;
  input: InputObj;
  output: OutputObj;
};

const smokeRoot = await mkdtemp(join(tmpdir(), "volta-generic-smoke-"));
const runsRoot = join(smokeRoot, "runs");
const store = new RunStore(join(smokeRoot, "volta.sqlite"));
const oracle = createOracle({
  port: 0,
  databasePath: join(smokeRoot, "volta.sqlite"),
  runsRoot,
  oracleMode: "mock",
  pythonPath: "python3",
  repoRoot: process.cwd(),
  tribeUrl: "https://tribe.bryanhu.com",
  fluxUrl: "https://images.bryanhu.com",
  agentBackend: {
    mode: "deterministic",
  },
  loop: {
    maxIterations: 1,
    similarityThreshold: 2,
    candidateCount: 3,
    scoringConcurrency: 1,
    reuseTargetArchive: false,
  },
  weave: {
    enabled: false,
    capturePayloads: false,
  },
});

const scenarios: Scenario[] = [
  {
    id: "text-to-text",
    input: {
      inputNode: {
        type: "text",
        payload: {
          type: "text",
          text: "A terse paragraph with cold urgency and clipped rhythm.",
        },
      },
    },
    output: {
      outputType: "text",
    },
  },
  {
    id: "text-to-image",
    input: {
      inputNode: {
        type: "text",
        payload: {
          type: "text",
          text: "A bright, playful melody that feels round, quick, and weightless.",
        },
      },
    },
    output: {
      outputType: "image",
    },
  },
  {
    id: "image-to-code",
    input: {
      inputNode: {
        type: "image",
        payload: {
          type: "image",
          source: {
            uri: "asset://generic-smoke/source-image.png",
            mime: "image/png",
          },
          timing: {
            durationSec: 0.5,
          },
        },
      },
    },
    output: {
      outputType: "code",
    },
  },
];

for (const scenario of scenarios) {
  const record = store.create({
    id: scenario.id,
    input: scenario.input,
    output: scenario.output,
    runPath: join(runsRoot, scenario.id),
  });

  await executeRun({
    id: record.id,
    input: scenario.input,
    output: scenario.output,
    store,
    oracle,
    runsRoot,
    loop: {
      maxIterations: 1,
      similarityThreshold: 2,
      candidateCount: 3,
    },
  });

  const completed = store.get(record.id);
  if (completed?.status !== "completed") {
    throw new Error(
      `${scenario.id} did not complete: ${completed?.status ?? "missing"}.`,
    );
  }
  const artifact = store.getArtifact(record.id);
  const result = artifact?.result as GenericSmokeResult | undefined;
  if (result?.iterations.length !== 1) {
    throw new Error(`${scenario.id} did not produce one iteration.`);
  }
  if (result.candidates.length !== 3) {
    throw new Error(`${scenario.id} did not produce three candidates.`);
  }
  const candidate = result.candidates[0];
  if (
    !candidate?.entropy?.includes(`outputType=${scenario.output.outputType}`)
  ) {
    throw new Error(`${scenario.id} candidate entropy is not medium-aware.`);
  }

  await assertExists(join(runsRoot, scenario.id, "candidate-archive.json"));
  await assertExists(join(runsRoot, scenario.id, "evolution-journal.json"));
}

console.log(
  JSON.stringify(
    {
      ok: true,
      scenarioCount: scenarios.length,
      scenarios: scenarios.map((scenario) => scenario.id),
      smokeRoot,
    },
    null,
    2,
  ),
);

type GenericSmokeResult = {
  iterations: unknown[];
  candidates: Array<{
    entropy?: string;
  }>;
};

async function assertExists(path: string): Promise<void> {
  await stat(path);
}

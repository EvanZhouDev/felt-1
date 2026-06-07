import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexCliBackend } from "@volta/agent-sdk";
import type { InputObj, OutputNode, OutputObj } from "@volta/core";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { loadImageNode } from "./loaders.ts";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

// Dedicated, verbose Starry-Night experiment runner. Pins a known runs root
// (.agent/runs/<label>) so per-iteration artifacts can be inspected and tailed,
// and prints a compact per-iteration summary line by reading scores.json as the
// loop writes them. Knobs come from the same VOLTA_* env the service honors.

const repoRoot = resolve(import.meta.dir, "../../..");
const label = process.env.VOLTA_RUN_LABEL ?? "starry";
const imageSource =
  process.env.VOLTA_SMOKE_IMAGE ?? join(repoRoot, "starrynight.jpg");
const outputType = (process.env.VOLTA_SMOKE_OUTPUT ??
  "text") as OutputNode["type"];

const runsRoot = join(repoRoot, ".agent", "runs", label);
const runId = label;
await mkdir(runsRoot, { recursive: true });

const base = loadConfig();
const config: OrchestratorConfig = {
  ...base,
  port: 0,
  databasePath: join(runsRoot, "volta.sqlite"),
  runsRoot,
  oracleMode: base.oracleMode,
  describeAudio: false,
};

const store = new RunStore(config.databasePath);
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
    prompt:
      "Generate text that carries the perceptual vibe of this image: its motion, emotional temperature, light, and atmosphere.",
  },
};
const output: OutputObj = { outputType };

const run = store.create({
  id: runId,
  input,
  output,
  runPath: join(runsRoot, runId),
});

console.log(
  `[starry] start label=${label} oracle=${config.oracleMode} backend=${config.agentBackend.mode} ` +
    `iters=${config.loop.maxIterations} candidates=${config.loop.candidateCount} ` +
    `threshold=${config.loop.similarityThreshold}`,
);
console.log(`[starry] runsRoot=${runsRoot}`);

// Tail per-iteration scores.json as the loop writes them, printing a summary.
let lastReported = -1;
const ticker = setInterval(() => {
  void reportNewIterations();
}, 4000);
ticker.unref?.();

async function reportNewIterations(): Promise<void> {
  // Iterations are written to iterations/NNN/ (1-based, zero-padded to 3). Read
  // the compact iteration.json (scores, no activation values) plus judge.json
  // and candidates.json for the winning text — never the 43MB scores.json.
  for (let i = lastReported + 1; i < config.loop.maxIterations; i += 1) {
    const dir = join(
      runsRoot,
      runId,
      "iterations",
      String(i + 1).padStart(3, "0"),
    );
    const iter = await readJsonSafe<IterationArtifact>(
      join(dir, "iteration.json"),
    );
    if (!iter) {
      return; // iteration i not finished yet; stop scanning forward
    }
    const ranked = [...(iter.rankings ?? [])].sort(
      (a, b) => b.score.neuralSimilarity - a.score.neuralSimilarity,
    );
    const best = ranked[0];
    const line = ranked
      .map(
        (r) =>
          `${r.agentId}=${r.score.neuralSimilarity.toFixed(4)}` +
          (r.entropy ? `(${shortOp(r.entropy)})` : ""),
      )
      .join("  ");
    console.log(
      `[starry] iter ${i}: best=${best?.score.neuralSimilarity.toFixed(4)} via ${iter.judge?.selectedAgentId} | ${line}`,
    );
    const selected = iter.judge?.selectedNode?.payload?.text;
    if (selected) {
      console.log(`[starry]   selected text: ${selected.slice(0, 260)}`);
    }
    lastReported = i;
  }
}

function shortOp(entropy: string): string {
  return entropy.split(/[:-]/)[0]?.slice(0, 8) ?? entropy.slice(0, 8);
}

async function readJsonSafe<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

type RankedOutput = {
  agentId: string;
  entropy?: string;
  score: { neuralSimilarity: number; total: number };
};

type IterationArtifact = {
  rankings?: RankedOutput[];
  judge?: {
    selectedAgentId?: string;
    selectedNode?: { payload?: { text?: string } };
  };
};

try {
  await executeRun({
    id: run.id,
    input,
    output,
    store,
    oracle,
    backend,
    runsRoot,
    loop: config.loop,
  });
} finally {
  clearInterval(ticker);
  await reportNewIterations();
  await oracle.shutdown?.();
}

const journalPath = join(runsRoot, runId, "evolution-journal.json");
const journal = await readJsonSafe<{
  operatorFitness?: {
    perIteration?: Array<{ iteration: number; bestNeuralSimilarity: number }>;
  };
}>(journalPath);
const curve = (journal?.operatorFitness?.perIteration ?? []).map(
  (it) => `${it.iteration}:${it.bestNeuralSimilarity.toFixed(4)}`,
);
const completed = store.get(run.id);
console.log(
  `[starry] DONE status=${completed?.status} best=${completed?.bestScore} ` +
    `selected=${completed?.selectedAgentId}`,
);
console.log(`[starry] curve ${curve.join(" -> ")}`);
console.log(`[starry] artifacts under ${join(runsRoot, runId)}`);

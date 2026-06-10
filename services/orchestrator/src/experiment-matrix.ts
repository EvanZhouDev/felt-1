// Experiment harness: full real-TRIBE vibe-transfer runs over a target set,
// then a cross-score specificity matrix (the issue-#6 diagonal test).
//
// Usage:
//   bun .agent/experiments/matrix/run-matrix.ts <exp-name> <targets.json> [--skip-runs]
//
// targets.json: [{ "id": "clair", "kind": "audio"|"image", "source": "<path|url>" }]
// Env knobs: EXP_ITERATIONS (default 5), EXP_CANDIDATES (default 2),
//            EXP_CONCURRENCY (targets in parallel, default 1)
//
// Artifacts land in .agent/experiments/matrix/<exp-name>/:
//   runs/<target-id>/...        normal run artifacts (trajectory, scores, judge)
//   winners.json                best text + score curve per target (incremental)
//   matrix.json, report.md      cross-score matrix + diagonal verdict
// Target activations cache in .agent/experiments/matrix/target-cache/ shared
// across experiments, so iterating on the system re-uses target encodes.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ActivationTrace,
  type InputObj,
  neuralTrajectorySimilarity,
  type OutputNode,
  type OutputObj,
  pooledActivationSimilarity,
} from "@volta/core";
import { loadAnchors } from "./anchors.ts";
import { createAgentBackend } from "./backend.ts";
import { loadConfig, type OrchestratorConfig } from "./config.ts";
import { createAudioDescriber } from "./describer.ts";
import { createImageGenerator } from "./imagegen.ts";
import { loadAudioNode, loadImageNode } from "./loaders.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

type TargetSpec = {
  id: string;
  kind: "audio" | "image";
  source: string;
  // Output medium for the run (default text). "image" exercises the Flux path.
  output?: "text" | "image";
};

const expName = process.argv[2];
const targetsPath = process.argv[3];
const skipRuns = process.argv.includes("--skip-runs");
if (!expName || !targetsPath) {
  console.error(
    "usage: bun run exp:matrix -- <exp-name> <targets.json> [--skip-runs]",
  );
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, "../../..");
const matrixRoot = join(repoRoot, ".agent/experiments/matrix");
const expRoot = join(matrixRoot, expName);
const runsRoot = join(expRoot, "runs"); // target-cache lands at expRoot/target-cache
const sharedCacheNote =
  "(per-exp cache; copy from a sibling exp to reuse encodes)";
const targets = JSON.parse(readFileSync(targetsPath, "utf8")) as TargetSpec[];
const iterations = Number(process.env.EXP_ITERATIONS ?? 5);
const candidates = Number(process.env.EXP_CANDIDATES ?? 2);
const concurrency = Number(process.env.EXP_CONCURRENCY ?? 1);

const base = loadConfig();
const config: OrchestratorConfig = {
  ...base,
  oracleMode: "http",
  describeAudio: true,
  loop: {
    maxIterations: iterations,
    similarityThreshold: 2, // never stop on threshold; let stall/cap decide
    candidateCount: candidates,
    scoringConcurrency: 1,
  },
};

const oracle = createOracle(config);
const describer = createAudioDescriber(config);
const generateImage = createImageGenerator(config);
const anchors = loadAnchors(config.repoRoot);
const backend = createAgentBackend(config.agentBackend);

await mkdir(runsRoot, { recursive: true });
log(
  `exp=${expName} targets=${targets.map((t) => t.id).join(",")} M=${iterations} N=${candidates} concurrency=${concurrency} ${sharedCacheNote}`,
);

type Winner = {
  id: string;
  kind: string;
  ok: boolean;
  error?: string;
  bestNeuralSimilarity?: number;
  stopReason?: string;
  curve?: Array<{ iteration: number; best: number }>;
  // Best-scoring output node across all iterations (full payload — text body
  // or materialized image source + generation prompt).
  node?: OutputNode;
  preview?: string;
  durationS?: number;
};

const winners: Winner[] = [];

if (!skipRuns) {
  await mapWithConcurrency(targets, concurrency, async (target) => {
    // Completed runs on disk are reused so a partially-failed experiment can
    // be relaunched without repeating its finished targets.
    const existing = loadWinnerFromDisk(target);
    if (existing?.stopReason) {
      winners.push(existing);
      log(
        `[${target.id}] reusing completed run from disk (best=${existing.bestNeuralSimilarity?.toFixed(4)})`,
      );
      await writeJson(join(expRoot, "winners.json"), winners);
      return;
    }
    const started = Date.now();
    log(`[${target.id}] run starting (${target.kind})`);
    try {
      const winner = await runTarget(target);
      winner.durationS = Math.round((Date.now() - started) / 1000);
      winners.push(winner);
      log(
        `[${target.id}] DONE best=${winner.bestNeuralSimilarity?.toFixed(4)} stop=${winner.stopReason} ${winner.durationS}s curve=${(winner.curve ?? []).map((c) => c.best.toFixed(3)).join("→")}`,
      );
    } catch (error) {
      winners.push({
        id: target.id,
        kind: target.kind,
        ok: false,
        error: String(error),
      });
      log(`[${target.id}] FAILED: ${error}`);
    }
    await writeJson(join(expRoot, "winners.json"), winners);
  });
} else {
  for (const target of targets) {
    const fromDisk = loadWinnerFromDisk(target);
    if (fromDisk) {
      winners.push(fromDisk);
    }
  }
  log(`skip-runs: loaded ${winners.length} winners from disk`);
}

await writeJson(join(expRoot, "winners.json"), winners);

// ---- cross-score phase ----------------------------------------------------
log("cross-score phase: encoding winner texts and scoring against all targets");

const targetActivations = new Map<string, ActivationTrace>();
for (const target of targets) {
  const targetJson = join(runsRoot, runId(target), "target.json");
  if (!existsSync(targetJson)) {
    log(`[matrix] missing target.json for ${target.id}; skipping`);
    continue;
  }
  const parsed = JSON.parse(readFileSync(targetJson, "utf8")) as {
    activation: ActivationTrace;
  };
  targetActivations.set(target.id, parsed.activation);
}

type MatrixCell = { full: number; pooled: number | undefined };
const matrix: Record<string, Record<string, MatrixCell>> = {};

for (const winner of winners) {
  if (!winner.ok || !winner.node) {
    continue;
  }
  const rendered = await renderPayload(winner.node.payload);
  const activation = await oracle.encode(rendered.encoderInput);
  // Persist for offline metric experiments (values included — the run
  // artifacts drop them, which made every metric question cost oracle calls).
  await writeJson(join(expRoot, "activations", `winner-${winner.id}.json`), {
    id: winner.id,
    preview: winner.preview,
    activation,
  });
  matrix[winner.id] = {};
  for (const [targetId, targetActivation] of targetActivations) {
    matrix[winner.id][targetId] = {
      full: neuralTrajectorySimilarity(targetActivation, activation),
      pooled: pooledActivationSimilarity(targetActivation, activation),
    };
  }
  log(
    `[matrix] ${winner.id}-text vs targets: ${[...targetActivations.keys()]
      .map((t) => `${t}=${matrix[winner.id][t].full.toFixed(4)}`)
      .join(" ")}`,
  );
}

// Diagonal verdict: for each TARGET (column), does its own text win the column?
const ids = winners.filter((w) => w.ok && matrix[w.id]).map((w) => w.id);
let diagonalWins = 0;
const verdicts: string[] = [];
for (const targetId of ids) {
  const column = ids
    .map((textId) => ({ textId, sim: matrix[textId]?.[targetId]?.full ?? 0 }))
    .sort((a, b) => b.sim - a.sim);
  const won = column[0]?.textId === targetId;
  if (won) diagonalWins += 1;
  const margin =
    column.length > 1 ? (column[0]?.sim ?? 0) - (column[1]?.sim ?? 0) : 0;
  verdicts.push(
    `target=${targetId}: winner=${column[0]?.textId} ${won ? "✓" : "✗"} margin=${margin.toFixed(4)}`,
  );
}

const report = [
  `# ${expName} — cross-score matrix`,
  "",
  `M=${iterations} N=${candidates} | diagonal wins: ${diagonalWins}/${ids.length}`,
  "",
  "## Run results",
  ...winners.map((w) =>
    w.ok
      ? `- ${w.id}: best=${w.bestNeuralSimilarity?.toFixed(4)} stop=${w.stopReason} ${w.durationS}s curve=${(w.curve ?? []).map((c) => c.best.toFixed(3)).join(" → ")}`
      : `- ${w.id}: FAILED ${w.error}`,
  ),
  "",
  "## Matrix (rows = winning text, cols = target, full-blend similarity)",
  "",
  `| text \\ target | ${ids.join(" | ")} |`,
  `|---|${ids.map(() => "---").join("|")}|`,
  ...ids.map(
    (textId) =>
      `| ${textId} | ${ids
        .map((t) => {
          const cell = matrix[textId]?.[t];
          const mark = textId === t ? "**" : "";
          return cell ? `${mark}${cell.full.toFixed(4)}${mark}` : "—";
        })
        .join(" | ")} |`,
  ),
  "",
  "## Diagonal verdicts (does each target's own text win its column?)",
  ...verdicts.map((v) => `- ${v}`),
  "",
].join("\n");

await writeFile(join(expRoot, "report.md"), report, "utf8");
await writeJson(join(expRoot, "matrix.json"), { matrix, diagonalWins, ids });
log(`report written: ${join(expRoot, "report.md")}`);
log(`RESULT diagonal=${diagonalWins}/${ids.length}`);
if (typeof oracle.shutdown === "function") {
  await oracle.shutdown();
}
process.exit(0);

// ---------------------------------------------------------------------------

async function runTarget(target: TargetSpec): Promise<Winner> {
  const id = runId(target);
  // Fresh attempt: clear any partial state from a previously failed run of
  // this target (same run id → sqlite UNIQUE violation; stale iteration
  // artifacts would pollute winner extraction).
  // Remove the WAL/SHM siblings too: a stale WAL from a killed process makes
  // a fresh database throw "SQLiteError: disk I/O error" on first write.
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(expRoot, `${target.id}.sqlite${suffix}`), { force: true });
  }
  rmSync(join(runsRoot, id), { recursive: true, force: true });
  const store = new RunStore(join(expRoot, `${target.id}.sqlite`));
  const inputNode =
    target.kind === "audio"
      ? await loadAudioNode(target.source)
      : await loadImageNode(target.source);
  const input: InputObj = {
    inputNode,
    seed: { prompt: "Generate output that carries the vibe of this input." },
  };
  const output: OutputObj = { outputType: target.output ?? "text" };
  store.create({ id, input, output, runPath: join(runsRoot, id) });

  await executeRun({
    id,
    input,
    output,
    store,
    oracle,
    backend,
    runsRoot,
    loop: config.loop,
    describeAudio: target.kind === "audio" ? describer : undefined,
    generateImage,
    anchors,
  });

  const record = store.get(id);
  if (record?.status !== "completed") {
    throw new Error(`run status=${record?.status}`);
  }
  const winner = loadWinnerFromDisk(target);
  if (!winner) {
    throw new Error("completed run has no readable artifacts");
  }
  return winner;
}

function loadWinnerFromDisk(target: TargetSpec): Winner | undefined {
  const journalPath = join(runsRoot, runId(target), "evolution-journal.json");
  if (!existsSync(journalPath)) {
    return undefined;
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    bestNeuralSimilarity?: number;
    stopReason?: string;
    scoreCurve?: Array<{ iteration: number; bestNeuralSimilarity: number }>;
  };
  // Best output node across all iterations by neural similarity. The journal
  // truncates payloads, so read the per-iteration scores.json (full nodes).
  let bestNode: OutputNode | undefined;
  let bestSim = Number.NEGATIVE_INFINITY;
  const iterationsDir = join(runsRoot, runId(target), "iterations");
  if (existsSync(iterationsDir)) {
    for (const entry of readdirSync(iterationsDir)) {
      const scoresPath = join(iterationsDir, entry, "scores.json");
      if (!existsSync(scoresPath)) {
        continue;
      }
      const ranked = JSON.parse(readFileSync(scoresPath, "utf8")) as Array<{
        score: { neuralSimilarity: number };
        outputNode?: OutputNode;
      }>;
      for (const output of ranked) {
        if (output.outputNode && output.score.neuralSimilarity > bestSim) {
          bestSim = output.score.neuralSimilarity;
          bestNode = output.outputNode;
        }
      }
    }
  }
  return {
    id: target.id,
    kind: target.kind,
    ok: true,
    bestNeuralSimilarity: journal.bestNeuralSimilarity,
    stopReason: journal.stopReason,
    curve: (journal.scoreCurve ?? []).map((c) => ({
      iteration: c.iteration,
      best: c.bestNeuralSimilarity,
    })),
    node: bestNode,
    preview: nodePreview(bestNode),
  };
}

function nodePreview(node: OutputNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "text") {
    return node.payload.text;
  }
  if (node.type === "image") {
    return node.payload.prompt ?? node.payload.source.uri;
  }
  return node.type;
}

function runId(target: TargetSpec): string {
  return `${expName}-${target.id}`;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

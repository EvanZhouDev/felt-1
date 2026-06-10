// Metric diagnostic: is the similarity function able to SEPARATE distinct
// inputs at all? Loads cached target activations (target.json files) and builds
// the target×target similarity matrix under several metric variants — no TRIBE
// calls. If three emotionally-opposite pieces are ~0.9 alike under the
// production metric, the bottleneck is the metric (common-mode / affine remap),
// not the search.
//
// Usage: bun metric-probe.ts <label=path/to/target.json> [<label=path> ...]
//
// Each metric reports the off-diagonal mean (how collinear distinct inputs
// look — LOWER is better, the inputs ARE different) and the worst off-diagonal
// pair. A metric that separates the inputs has a low, spread off-diagonal.

import { readFileSync } from "node:fs";
import type { ActivationTrace } from "@volta/core";
import { neuralTrajectorySimilarity } from "@volta/core";

type Target = { label: string; trace: ActivationTrace; pooled: number[] };

const specs = process.argv.slice(2).map((arg) => {
  const eq = arg.indexOf("=");
  if (eq < 0) {
    throw new Error(`expected label=path, got ${arg}`);
  }
  return { label: arg.slice(0, eq), path: arg.slice(eq + 1) };
});
if (specs.length < 2) {
  console.error(
    "usage: bun metric-probe.ts <label=target.json> <label=target.json> ...",
  );
  process.exit(1);
}

const targets: Target[] = specs.map(({ label, path }) => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    activation: ActivationTrace;
  };
  const trace = parsed.activation;
  return { label, trace, pooled: meanFrame(trace.values ?? []) };
});

const labels = targets.map((t) => t.label);

// The common mode: the mean pooled activation across all inputs — the part
// that is identical for "this is music" / "this is fluent language", carrying
// no piece-specific signal. Removing it is the central hypothesis.
const commonMode = meanVectors(targets.map((t) => t.pooled));

// Per-vertex std across inputs, for z-whitening and discriminative selection.
const vertexStd = perVertexStd(
  targets.map((t) => t.pooled),
  commonMode,
);
const discriminativeIdx = topKByStd(vertexStd, 2000);

type Metric = { name: string; fn: (a: Target, b: Target) => number };

const metrics: Metric[] = [
  {
    name: "production (full blend, +1/2 remap)",
    fn: (a, b) => neuralTrajectorySimilarity(a.trace, b.trace),
  },
  {
    name: "pooled raw cosine (no remap)",
    fn: (a, b) => cosine(center(a.pooled), center(b.pooled)),
  },
  {
    name: "common-mode subtracted",
    fn: (a, b) => cosine(sub(a.pooled, commonMode), sub(b.pooled, commonMode)),
  },
  {
    name: "z-whitened (per-vertex)",
    fn: (a, b) =>
      cosine(
        whiten(a.pooled, commonMode, vertexStd),
        whiten(b.pooled, commonMode, vertexStd),
      ),
  },
  {
    name: "top-2000 discriminative vertices",
    fn: (a, b) =>
      cosine(
        pick(sub(a.pooled, commonMode), discriminativeIdx),
        pick(sub(b.pooled, commonMode), discriminativeIdx),
      ),
  },
];

for (const metric of metrics) {
  const matrix = targets.map((a) => targets.map((b) => metric.fn(a, b)));
  const off = offDiagonal(matrix);
  console.log(`\n=== ${metric.name} ===`);
  console.log(`    ${labels.map((l) => l.padStart(9)).join("")}`);
  matrix.forEach((row, i) => {
    console.log(
      `${labels[i].padEnd(4)}${row.map((v) => v.toFixed(3).padStart(9)).join("")}`,
    );
  });
  console.log(
    `  off-diagonal: mean=${off.mean.toFixed(3)} max=${off.max.toFixed(3)} (${off.maxPair}) spread=${off.spread.toFixed(3)}`,
  );
}

console.log(
  "\nReading: off-diagonal mean = how alike DISTINCT pieces look. Lower is better — the pieces ARE different. A metric that cannot push these apart cannot let any generated output be piece-specific.",
);

// ---------------------------------------------------------------------------

function meanFrame(frames: number[][]): number[] {
  const width = frames[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < width; i += 1) out[i] += frame[i] ?? 0;
  }
  if (frames.length) {
    for (let i = 0; i < width; i += 1) out[i] /= frames.length;
  }
  return out;
}

function meanVectors(vectors: number[][]): number[] {
  const width = vectors[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < width; i += 1) out[i] += v[i] ?? 0;
  }
  for (let i = 0; i < width; i += 1) out[i] /= vectors.length;
  return out;
}

function perVertexStd(vectors: number[][], mean: number[]): number[] {
  const width = mean.length;
  const out = new Array<number>(width).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < width; i += 1) {
      const d = (v[i] ?? 0) - mean[i];
      out[i] += d * d;
    }
  }
  for (let i = 0; i < width; i += 1) {
    out[i] = Math.sqrt(out[i] / Math.max(vectors.length, 1));
  }
  return out;
}

function topKByStd(std: number[], k: number): number[] {
  return std
    .map((s, i) => [s, i] as [number, number])
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => i);
}

function center(v: number[]): number[] {
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);
  return v.map((x) => x - mean);
}

function sub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - (b[i] ?? 0));
}

function whiten(v: number[], mean: number[], std: number[]): number[] {
  return v.map((x, i) => (x - mean[i]) / (std[i] || 1));
}

function pick(v: number[], idx: number[]): number[] {
  return idx.map((i) => v[i] ?? 0);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function offDiagonal(matrix: number[][]): {
  mean: number;
  max: number;
  maxPair: string;
  spread: number;
} {
  const values: number[] = [];
  let max = Number.NEGATIVE_INFINITY;
  let maxPair = "";
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix.length; j += 1) {
      if (i === j) continue;
      values.push(matrix[i][j]);
      if (matrix[i][j] > max) {
        max = matrix[i][j];
        maxPair = `${labels[i]}~${labels[j]}`;
      }
    }
  }
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const spread = Math.max(...values) - Math.min(...values);
  return { mean, max, maxPair, spread };
}

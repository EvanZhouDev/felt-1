// Does common-mode subtraction actually let a MATCHING text win its target?
// The target×target probe showed distinct pieces look ~0.9 alike under the
// production metric and pull apart only after subtracting the cross-piece mean.
// That could be an n=3 artifact (any 3 points separate after centering). The
// honest test: hand-write texts that unambiguously match each piece's vibe,
// encode them once, and score text×target under each metric. A good metric puts
// each text's highest score on ITS OWN target, by a real margin.
//
// Usage: bun metric-text-probe.ts <clairTarget.json> <moonTarget.json> <dvorTarget.json>
// (audio targets, in clair/moonlight/dvorak order)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationTrace, EncoderStimulus } from "@volta/core";
import { neuralTrajectorySimilarity } from "@volta/core";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

const [clairPath, moonPath, dvorPath] = process.argv.slice(2);
if (!clairPath || !moonPath || !dvorPath) {
  console.error(
    "usage: bun metric-text-probe.ts <clair> <moon> <dvor> (target.json paths)",
  );
  process.exit(1);
}

// Hand-written probes, each maximally matched to one piece's vibe in BOTH
// content and form. These are the ceiling the search is trying to reach.
const probes: Record<string, string> = {
  calm: "Moonlight settles on still water. Nothing hurries. A held breath, a slow unfolding, the soft ache of something tender and far away. Light pools, dissolves, pools again. The world rests, dreaming, weightless and quiet.",
  storm:
    "It breaks loose. Hammering, headlong, the dark runs and will not stop — fists on the keys, a heart slammed against its cage. Up, up, then plunging. No mercy, no pause, only the chase, the fever, the falling.",
  grand:
    "It rises like a continent waking. Horns gather, the great theme climbs, vast and certain, building toward a horizon that keeps widening. Triumph on the march — open sky, open country, a people moving forward into morning.",
  build:
    "Low strings circle, asking the same dark question louder each time. Something enormous is coming. Step, step, step — the floor trembles, brass masses at the gate, and then it arrives: huge, stern, in minor, a verdict more than a victory.",
};

const targets: Record<string, ActivationTrace> = {
  clair: load(clairPath),
  moon: load(moonPath),
  dvor: load(dvorPath),
};
const targetLabels = ["clair", "moon", "dvor"];
// Which probe SHOULD win which target.
const expected: Record<string, string> = {
  clair: "calm",
  moon: "storm",
  // The 75s excerpt is the finale's dark minor-key build, not the triumphant
  // arrival — "build" is the honest match; "grand" was the original label.
  dvor: "build",
};

const config = { ...loadConfig(), oracleMode: "http" as const };
const oracle = createOracle(config);

// Probe encodes are cached on disk: a timeout on probe 3 must not re-buy
// probes 1-2 (the hosted queue is saturated while experiments run).
const cacheDir = ".agent/experiments/matrix/probe-activations";
mkdirSync(cacheDir, { recursive: true });
const probeTraces: Record<string, ActivationTrace> = {};
for (const [name, text] of Object.entries(probes)) {
  const cachePath = join(cacheDir, `${name}.json`);
  if (existsSync(cachePath)) {
    probeTraces[name] = JSON.parse(readFileSync(cachePath, "utf8"));
    console.error(`probe ${name}: cached`);
    continue;
  }
  const rendered = await renderPayload({ type: "text", text });
  probeTraces[name] = await oracle.encode(
    rendered.encoderInput as EncoderStimulus,
  );
  writeFileSync(cachePath, JSON.stringify(probeTraces[name]));
  console.error(`encoded probe ${name}`);
}

// Common mode from the TARGETS (the baseline a real run would subtract).
const targetPooled = targetLabels.map((l) =>
  meanFrame(targets[l].values ?? []),
);
const commonMode = meanVectors(targetPooled);
const vertexStd = perVertexStd(targetPooled, commonMode);
const discriminativeIdx = topKByStd(vertexStd, 2000);
// Per-modality baselines: each side loses ITS OWN modality's mean (audio mean
// from the targets, text mean from the probes) — the production-shaped
// variant, since a real run knows the candidate modality and can ship fixed
// anchor means per modality.
const probePooledAll = Object.values(probeTraces).map((t) =>
  meanFrame(t.values ?? []),
);
const textMode = meanVectors(probePooledAll);

type Metric = {
  name: string;
  fn: (probe: ActivationTrace, target: ActivationTrace) => number;
};

const metrics: Metric[] = [
  {
    name: "pooled raw cosine",
    fn: (p, t) => cosine(center(pool(p)), center(pool(t))),
  },
  {
    name: "common-mode subtracted",
    fn: (p, t) => cosine(sub(pool(p), commonMode), sub(pool(t), commonMode)),
  },
  {
    name: "z-whitened (per-vertex over targets)",
    fn: (p, t) =>
      cosine(
        whiten(pool(p), commonMode, vertexStd),
        whiten(pool(t), commonMode, vertexStd),
      ),
  },
  {
    name: "per-modality centered (audio mean / text mean)",
    fn: (p, t) => cosine(sub(pool(p), textMode), sub(pool(t), commonMode)),
  },
  {
    name: "production blend but pooled term per-modality centered",
    fn: (p, t) => {
      const full = neuralTrajectorySimilarity(t, p); // [0,1], pooled 0.4 inside
      const rawBlend = full * 2 - 1;
      const pooledRaw = cosine(center(pool(p)), center(pool(t)));
      const pooledCentered = cosine(
        sub(pool(p), textMode),
        sub(pool(t), commonMode),
      );
      return rawBlend - 0.4 * pooledRaw + 0.4 * pooledCentered;
    },
  },
  {
    name: "anchored traces + full blend (frames minus modality mean)",
    fn: (p, t) =>
      neuralTrajectorySimilarity(
        shiftTrace(t, commonMode),
        shiftTrace(p, textMode),
      ) *
        2 -
      1,
  },
  {
    name: "top-2000 discriminative vertices",
    fn: (p, t) =>
      cosine(
        pick(sub(pool(p), commonMode), discriminativeIdx),
        pick(sub(pool(t), commonMode), discriminativeIdx),
      ),
  },
];

const probeNames = Object.keys(probes);
for (const metric of metrics) {
  console.log(`\n=== ${metric.name} ===`);
  console.log(
    `            ${targetLabels.map((l) => l.padStart(9)).join("")}   winner`,
  );
  let columnWins = 0;
  // For each TARGET column, does the expected probe score highest?
  const colBest: Record<string, string> = {};
  for (const target of targetLabels) {
    let best = Number.NEGATIVE_INFINITY;
    let bestProbe = "";
    for (const probe of probeNames) {
      const s = metric.fn(probeTraces[probe], targets[target]);
      if (s > best) {
        best = s;
        bestProbe = probe;
      }
    }
    colBest[target] = bestProbe;
    if (bestProbe === expected[target]) columnWins += 1;
  }
  for (const probe of probeNames) {
    const row = targetLabels.map((t) =>
      metric.fn(probeTraces[probe], targets[t]),
    );
    const marks = targetLabels.map((t) =>
      expected[t] === probe ? "*" : colBest[t] === probe ? "<" : " ",
    );
    console.log(
      `${probe.padEnd(6)}      ${row
        .map((v, i) => `${v.toFixed(3)}${marks[i]}`.padStart(9))
        .join("")}`,
    );
  }
  console.log(
    `  column wins (matching probe tops its target): ${columnWins}/3   (* = expected match)`,
  );
}

console.log(
  "\nA metric that works puts the * on the highest value in every column → 3/3. Production-style pooled cosine is the baseline to beat.",
);
if (typeof oracle.shutdown === "function") await oracle.shutdown();
process.exit(0);

// --- helpers (shared shape with metric-probe.ts) ---------------------------
function load(path: string): ActivationTrace {
  return (
    JSON.parse(readFileSync(path, "utf8")) as { activation: ActivationTrace }
  ).activation;
}
function shiftTrace(t: ActivationTrace, mode: number[]): ActivationTrace {
  return {
    ...t,
    values: (t.values ?? []).map((frame) => sub(frame, mode)),
  };
}
function pool(t: ActivationTrace): number[] {
  return meanFrame(t.values ?? []);
}
function meanFrame(frames: number[][]): number[] {
  const w = frames[0]?.length ?? 0;
  const out = new Array<number>(w).fill(0);
  for (const f of frames) for (let i = 0; i < w; i += 1) out[i] += f[i] ?? 0;
  if (frames.length) for (let i = 0; i < w; i += 1) out[i] /= frames.length;
  return out;
}
function meanVectors(vs: number[][]): number[] {
  const w = vs[0]?.length ?? 0;
  const out = new Array<number>(w).fill(0);
  for (const v of vs) for (let i = 0; i < w; i += 1) out[i] += v[i] ?? 0;
  for (let i = 0; i < w; i += 1) out[i] /= vs.length;
  return out;
}
function perVertexStd(vs: number[][], mean: number[]): number[] {
  const w = mean.length;
  const out = new Array<number>(w).fill(0);
  for (const v of vs)
    for (let i = 0; i < w; i += 1) {
      const d = (v[i] ?? 0) - mean[i];
      out[i] += d * d;
    }
  for (let i = 0; i < w; i += 1)
    out[i] = Math.sqrt(out[i] / Math.max(vs.length, 1));
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
  const m = v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);
  return v.map((x) => x - m);
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

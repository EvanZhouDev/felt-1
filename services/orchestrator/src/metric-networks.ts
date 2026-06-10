import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ActivationTrace, anchorTrace } from "@volta/core";
import { loadAnchors } from "./anchors.ts";

// Is image→image "restyling" or "vibe transfer"? Decompose the anchored
// similarity between a generated image and a target into per-Yeo-7-network
// contributions, and re-score on the AFFECTIVE/ASSOCIATION subspace only
// (Limbic, Frontoparietal, Default Mode, Attention — dropping Visual +
// Somatomotor, the primary-sensory "what it looks like" fingerprint). If a
// restyled output's score collapses on the affective subspace, its similarity
// was mostly visual mimicry. Zero oracle calls — reads persisted activations.
//
// Usage: bun metric-networks.ts <winnerActivation.json> <targetA.json=labelA> ...

const repoRoot = resolve(import.meta.dir, "../../..");
const YEO7 = [
  "background",
  "Visual",
  "Somatomotor",
  "DorsalAttention",
  "VentralAttention",
  "Limbic",
  "Frontoparietal",
  "DefaultMode",
] as const;
// Affective / association networks — "how it feels", modality-independent.
const AFFECTIVE = new Set([3, 4, 5, 6, 7]);
// Primary sensory — "what it looks/sounds like", the style/modality fingerprint.
const SENSORY = new Set([1, 2]);

const labels = JSON.parse(
  readFileSync(join(repoRoot, ".agent/experiments/yeo7-labels.json"), "utf8"),
) as number[];

const winnerPath = process.argv[2];
const targetArgs = process.argv.slice(3);
if (!winnerPath || targetArgs.length === 0) {
  console.error(
    "usage: bun metric-networks.ts <winnerActivation.json> <label=targetActivation.json> ...",
  );
  process.exit(1);
}

const anchors = loadAnchors(repoRoot);
const videoAnchor = anchors.video;

const winner = loadActivation(winnerPath);
const winnerPooled = pooled(anchorTrace(winner, videoAnchor));

for (const arg of targetArgs) {
  const eq = arg.indexOf("=");
  const label = eq > 0 ? arg.slice(0, eq) : arg;
  const path = eq > 0 ? arg.slice(eq + 1) : arg;
  const target = loadActivation(path);
  const targetPooled = pooled(anchorTrace(target, videoAnchor));

  console.log(`\n=== ${label} ===`);
  // Per-network masked cosine.
  const perNetwork: Record<string, number> = {};
  for (let net = 1; net <= 7; net += 1) {
    perNetwork[YEO7[net]] = maskedCosine(winnerPooled, targetPooled, net);
  }
  for (const [name, value] of Object.entries(perNetwork)) {
    console.log(`  ${name.padEnd(16)} ${value.toFixed(4)}`);
  }
  console.log(
    `  whole-cortex      ${cosine(center(winnerPooled), center(targetPooled)).toFixed(4)}`,
  );
  console.log(
    `  SENSORY (V+SM)    ${maskedCosineSet(winnerPooled, targetPooled, SENSORY).toFixed(4)}  <- "looks like"`,
  );
  console.log(
    `  AFFECTIVE (rest)  ${maskedCosineSet(winnerPooled, targetPooled, AFFECTIVE).toFixed(4)}  <- "feels like"`,
  );
}

console.log(
  "\nReading: if SENSORY >> AFFECTIVE, the match is visual mimicry (restyling).\nA vibe-weighted metric scores on AFFECTIVE and stops paying for style.",
);

// ---------------------------------------------------------------------------

function loadActivation(path: string): ActivationTrace {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as
    | { activation: ActivationTrace }
    | ActivationTrace;
  return "activation" in parsed
    ? (parsed as { activation: ActivationTrace }).activation
    : (parsed as ActivationTrace);
}

function pooled(trace: ActivationTrace): number[] {
  const frames = trace.values ?? [];
  const width = frames[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < width; i += 1) out[i] += frame[i] ?? 0;
  }
  if (frames.length) for (let i = 0; i < width; i += 1) out[i] /= frames.length;
  return out;
}

function maskedCosine(a: number[], b: number[], net: number): number {
  return maskedCosineSet(a, b, new Set([net]));
}

function maskedCosineSet(a: number[], b: number[], nets: Set<number>): number {
  const ai: number[] = [];
  const bi: number[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    if (nets.has(labels[i])) {
      ai.push(a[i] ?? 0);
      bi.push(b[i] ?? 0);
    }
  }
  return cosine(center(ai), center(bi));
}

function center(v: number[]): number[] {
  const m = v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);
  return v.map((x) => x - m);
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

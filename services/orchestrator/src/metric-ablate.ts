import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ActivationTrace, anchorTrace } from "@volta/core";
import { loadAnchors } from "./anchors.ts";

// Offline ablation: which Yeo-7 network subset best separates a set of image
// targets from their generated outputs? For every subset of the 7 networks,
// score the cross matrix (winner activations × targets) on just those
// vertices and report diagonal wins + mean diagonal margin. Finds the
// discriminating subspace empirically instead of by the V+SM-suppress guess.
// Zero oracle calls — reads persisted winner/target activations.
//
// Usage: bun metric-ablate.ts <expRoot> <id,id,...>

const repoRoot = resolve(import.meta.dir, "../../..");
const YEO7 = [
  "_",
  "Visual",
  "Somatomotor",
  "DorsalAttn",
  "VentralAttn",
  "Limbic",
  "Frontoparietal",
  "DefaultMode",
] as const;

const expRoot = process.argv[2];
const ids = (process.argv[3] ?? "").split(",").filter(Boolean);
if (!expRoot || ids.length < 2) {
  console.error("usage: bun metric-ablate.ts <expRoot> <id,id,...>");
  process.exit(1);
}
const expName = expRoot.replace(/\/+$/, "").split("/").at(-1) ?? "";
const labels = JSON.parse(
  readFileSync(
    join(repoRoot, "services/orchestrator/yeo7-labels.json"),
    "utf8",
  ),
) as number[];
const anchors = loadAnchors(repoRoot);

const targets = new Map<string, number[]>();
const winners = new Map<string, number[]>();
for (const id of ids) {
  targets.set(
    id,
    pooled(
      anchorTrace(
        loadAct(join(expRoot, "runs", `${expName}-${id}`, "target.json")),
        anchors.video,
      ),
    ),
  );
  winners.set(
    id,
    pooled(
      anchorTrace(
        loadAct(join(expRoot, "activations", `winner-${id}.json`)),
        anchors.video,
      ),
    ),
  );
}

// Precompute vertex index lists per network.
const netIdx = new Map<number, number[]>();
for (let net = 1; net <= 7; net += 1) netIdx.set(net, []);
for (let i = 0; i < labels.length; i += 1) {
  const arr = netIdx.get(labels[i]);
  if (arr) arr.push(i);
}

type Row = { subset: number[]; diag: number; meanMargin: number };
const rows: Row[] = [];
// All non-empty subsets of the 7 networks (127).
for (let mask = 1; mask < 1 << 7; mask += 1) {
  const subset: number[] = [];
  for (let net = 1; net <= 7; net += 1) {
    if (mask & (1 << (net - 1))) subset.push(net);
  }
  const idx = subset.flatMap((net) => netIdx.get(net) ?? []);
  let diag = 0;
  let marginSum = 0;
  for (const col of ids) {
    const t = pick(targets.get(col) as number[], idx);
    const ranked = ids
      .map((row) => ({
        row,
        v: cos(pick(winners.get(row) as number[], idx), t),
      }))
      .sort((a, b) => b.v - a.v);
    if (ranked[0].row === col) diag += 1;
    marginSum += (ranked[0]?.v ?? 0) - (ranked[1]?.v ?? 0);
  }
  rows.push({ subset, diag, meanMargin: marginSum / ids.length });
}

rows.sort((a, b) => b.diag - a.diag || b.meanMargin - a.meanMargin);
console.log(`ablation over ${ids.length} targets (${ids.join(", ")})\n`);
console.log("top subspaces (diagonal wins, mean diagonal margin):");
for (const r of rows.slice(0, 12)) {
  console.log(
    `  ${r.diag}/${ids.length}  margin=${r.meanMargin.toFixed(4)}  [${r.subset.map((n) => YEO7[n]).join("+")}]`,
  );
}
console.log("\nfull-cortex baseline:");
const all = rows.find((r) => r.subset.length === 7);
console.log(
  `  ${all?.diag}/${ids.length}  margin=${all?.meanMargin.toFixed(4)}  [all 7]`,
);

function loadAct(path: string): ActivationTrace {
  const p = JSON.parse(readFileSync(path, "utf8")) as {
    activation: ActivationTrace;
  };
  return p.activation;
}
function pooled(t: ActivationTrace): number[] {
  const f = t.values ?? [];
  const w = f[0]?.length ?? 0;
  const out = new Array<number>(w).fill(0);
  for (const fr of f) for (let i = 0; i < w; i += 1) out[i] += fr[i] ?? 0;
  if (f.length) for (let i = 0; i < w; i += 1) out[i] /= f.length;
  return out;
}
function pick(v: number[], idx: number[]): number[] {
  const out = idx.map((i) => v[i] ?? 0);
  const m = out.reduce((s, x) => s + x, 0) / Math.max(out.length, 1);
  return out.map((x) => x - m);
}
function cos(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

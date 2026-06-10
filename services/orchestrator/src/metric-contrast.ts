import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ActivationTrace,
  anchorTrace,
  neuralTrajectorySimilarity,
  pooledActivationSimilarity,
} from "@volta/core";
import { loadAnchors } from "./anchors.ts";

// Offline test of CONTRASTIVE scoring against the anchor battery: a
// candidate's specificity = anchored similarity to the target MINUS its mean
// anchored similarity to the anchor-corpus stimuli of the target's modality
// ("matches THIS audio, beyond matching audio-in-general"). Kills the
// target-side hub seen in audio3-v3 (one target's column dominating every
// row). Zero oracle calls — everything reads from disk.
//
// Usage: bun metric-contrast.ts <expRoot> <id,id,...> [probesDir]

const repoRoot = resolve(import.meta.dir, "../../..");
const expRoot = process.argv[2];
const ids = (process.argv[3] ?? "").split(",").filter(Boolean);
const probesDir = process.argv[4];
if (!expRoot || ids.length < 2) {
  console.error(
    "usage: bun metric-contrast.ts <expRoot> <id,id,...> [probesDir]",
  );
  process.exit(1);
}

const anchors = loadAnchors(repoRoot);
const expName = expRoot.replace(/\/+$/, "").split("/").at(-1) ?? "";
const cacheDir = join(repoRoot, ".agent/experiments/anchors-cache");

// Anchor battery: the individual audio-stimulus activations the audio anchor
// mean was built from.
const battery: ActivationTrace[] = readdirSync(cacheDir)
  .filter((name) => name.startsWith("audio-"))
  .map(
    (name) =>
      JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as ActivationTrace,
  );
console.error(`battery: ${battery.length} audio stimuli`);

const targets = new Map<string, ActivationTrace>();
for (const id of ids) {
  const parsed = JSON.parse(
    readFileSync(
      join(expRoot, "runs", `${expName}-${id}`, "target.json"),
      "utf8",
    ),
  ) as { activation: ActivationTrace };
  targets.set(id, parsed.activation);
}

type Text = { name: string; trace: ActivationTrace };
const texts: Text[] = [];
for (const id of ids) {
  const path = join(expRoot, "activations", `winner-${id}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      activation: ActivationTrace;
    };
    texts.push({ name: id, trace: parsed.activation });
  } catch {
    console.error(`no winner activation for ${id}`);
  }
}
if (probesDir) {
  for (const file of readdirSync(probesDir)) {
    texts.push({
      name: `probe:${file.replace(".json", "")}`,
      trace: JSON.parse(
        readFileSync(join(probesDir, file), "utf8"),
      ) as ActivationTrace,
    });
  }
}

function anchoredBlend(text: ActivationTrace, audio: ActivationTrace): number {
  return (
    neuralTrajectorySimilarity(
      anchorTrace(audio, anchors.audio),
      anchorTrace(text, anchors.text),
    ) *
      2 -
    1
  );
}

function anchoredPooled(text: ActivationTrace, audio: ActivationTrace): number {
  const sim = pooledActivationSimilarity(
    anchorTrace(audio, anchors.audio),
    anchorTrace(text, anchors.text),
  );
  return sim === undefined ? Number.NaN : sim * 2 - 1;
}

for (const variant of [
  { name: "contrastive anchored POOLED", fn: anchoredPooled },
  { name: "contrastive anchored FULL BLEND", fn: anchoredBlend },
]) {
  console.log(`\n=== ${variant.name} (target sim − mean battery sim) ===`);
  console.log(`            ${ids.map((l) => l.padStart(10)).join("")}`);
  const matrix = new Map<string, Map<string, number>>();
  for (const text of texts) {
    const baseline =
      battery.reduce((sum, b) => sum + variant.fn(text.trace, b), 0) /
      Math.max(battery.length, 1);
    const cells = new Map<string, number>();
    for (const id of ids) {
      const target = targets.get(id) as ActivationTrace;
      cells.set(id, variant.fn(text.trace, target) - baseline);
    }
    matrix.set(text.name, cells);
    console.log(
      `${text.name.padEnd(16)}${ids
        .map((id) => (cells.get(id) ?? Number.NaN).toFixed(4).padStart(10))
        .join("")}`,
    );
  }
  let wins = 0;
  for (const id of ids) {
    const ranked = [...matrix.entries()]
      .filter(([name]) => !name.startsWith("probe:"))
      .map(([name, cells]) => ({
        name,
        v: cells.get(id) ?? Number.NEGATIVE_INFINITY,
      }))
      .sort((a, b) => b.v - a.v);
    const won = ranked[0]?.name === id;
    if (won) wins += 1;
    const margin =
      ranked.length > 1 ? (ranked[0]?.v ?? 0) - (ranked[1]?.v ?? 0) : 0;
    console.log(
      `  target=${id}: winner=${ranked[0]?.name} ${won ? "✓" : "✗"} margin=${margin.toFixed(4)}`,
    );
  }
  console.log(`  diagonal (winners only): ${wins}/${ids.length}`);
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ActivationTrace,
  anchorTrace,
  neuralTrajectorySimilarity,
  pooledActivationSimilarity,
} from "@volta/core";
import { loadAnchors } from "./anchors.ts";

// Offline before/after for the anchored metric: re-score an experiment's
// persisted winner activations against its targets using the real anchor
// corpus. Zero oracle calls. Usage:
//   bun rescore-anchored.ts <expRoot> <targetId,targetId,...>
// Expects <expRoot>/runs/<exp>-<id>/target.json and
// <expRoot>/activations/winner-<id>.json (written by experiment-matrix).

const repoRoot = resolve(import.meta.dir, "../../..");
const expRoot = process.argv[2];
const ids = (process.argv[3] ?? "").split(",").filter(Boolean);
if (!expRoot || ids.length < 2) {
  console.error("usage: bun rescore-anchored.ts <expRoot> <id,id,...>");
  process.exit(1);
}

const anchors = loadAnchors(repoRoot);
if (!anchors.text || !anchors.audio) {
  console.error("anchors.json missing or incomplete — run build-anchors first");
  process.exit(1);
}
const expName = expRoot.replace(/\/+$/, "").split("/").at(-1) ?? "";

type Loaded = {
  id: string;
  target: ActivationTrace;
  targetKind: "audio" | "video" | "text";
  winner?: ActivationTrace;
  winnerKind: "text" | "video";
  preview?: string;
};

const items: Loaded[] = ids.map((id) => {
  const targetPath = join(expRoot, "runs", `${expName}-${id}`, "target.json");
  const target = JSON.parse(readFileSync(targetPath, "utf8")) as {
    activation: ActivationTrace;
    rendered?: { kind?: string };
  };
  const winnerPath = join(expRoot, "activations", `winner-${id}.json`);
  const winner = existsSync(winnerPath)
    ? (JSON.parse(readFileSync(winnerPath, "utf8")) as {
        activation: ActivationTrace;
        preview?: string;
      })
    : undefined;
  return {
    id,
    target: target.activation,
    targetKind: (target.rendered?.kind ?? "audio") as Loaded["targetKind"],
    winner: winner?.activation,
    winnerKind: "text",
    preview: winner?.preview,
  };
});

const rows = items.filter((item) => item.winner);

function anchoredFull(winner: Loaded, target: Loaded): number {
  const w = anchorTrace(
    winner.winner as ActivationTrace,
    anchors[winner.winnerKind],
  );
  const t = anchorTrace(target.target, anchors[target.targetKind]);
  return neuralTrajectorySimilarity(t, w) * 2 - 1;
}

function anchoredPooled(winner: Loaded, target: Loaded): number {
  const w = anchorTrace(
    winner.winner as ActivationTrace,
    anchors[winner.winnerKind],
  );
  const t = anchorTrace(target.target, anchors[target.targetKind]);
  const sim = pooledActivationSimilarity(t, w);
  return sim === undefined ? Number.NaN : sim * 2 - 1;
}

const variants = [
  { name: "anchored full blend (raw [-1,1])", fn: anchoredFull },
  { name: "anchored pooled cosine (raw [-1,1])", fn: anchoredPooled },
];

const lines: string[] = [
  `# ${expName} — ANCHORED re-score (same texts, fixed metric)`,
  "",
];
for (const variant of variants) {
  lines.push(`## ${variant.name}`, "");
  lines.push(`| text \\ target | ${ids.join(" | ")} |`);
  lines.push(`|---|${ids.map(() => "---").join("|")}|`);
  const matrix = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const cells = new Map<string, number>();
    for (const col of items) {
      cells.set(col.id, variant.fn(row, col));
    }
    matrix.set(row.id, cells);
    lines.push(
      `| ${row.id} | ${ids
        .map((id) => {
          const v = cells.get(id) ?? Number.NaN;
          const mark = row.id === id ? "**" : "";
          return `${mark}${v.toFixed(4)}${mark}`;
        })
        .join(" | ")} |`,
    );
  }
  lines.push("");
  let wins = 0;
  for (const col of items) {
    const ranked = rows
      .map((row) => ({
        id: row.id,
        v: matrix.get(row.id)?.get(col.id) ?? Number.NEGATIVE_INFINITY,
      }))
      .sort((a, b) => b.v - a.v);
    const won = ranked[0]?.id === col.id;
    if (won) wins += 1;
    const margin =
      ranked.length > 1 ? (ranked[0]?.v ?? 0) - (ranked[1]?.v ?? 0) : 0;
    lines.push(
      `- target=${col.id}: winner=${ranked[0]?.id} ${won ? "✓" : "✗"} margin=${margin.toFixed(4)}`,
    );
  }
  lines.push(`- diagonal: ${wins}/${items.length}`, "");
}

const out = lines.join("\n");
writeFileSync(join(expRoot, "report-anchored.md"), out);
console.log(out);

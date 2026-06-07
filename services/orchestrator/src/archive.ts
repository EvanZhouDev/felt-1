import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CandidateArchiveContext,
  CandidateArchivePromptItem,
} from "@volta/agent-sdk";
import type { EvaluatedOutput, OutputNode } from "@volta/core";

export type CandidateArchive = {
  version: 1;
  updatedAt: string;
  entries: CandidateArchiveEntry[];
};

export type CandidateArchiveEntry = CandidateArchivePromptItem & {
  runId?: string;
  outputType: OutputNode["type"];
  textLength?: number;
  descriptors: string[];
};

const ARCHIVE_FILE = "candidate-archive.json";

export function loadCandidateArchive(runPath: string): CandidateArchive {
  const path = archivePath(runPath);
  if (!existsSync(path)) {
    return emptyArchive();
  }
  return JSON.parse(readFileSync(path, "utf8")) as CandidateArchive;
}

export async function appendCandidateArchive(args: {
  runPath: string;
  iteration: number;
  rankedOutputs: EvaluatedOutput[];
  runId?: string;
}): Promise<CandidateArchive> {
  const archive = loadCandidateArchive(args.runPath);
  return writeArchive(
    archivePath(args.runPath),
    appendEntries(archive, args.iteration, args.rankedOutputs, args.runId),
  );
}

export function loadTargetCandidateArchive(
  runsRoot: string,
  targetSha: string,
): CandidateArchive {
  const path = targetArchivePath(runsRoot, targetSha);
  if (!existsSync(path)) {
    return emptyArchive();
  }
  return JSON.parse(readFileSync(path, "utf8")) as CandidateArchive;
}

export async function appendTargetCandidateArchive(args: {
  runsRoot: string;
  targetSha: string;
  iteration: number;
  rankedOutputs: EvaluatedOutput[];
  runId: string;
}): Promise<CandidateArchive> {
  const archive = loadTargetCandidateArchive(args.runsRoot, args.targetSha);
  return writeArchive(
    targetArchivePath(args.runsRoot, args.targetSha),
    appendEntries(archive, args.iteration, args.rankedOutputs, args.runId),
  );
}

export function mergeCandidateArchives(
  ...archives: CandidateArchive[]
): CandidateArchive {
  const seen = new Set<string>();
  const entries = [...archives.flatMap((archive) => archive.entries)].filter(
    (entry) => {
      const key = [
        entry.runId ?? "local",
        entry.iteration,
        entry.agentId,
        entry.behaviorKey,
        entry.text,
      ].join(":");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    },
  );

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  };
}

export function archivePromptContext(
  archive: CandidateArchive,
): CandidateArchiveContext | undefined {
  if (archive.entries.length === 0) {
    return undefined;
  }

  const top = byScore(archive.entries).slice(0, 4).map(promptItem);
  const diverse = byScore(bestPerBehavior(archive.entries))
    .slice(0, 6)
    .map(promptItem);
  const recent = [...archive.entries]
    .sort(
      (left, right) =>
        right.iteration - left.iteration ||
        right.neuralSimilarity - left.neuralSimilarity,
    )
    .slice(0, 4)
    .map(promptItem);

  return {
    bestNeuralSimilarity: top[0]?.neuralSimilarity,
    top,
    diverse,
    recent,
    operatorStats: operatorStats(archive.entries).slice(0, 8),
    notes: [
      "This archive is the evolving population for the current target, not a source of text to copy exactly.",
      "Archive ordering follows total adjusted score when available; raw neural similarity is diagnostic and can include generic modality attractors.",
      "Use top examples for elitist inheritance, diverse examples for MAP-Elites-style coverage, and recent examples for local search momentum.",
      "For image outputs, operatorStats separates local image mutation operators such as local-style-* from elite replay; prefer high-total local operators and avoid repeating low-total local neighborhoods.",
      "Prefer offspring that preserve neural score gains while changing one behavior descriptor or one representation variable at a time.",
      "If an entropy/operator lineage repeatedly scores poorly, treat it as a negative-control region unless assigned to explore novelty.",
    ],
  };
}

function archiveEntry(
  iteration: number,
  output: EvaluatedOutput,
  runId?: string,
): CandidateArchiveEntry {
  const behavior = behaviorDescriptor(output.outputNode);
  return {
    runId,
    iteration,
    agentId: output.agentId,
    entropy: output.entropy,
    neuralSimilarity: output.score.neuralSimilarity,
    adjustedSimilarity: output.score.adjustedSimilarity,
    total: output.score.total,
    behaviorKey: behavior.key,
    outputType: output.outputNode.type,
    text: textForNode(output.outputNode),
    textLength: textForNode(output.outputNode)?.length,
    descriptors: behavior.descriptors,
  };
}

function appendEntries(
  archive: CandidateArchive,
  iteration: number,
  rankedOutputs: EvaluatedOutput[],
  runId?: string,
): CandidateArchive {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [
      ...archive.entries,
      ...rankedOutputs.map((output) => archiveEntry(iteration, output, runId)),
    ],
  };
}

function behaviorDescriptor(node: OutputNode): {
  key: string;
  descriptors: string[];
} {
  if (node.type !== "text") {
    return {
      key: node.type,
      descriptors: [node.type],
    };
  }

  const text = node.payload.text;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const descriptors = [
    lengthBucket(words.length),
    sentenceStyle(text),
    properNameStyle(text),
    emphasisStyle(text),
  ];
  return {
    key: descriptors.join(":"),
    descriptors,
  };
}

function lengthBucket(wordCount: number): string {
  if (wordCount < 35) {
    return "short";
  }
  if (wordCount < 90) {
    return "medium";
  }
  return "long";
}

function sentenceStyle(text: string): string {
  const commaCount = (text.match(/,/g) ?? []).length;
  const sentenceCount = (text.match(/[.!?]/g) ?? []).length;
  if (sentenceCount <= 1 && commaCount >= 5) {
    return "inventory";
  }
  if (sentenceCount <= 2) {
    return "caption";
  }
  return "prose";
}

function properNameStyle(text: string): string {
  if (/\b(Mona Lisa|Leonardo|Gherardini|Renaissance)\b/.test(text)) {
    return "named";
  }
  return "unnamed";
}

function emphasisStyle(text: string): string {
  const lower = text.toLowerCase();
  const buckets = [
    {
      name: "spatial",
      terms: [
        "foreground",
        "background",
        "center",
        "behind",
        "lower",
        "upper",
        "near",
        "far",
        "distance",
        "depth",
        "scale",
        "space",
      ],
    },
    {
      name: "affect",
      terms: [
        "calm",
        "quiet",
        "tense",
        "warm",
        "cool",
        "mood",
        "emotion",
        "pressure",
        "energy",
        "attention",
      ],
    },
    {
      name: "sensory",
      terms: [
        "soft",
        "sharp",
        "shadow",
        "haze",
        "muted",
        "color",
        "light",
        "bright",
        "dark",
        "texture",
        "surface",
        "rhythm",
        "tone",
        "contrast",
      ],
    },
    {
      name: "concrete",
      terms: [
        "person",
        "figure",
        "body",
        "face",
        "voice",
        "object",
        "place",
        "room",
        "sound",
        "word",
        "text",
        "scene",
      ],
    },
  ];

  return (
    buckets
      .map((bucket) => ({
        name: bucket.name,
        score: bucket.terms.filter((term) => lower.includes(term)).length,
      }))
      .sort((left, right) => right.score - left.score)[0]?.name ?? "mixed"
  );
}

function bestPerBehavior(
  entries: CandidateArchiveEntry[],
): CandidateArchiveEntry[] {
  const best = new Map<string, CandidateArchiveEntry>();
  for (const entry of entries) {
    const current = best.get(entry.behaviorKey);
    if (!current || entry.total > current.total) {
      best.set(entry.behaviorKey, entry);
    }
  }
  return [...best.values()];
}

export function operatorStats(entries: CandidateArchiveEntry[]) {
  const byOperator = new Map<
    string,
    {
      count: number;
      totalScore: number;
      bestTotal: number;
      totalAdjustedSimilarity: number;
      adjustedSimilarityCount: number;
      bestAdjustedSimilarity: number;
      totalNeuralSimilarity: number;
      bestNeuralSimilarity: number;
    }
  >();

  for (const entry of entries) {
    const operator = operatorName(entry);
    const current = byOperator.get(operator) ?? {
      count: 0,
      totalScore: 0,
      bestTotal: Number.NEGATIVE_INFINITY,
      totalAdjustedSimilarity: 0,
      adjustedSimilarityCount: 0,
      bestAdjustedSimilarity: Number.NEGATIVE_INFINITY,
      totalNeuralSimilarity: 0,
      bestNeuralSimilarity: Number.NEGATIVE_INFINITY,
    };
    current.count += 1;
    current.totalScore += entry.total;
    current.bestTotal = Math.max(current.bestTotal, entry.total);
    if (typeof entry.adjustedSimilarity === "number") {
      current.totalAdjustedSimilarity += entry.adjustedSimilarity;
      current.adjustedSimilarityCount += 1;
      current.bestAdjustedSimilarity = Math.max(
        current.bestAdjustedSimilarity,
        entry.adjustedSimilarity,
      );
    }
    current.totalNeuralSimilarity += entry.neuralSimilarity;
    current.bestNeuralSimilarity = Math.max(
      current.bestNeuralSimilarity,
      entry.neuralSimilarity,
    );
    byOperator.set(operator, current);
  }

  return [...byOperator.entries()]
    .map(([operator, stats]) => ({
      operator,
      count: stats.count,
      bestTotal: stats.bestTotal,
      meanTotal: stats.totalScore / stats.count,
      bestAdjustedSimilarity:
        stats.adjustedSimilarityCount > 0
          ? stats.bestAdjustedSimilarity
          : undefined,
      meanAdjustedSimilarity:
        stats.adjustedSimilarityCount > 0
          ? stats.totalAdjustedSimilarity / stats.adjustedSimilarityCount
          : undefined,
      bestNeuralSimilarity: stats.bestNeuralSimilarity,
      meanNeuralSimilarity: stats.totalNeuralSimilarity / stats.count,
    }))
    .sort(
      (left, right) =>
        right.bestTotal - left.bestTotal ||
        right.meanTotal - left.meanTotal ||
        right.bestNeuralSimilarity - left.bestNeuralSimilarity,
    );
}

function operatorName(entry: CandidateArchiveEntry): string {
  if (entry.outputType === "image") {
    const imageMutation = entropyValue(entry.entropy, "imageMutation");
    if (imageMutation) {
      const source = entropyValue(entry.entropy, "imageMutationSource");
      return source ? `${imageMutation}@source=${source}` : imageMutation;
    }
  }
  return entropyValue(entry.entropy, "strategy") || "unknown";
}

function promptItem(entry: CandidateArchiveEntry): CandidateArchivePromptItem {
  return {
    iteration: entry.iteration,
    agentId: entry.agentId,
    entropy: entry.entropy,
    neuralSimilarity: entry.neuralSimilarity,
    adjustedSimilarity: entry.adjustedSimilarity,
    total: entry.total,
    behaviorKey: entry.behaviorKey,
    text: entry.text ? truncate(entry.text, 700) : undefined,
  };
}

function entropyValue(
  entropy: string | undefined,
  key: string,
): string | undefined {
  const match = entropy?.match(new RegExp(`${key}=([^|]+)`));
  return match?.[1]?.trim();
}

function byScore<T extends CandidateArchivePromptItem>(entries: T[]): T[] {
  return [...entries].sort((left, right) => right.total - left.total);
}

function textForNode(node: OutputNode): string | undefined {
  if (node.type === "text") {
    return node.payload.text;
  }
  return undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function archivePath(runPath: string): string {
  return join(runPath, ARCHIVE_FILE);
}

function targetArchivePath(runsRoot: string, targetSha: string): string {
  return join(runsRoot, "..", "target-archives", `${targetSha}.json`);
}

async function writeArchive(
  path: string,
  archive: CandidateArchive,
): Promise<CandidateArchive> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return archive;
}

function emptyArchive(): CandidateArchive {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

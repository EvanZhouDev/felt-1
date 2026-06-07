import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type TraceGraph = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoots: string[];
  stats: {
    runCount: number;
    completedRunCount: number;
    nodeCount: number;
    edgeCount: number;
    imageNodeCount: number;
    textNodeCount: number;
  };
  runs: TraceRun[];
  nodes: TraceNode[];
  edges: TraceEdge[];
};

type TraceRun = {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  inputType: string;
  outputType: string;
  seedPrompt?: string;
  runPath: string;
  runJsonPath: string;
  runJsonSha256: string;
  sourceRoot: string;
  artifactFiles: string[];
  iterationCount: number;
  candidateCount: number;
  bestScore?: number;
  bestNeuralSimilarity?: number;
  bestAdjustedSimilarity?: number;
  stopReason?: string;
  selectedAgentId?: string;
  targetNodeId: string;
  seedNodeId?: string;
  bestNodeId?: string;
  tags: string[];
};

type TraceNode = {
  id: string;
  runId: string;
  role: "target" | "seed" | "candidate" | "judge";
  modality: string;
  label: string;
  subtitle?: string;
  iteration?: number;
  rank?: number;
  agentId?: string;
  selected?: boolean;
  media?: TraceMedia;
  score?: TraceScore;
  entropy?: string;
  rawPath?: string;
};

type TraceMedia =
  | {
      kind: "image";
      path: string;
      alt: string;
    }
  | {
      kind: "text";
      text: string;
    };

type TraceScore = {
  total?: number;
  neuralSimilarity?: number;
  adjustedSimilarity?: number;
  calibratedSimilarity?: number;
  contrastSimilarity?: number;
  targetSpecificity?: number;
  seedAdherence?: number;
  seedSimilarity?: number;
  seedTargetSimilarity?: number;
  seedSpecificity?: number;
};

type TraceEdge = {
  id: string;
  source: string;
  target: string;
  kind: "target" | "seed" | "candidate" | "selection" | "iteration" | "summary";
  label?: string;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_ROOTS = [
  join(REPO_ROOT, ".volta", "benchmarks", "runs"),
  join(REPO_ROOT, ".volta", "runs"),
];
const OUT_DIR = join(REPO_ROOT, ".agent", "traces");
const OUT_PATH = join(OUT_DIR, "volta-run-traces.json");
const SUMMARY_PATH = join(OUT_DIR, "volta-run-traces.summary.md");
const MAX_CANDIDATES_PER_ITERATION = 12;

const graph = buildTraceGraph();
await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
await writeFile(SUMMARY_PATH, `${renderSummary(graph)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outPath: OUT_PATH,
      summaryPath: SUMMARY_PATH,
      runCount: graph.stats.runCount,
      nodeCount: graph.stats.nodeCount,
      edgeCount: graph.stats.edgeCount,
      imageNodeCount: graph.stats.imageNodeCount,
      textNodeCount: graph.stats.textNodeCount,
    },
    null,
    2,
  ),
);

function buildTraceGraph(): TraceGraph {
  const runArtifacts = SOURCE_ROOTS.flatMap((root) => findRunArtifacts(root));
  const runs: TraceRun[] = [];
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];

  for (const artifact of runArtifacts) {
    const parsed = readJson<JsonObject>(artifact.runJsonPath);
    if (!parsed) {
      continue;
    }

    const result = asObject(parsed.result);
    const input = asObject(parsed.input);
    const output = asObject(parsed.output);
    const inputNode = asObject(input.inputNode);
    const outputType = stringValue(output.outputType) ?? "unknown";
    const inputType = stringValue(inputNode.type) ?? "unknown";
    const runId = stringValue(parsed.id) ?? artifact.runId;
    const targetNodeId = nodeId(runId, "target");
    const seedPrompt = stringValue(asObject(input.seed).prompt);
    const selectedAgentId = stringValue(
      asObject(result?.judge).selectedAgentId,
    );
    const bestNodeId = selectedAgentId
      ? nodeId(runId, "candidate", 1, selectedAgentId)
      : undefined;
    const seedNodeId = seedPrompt ? nodeId(runId, "seed") : undefined;

    const targetNode = buildTargetNode({
      runId,
      id: targetNodeId,
      inputNode,
      result,
    });
    nodes.push(targetNode);

    if (seedPrompt && seedNodeId) {
      nodes.push({
        id: seedNodeId,
        runId,
        role: "seed",
        modality: "text",
        label: "Seed",
        subtitle: "content constraint",
        media: {
          kind: "text",
          text: seedText(result) ?? seedPrompt,
        },
      });
      edges.push({
        id: `${seedNodeId}->${targetNodeId}`,
        source: seedNodeId,
        target: targetNodeId,
        kind: "seed",
        label: "steers",
      });
    }

    const iterationSummaries = extractIterations(result);
    for (const iteration of iterationSummaries) {
      const judgeNodeId = nodeId(runId, "judge", iteration.iteration);
      nodes.push({
        id: judgeNodeId,
        runId,
        role: "judge",
        modality: "decision",
        label: `Iteration ${iteration.iteration}`,
        subtitle: selectedLabel(iteration.judge),
        iteration: iteration.iteration,
        media: {
          kind: "text",
          text:
            stringValue(iteration.judge.reasoning) ??
            "The judge selected the highest-ranked candidate.",
        },
      });

      iteration.outputs
        .slice(0, MAX_CANDIDATES_PER_ITERATION)
        .forEach((candidate, index) => {
          const agentId =
            stringValue(candidate.agentId) ?? `candidate-${index + 1}`;
          const candidateNodeId = nodeId(
            runId,
            "candidate",
            iteration.iteration,
            agentId,
          );
          const outputNode = asObject(candidate.outputNode);
          const rendered = asObject(candidate.rendered);
          const score = compactScore(asObject(candidate.score));
          const selected =
            stringValue(iteration.judge.selectedAgentId) === agentId ||
            selectedAgentId === agentId;
          nodes.push({
            id: candidateNodeId,
            runId,
            role: "candidate",
            modality: stringValue(outputNode.type) ?? outputType,
            label: agentId,
            subtitle: strategyName(stringValue(candidate.entropy)),
            iteration: iteration.iteration,
            rank: index + 1,
            agentId,
            selected,
            media: mediaFromNode(outputNode, rendered, agentId),
            score,
            entropy: stringValue(candidate.entropy),
            rawPath: stringValue(candidate.rawPath),
          });
          edges.push({
            id: `${targetNodeId}->${candidateNodeId}`,
            source: targetNodeId,
            target: candidateNodeId,
            kind: "target",
            label: "vibe target",
          });
          if (seedNodeId) {
            edges.push({
              id: `${seedNodeId}->${candidateNodeId}`,
              source: seedNodeId,
              target: candidateNodeId,
              kind: "seed",
              label: "subject",
            });
          }
          edges.push({
            id: `${candidateNodeId}->${judgeNodeId}`,
            source: candidateNodeId,
            target: judgeNodeId,
            kind: selected ? "selection" : "candidate",
            label: selected ? "selected" : undefined,
          });
        });

      if (iteration.iteration > 1) {
        edges.push({
          id: `${nodeId(runId, "judge", iteration.iteration - 1)}->${judgeNodeId}`,
          source: nodeId(runId, "judge", iteration.iteration - 1),
          target: judgeNodeId,
          kind: "iteration",
          label: "next turn",
        });
      }
    }

    const candidates = iterationSummaries.reduce(
      (count, iteration) => count + iteration.outputs.length,
      0,
    );
    runs.push({
      id: runId,
      status: stringValue(parsed.status) ?? "unknown",
      createdAt: stringValue(parsed.createdAt),
      updatedAt: stringValue(parsed.updatedAt),
      inputType,
      outputType,
      seedPrompt,
      runPath: artifact.runPath,
      runJsonPath: artifact.runJsonPath,
      runJsonSha256: sha256(readFileSync(artifact.runJsonPath)),
      sourceRoot: artifact.sourceRoot,
      artifactFiles: artifactFiles(artifact.runPath),
      iterationCount: iterationSummaries.length,
      candidateCount: candidates,
      bestScore: numberValue(result?.bestScore),
      bestNeuralSimilarity: numberValue(result?.bestNeuralSimilarity),
      bestAdjustedSimilarity: numberValue(result?.bestAdjustedSimilarity),
      stopReason: stringValue(result?.stopReason),
      selectedAgentId,
      targetNodeId,
      seedNodeId,
      bestNodeId,
      tags: tagsForRun(runId, inputType, outputType, Boolean(seedPrompt)),
    });
  }

  runs.sort((left, right) =>
    (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoots: SOURCE_ROOTS,
    stats: {
      runCount: runs.length,
      completedRunCount: runs.filter((run) => run.status === "completed")
        .length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      imageNodeCount: nodes.filter((node) => node.media?.kind === "image")
        .length,
      textNodeCount: nodes.filter((node) => node.media?.kind === "text").length,
    },
    runs,
    nodes,
    edges,
  };
}

function findRunArtifacts(root: string): Array<{
  sourceRoot: string;
  runId: string;
  runPath: string;
  runJsonPath: string;
}> {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((entry) => {
      const runPath = join(root, entry);
      const runJsonPath = join(runPath, "run.json");
      if (!safeIsDirectory(runPath) || !existsSync(runJsonPath)) {
        return undefined;
      }
      return {
        sourceRoot: root,
        runId: entry,
        runPath,
        runJsonPath,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function buildTargetNode(args: {
  runId: string;
  id: string;
  inputNode: JsonObject;
  result?: JsonObject;
}): TraceNode {
  const resultTarget = asObject(args.result?.target);
  const rendered = asObject(resultTarget.rendered);
  return {
    id: args.id,
    runId: args.runId,
    role: "target",
    modality: stringValue(args.inputNode.type) ?? "unknown",
    label: "Target",
    subtitle: "TRIBE activation source",
    media: mediaFromNode(args.inputNode, rendered, "target"),
  };
}

function extractIterations(result?: JsonObject): Array<{
  iteration: number;
  judge: JsonObject;
  outputs: JsonObject[];
}> {
  const iterations = arrayValue(result?.iterations);
  if (iterations.length > 0) {
    return iterations
      .map((item, index) => {
        const iteration = asObject(item);
        const rankedOutputs = arrayValue(iteration.rankedOutputs).map(asObject);
        return {
          iteration: numberValue(iteration.iteration) ?? index + 1,
          judge: asObject(iteration.judge),
          outputs: rankedOutputs,
        };
      })
      .filter(
        (item) => item.outputs.length > 0 || Object.keys(item.judge).length,
      );
  }

  const candidates = arrayValue(result?.candidates).map(asObject);
  if (candidates.length === 0) {
    return [];
  }
  return [
    {
      iteration: 1,
      judge: asObject(result?.judge),
      outputs: candidates,
    },
  ];
}

function mediaFromNode(
  node: JsonObject,
  rendered: JsonObject,
  alt: string,
): TraceMedia | undefined {
  const type = stringValue(node.type);
  if (type === "text") {
    const text =
      stringValue(asObject(node.payload).text) ?? stringValue(rendered.preview);
    return text ? { kind: "text", text } : undefined;
  }

  if (type === "image") {
    const renderedPreview = stringValue(rendered.preview);
    const sourceUri = stringValue(asObject(asObject(node.payload).source).uri);
    const imagePath =
      localImagePath(renderedPreview) ?? localImagePath(sourceUri);
    return imagePath ? { kind: "image", path: imagePath, alt } : undefined;
  }

  const preview = stringValue(rendered.preview);
  if (preview && !localImagePath(preview)) {
    return { kind: "text", text: preview };
  }
  const imagePath = localImagePath(preview);
  return imagePath ? { kind: "image", path: imagePath, alt } : undefined;
}

function compactScore(score: JsonObject): TraceScore | undefined {
  const compact: TraceScore = {
    total: numberValue(score.total),
    neuralSimilarity: numberValue(score.neuralSimilarity),
    adjustedSimilarity: numberValue(score.adjustedSimilarity),
    calibratedSimilarity: numberValue(score.calibratedSimilarity),
    contrastSimilarity: numberValue(score.contrastSimilarity),
    targetSpecificity: numberValue(score.targetSpecificity),
    seedAdherence: numberValue(score.seedAdherence),
    seedSimilarity: numberValue(score.seedSimilarity),
    seedTargetSimilarity: numberValue(score.seedTargetSimilarity),
    seedSpecificity: numberValue(score.seedSpecificity),
  };
  return Object.values(compact).some((value) => value !== undefined)
    ? compact
    : undefined;
}

function artifactFiles(runPath: string): string[] {
  return [
    "run.json",
    "evolution-journal.json",
    "candidate-archive.json",
    "target.json",
    "seed-target.json",
  ]
    .map((name) => join(runPath, name))
    .filter((path) => existsSync(path));
}

function seedText(result?: JsonObject): string | undefined {
  const seedTarget = asObject(result?.seedTarget);
  return (
    stringValue(seedTarget.text) ??
    stringValue(asObject(seedTarget.rendered).preview)
  );
}

function selectedLabel(judge: JsonObject): string | undefined {
  const selected = stringValue(judge.selectedAgentId);
  return selected ? `selected ${selected}` : undefined;
}

function strategyName(entropy: string | undefined): string | undefined {
  if (!entropy) {
    return undefined;
  }
  const match = entropy.match(/strategy=([^|]+)/);
  return match?.[1]?.trim();
}

function tagsForRun(
  runId: string,
  inputType: string,
  outputType: string,
  seeded: boolean,
): string[] {
  const idTags = runId
    .split(/[-_]/)
    .filter((part) => part.length > 2 && !/^[0-9a-f]{4,}$/i.test(part));
  return [
    ...new Set(
      [inputType, outputType, seeded ? "seeded" : "", ...idTags].filter(
        Boolean,
      ),
    ),
  ];
}

function nodeId(
  runId: string,
  role: string,
  iteration?: number,
  suffix?: string,
): string {
  return [runId, role, iteration ? `i${iteration}` : "", suffix ?? ""]
    .filter(Boolean)
    .join(":");
}

function localImagePath(value: string | undefined): string | undefined {
  const path = localPath(value);
  if (!path) {
    return undefined;
  }
  return isImagePath(path) ? path : undefined;
}

function localPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("file://")) {
    return decodeURIComponent(new URL(value).pathname);
  }
  return value.startsWith("/") ? value : undefined;
}

function isImagePath(path: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(
    extname(path).toLowerCase(),
  );
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function renderSummary(graph: TraceGraph): string {
  const newest = graph.runs[0];
  const best = [...graph.runs]
    .filter((run) => run.bestAdjustedSimilarity !== undefined)
    .sort(
      (left, right) =>
        (right.bestAdjustedSimilarity ?? -Infinity) -
        (left.bestAdjustedSimilarity ?? -Infinity),
    )[0];
  return [
    "# Volta Run Trace Snapshot",
    "",
    `Generated: ${graph.generatedAt}`,
    "",
    `Runs: ${graph.stats.runCount}`,
    `Completed runs: ${graph.stats.completedRunCount}`,
    `Graph nodes: ${graph.stats.nodeCount}`,
    `Graph edges: ${graph.stats.edgeCount}`,
    `Image nodes: ${graph.stats.imageNodeCount}`,
    `Text nodes: ${graph.stats.textNodeCount}`,
    "",
    newest
      ? `Newest run: ${newest.id} (${newest.inputType} -> ${newest.outputType})`
      : "Newest run: none",
    best
      ? `Best adjusted run: ${best.id} (${best.bestAdjustedSimilarity})`
      : "Best adjusted run: none",
    "",
    "The JSON snapshot intentionally stores compact run/candidate metadata and local media references, not full activation vectors or copied generated assets.",
  ].join("\n");
}

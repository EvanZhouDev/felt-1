import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type TraceGraph = {
  generatedAt?: string;
  source: "snapshot" | "weave";
  sourceDetail?: string;
  stats: TraceStats;
  runs: TraceRun[];
  nodes: TraceNode[];
  edges: TraceEdge[];
};

export type TraceStats = {
  runCount: number;
  completedRunCount?: number;
  edgeCount: number;
  imageNodeCount: number;
  nodeCount: number;
  textNodeCount?: number;
};

export type TraceRun = {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  inputType: string;
  outputType: string;
  seedPrompt?: string;
  runPath: string;
  runJsonPath?: string;
  runJsonSha256: string;
  iterationCount: number;
  candidateCount?: number;
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

export type TraceNode = {
  id: string;
  runId: string;
  role: "target" | "seed" | "candidate" | "judge" | "final";
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
};

export type TraceMedia =
  | {
      kind: "image";
      path: string;
      alt: string;
    }
  | {
      kind: "text";
      text: string;
    };

export type TraceScore = {
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
  seedPromptAdherence?: number;
  seedPromptPenalty?: number;
  penalty?: number;
};

export type TraceEdge = {
  id: string;
  source: string;
  target: string;
  kind: "target" | "seed" | "candidate" | "selection" | "iteration" | "summary";
  label?: string;
};

type WeaveCall = {
  id: string;
  op_name: string;
  display_name?: string | null;
  trace_id: string;
  parent_id?: string | null;
  started_at: string;
  ended_at?: string | null;
  attributes?: unknown;
  inputs?: unknown;
  output?: unknown;
  exception?: string | null;
};

type WeaveClient = {
  getCalls(options: {
    filter?: { op_names?: string[]; trace_roots_only?: boolean };
    limit?: number;
    sortBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  }): Promise<WeaveCall[]>;
};

const WEAVE_OPS = [
  "volta.run",
  "volta.resume",
  "target.render",
  "seed.render",
  "candidate.generate",
  "candidate.render",
  "candidate.score",
  "judge.select",
];

export async function loadTraceGraph(): Promise<TraceGraph> {
  const backend = process.env.VOLTA_TRACE_BACKEND ?? "auto";
  if (backend !== "snapshot" && weaveProject()) {
    try {
      return await loadWeaveTraceGraph();
    } catch (error) {
      if (backend === "weave" && process.env.VOLTA_TRACE_FALLBACK === "false") {
        throw error;
      }
      console.warn(`Weave trace backend unavailable: ${String(error)}`);
    }
  }
  return loadSnapshotTraceGraph();
}

async function loadSnapshotTraceGraph(): Promise<TraceGraph> {
  const body = await readFile(snapshotPath(), "utf8");
  const graph = JSON.parse(body) as TraceGraph;
  return {
    ...graph,
    source: "snapshot",
    sourceDetail: snapshotPath(),
  };
}

async function loadWeaveTraceGraph(): Promise<TraceGraph> {
  const project = weaveProject();
  if (!project) {
    throw new Error("VOLTA_WEAVE_PROJECT is required for Weave trace backend.");
  }
  const weave = (await import("weave")) as {
    init(project: string): Promise<WeaveClient>;
  };
  const client = await weave.init(project);
  const calls = await client.getCalls({
    limit: integerFromEnv("VOLTA_WEAVE_TRACE_LIMIT", 2000),
    sortBy: [{ field: "started_at", direction: "desc" }],
  });

  const voltaCalls = calls.filter((call) => WEAVE_OPS.includes(opName(call)));
  const graph = graphFromWeaveCalls(voltaCalls, project);
  if (graph.runs.length === 0) {
    throw new Error(`No Volta Weave calls found in ${project}.`);
  }
  return graph;
}

function graphFromWeaveCalls(calls: WeaveCall[], project: string): TraceGraph {
  const runRoots = calls
    .filter((call) => ["volta.run", "volta.resume"].includes(opName(call)))
    .sort((left, right) => right.started_at.localeCompare(left.started_at));
  const callsByRunId = groupCallsByRunId(calls);
  const runs: TraceRun[] = [];
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];

  for (const root of runRoots) {
    const runInput = unwrapInput(root.inputs);
    const runOutput = objectValue(root.output);
    const runId =
      stringValue(runOutput?.runId) ??
      stringValue(deepFind(runInput, "runId")) ??
      stringValue(deepFind(root.attributes, "runId")) ??
      root.trace_id;
    const runCalls = callsByRunId.get(runId) ?? [];
    const targetNodeId = `${runId}:target`;
    const seedNodeId = seedInput(runInput) ? `${runId}:seed` : undefined;
    const output = objectValue(runInput?.output);
    const inputNode = objectValue(runInput?.inputNode);
    const outputType = stringValue(output?.outputType) ?? "unknown";
    const inputType = stringValue(inputNode?.type) ?? "unknown";
    const selectedAgentId = stringValue(runOutput?.selectedAgentId);
    const targetRender = latestCall(runCalls, "target.render");
    const seedRender = latestCall(runCalls, "seed.render");
    const candidateNodes = buildCandidateNodes({
      calls: runCalls,
      runId,
      selectedAgentId,
    });
    const bestNode = candidateNodes.find((node) => node.selected);
    const bestScore = bestNode?.score;
    const run: TraceRun = {
      id: runId,
      status: root.exception
        ? "failed"
        : root.ended_at
          ? "completed"
          : "running",
      createdAt: root.started_at,
      updatedAt: root.ended_at ?? root.started_at,
      inputType,
      outputType,
      seedPrompt: seedPrompt(runInput),
      runPath: stringValue(deepFind(runInput, "runPath")) ?? "",
      runJsonSha256: root.id,
      iterationCount:
        numberValue(runOutput?.iterationCount) ?? iterationCount(runCalls),
      candidateCount: candidateNodes.length,
      bestScore: numberValue(runOutput?.bestScore) ?? bestScore?.total,
      bestNeuralSimilarity:
        numberValue(runOutput?.bestNeuralSimilarity) ??
        bestScore?.neuralSimilarity,
      bestAdjustedSimilarity:
        numberValue(runOutput?.bestAdjustedSimilarity) ??
        bestScore?.adjustedSimilarity,
      stopReason: stringValue(runOutput?.stopReason),
      selectedAgentId,
      targetNodeId,
      seedNodeId,
      bestNodeId: bestNode?.id,
      tags: tagsForRun(runId, inputType, outputType, Boolean(seedNodeId)),
    };
    runs.push(run);
    nodes.push({
      id: targetNodeId,
      runId,
      role: "target",
      modality: inputType,
      label: "Target",
      media:
        mediaFromRendered(targetRender?.output, "target") ??
        mediaFromNodeSummary(inputNode, "target"),
    });
    if (seedNodeId) {
      nodes.push({
        id: seedNodeId,
        runId,
        role: "seed",
        modality: stringValue(objectValue(seedRender?.output)?.kind) ?? "text",
        label: "Seed",
        subtitle: "content constraint",
        media:
          mediaFromRendered(seedRender?.output, "seed") ?? seedMedia(runInput),
      });
      edges.push({
        id: `${seedNodeId}->${targetNodeId}`,
        source: seedNodeId,
        target: targetNodeId,
        kind: "seed",
        label: "steers",
      });
    }
    nodes.push(...candidateNodes);
    for (const candidate of candidateNodes) {
      edges.push({
        id: `${targetNodeId}->${candidate.id}`,
        source: targetNodeId,
        target: candidate.id,
        kind: "target",
        label: "scores",
      });
      if (seedNodeId) {
        edges.push({
          id: `${seedNodeId}->${candidate.id}`,
          source: seedNodeId,
          target: candidate.id,
          kind: "seed",
          label: "constrains",
        });
      }
    }
    const judges = buildJudgeNodes({ calls: runCalls, runId });
    nodes.push(...judges);
    for (const judge of judges) {
      for (const candidate of candidateNodes.filter(
        (node) => node.iteration === judge.iteration,
      )) {
        edges.push({
          id: `${candidate.id}->${judge.id}`,
          source: candidate.id,
          target: judge.id,
          kind: candidate.selected ? "selection" : "candidate",
          label: candidate.selected ? "selected" : undefined,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "weave",
    sourceDetail: project,
    stats: {
      runCount: runs.length,
      completedRunCount: runs.filter((run) => run.status === "completed")
        .length,
      edgeCount: edges.length,
      imageNodeCount: nodes.filter((node) => node.media?.kind === "image")
        .length,
      nodeCount: nodes.length,
      textNodeCount: nodes.filter((node) => node.media?.kind === "text").length,
    },
    runs,
    nodes,
    edges,
  };
}

function buildCandidateNodes(args: {
  calls: WeaveCall[];
  runId: string;
  selectedAgentId?: string;
}): TraceNode[] {
  const generateByAgent = new Map<string, WeaveCall>();
  const renderByAgent = new Map<string, WeaveCall>();
  const scoreByAgent = new Map<string, WeaveCall>();
  for (const call of args.calls) {
    const agentId = stringValue(deepFind(call.attributes, "agentId"));
    if (!agentId || agentId === "judge") {
      continue;
    }
    const key = `${numberValue(deepFind(call.attributes, "iteration")) ?? 1}:${agentId}`;
    if (opName(call) === "candidate.generate") {
      generateByAgent.set(key, call);
    } else if (opName(call) === "candidate.render") {
      renderByAgent.set(key, call);
    } else if (opName(call) === "candidate.score") {
      scoreByAgent.set(key, call);
    }
  }
  const keys = [...new Set([...renderByAgent.keys(), ...scoreByAgent.keys()])];
  return keys
    .map((key) => {
      const [iterationText, agentId] = key.split(":");
      const iteration = Number(iterationText) || 1;
      const render = renderByAgent.get(key);
      const scoreCall = scoreByAgent.get(key);
      const generate = generateByAgent.get(key);
      const score = compactScore(scoreCall?.output);
      return {
        id: `${args.runId}:candidate:i${iteration}:${agentId}`,
        runId: args.runId,
        role: "candidate" as const,
        modality: "candidate",
        label: agentId,
        subtitle: strategyName(
          stringValue(deepFind(render?.inputs, "entropy")) ??
            stringValue(deepFind(generate?.inputs, "entropy")),
        ),
        iteration,
        agentId,
        selected: agentId === args.selectedAgentId,
        media: mediaFromRendered(render?.output, agentId),
        score,
        entropy:
          stringValue(deepFind(render?.inputs, "entropy")) ??
          stringValue(deepFind(generate?.inputs, "entropy")),
      };
    })
    .sort(
      (left, right) =>
        (right.score?.total ?? -Infinity) - (left.score?.total ?? -Infinity),
    )
    .map((node, index) => ({ ...node, rank: index + 1 }));
}

function buildJudgeNodes(args: {
  calls: WeaveCall[];
  runId: string;
}): TraceNode[] {
  return args.calls
    .filter((call) => opName(call) === "judge.select")
    .sort((left, right) => left.started_at.localeCompare(right.started_at))
    .map((call) => {
      const iteration =
        numberValue(deepFind(call.attributes, "iteration")) ?? 1;
      const output = objectValue(call.output);
      return {
        id: `${args.runId}:judge:i${iteration}`,
        runId: args.runId,
        role: "judge" as const,
        modality: "text",
        label: `Iteration ${iteration}`,
        iteration,
        media: {
          kind: "text" as const,
          text:
            stringValue(output?.reasoning) ??
            stringValue(call.exception) ??
            "No judge reasoning captured.",
        },
      };
    });
}

function groupCallsByRunId(calls: WeaveCall[]): Map<string, WeaveCall[]> {
  const grouped = new Map<string, WeaveCall[]>();
  for (const call of calls) {
    const runId =
      stringValue(deepFind(call.attributes, "runId")) ??
      stringValue(deepFind(call.inputs, "runId")) ??
      stringValue(deepFind(call.output, "runId"));
    if (!runId) {
      continue;
    }
    grouped.set(runId, [...(grouped.get(runId) ?? []), call]);
  }
  return grouped;
}

function latestCall(calls: WeaveCall[], name: string): WeaveCall | undefined {
  return calls
    .filter((call) => opName(call) === name)
    .sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
}

function compactScore(value: unknown): TraceScore | undefined {
  const source = objectValue(value);
  if (!source) {
    return undefined;
  }
  const score: TraceScore = {
    total: numberValue(source.total),
    neuralSimilarity: numberValue(source.neuralSimilarity),
    adjustedSimilarity: numberValue(source.adjustedSimilarity),
    calibratedSimilarity: numberValue(source.calibratedSimilarity),
    contrastSimilarity: numberValue(source.contrastSimilarity),
    targetSpecificity: numberValue(source.targetSpecificity),
    seedAdherence: numberValue(source.seedAdherence),
    seedSimilarity: numberValue(source.seedSimilarity),
    seedTargetSimilarity: numberValue(source.seedTargetSimilarity),
    seedSpecificity: numberValue(source.seedSpecificity),
    seedPromptAdherence: numberValue(source.seedPromptAdherence),
    seedPromptPenalty: numberValue(source.seedPromptPenalty),
    penalty: numberValue(source.penalty),
  };
  return Object.values(score).some((item) => item !== undefined)
    ? score
    : undefined;
}

function mediaFromRendered(
  value: unknown,
  alt: string,
): TraceMedia | undefined {
  const rendered = objectValue(value);
  const preview = stringValue(rendered?.preview);
  if (preview) {
    return localImagePath(preview)
      ? { kind: "image", path: preview, alt }
      : { kind: "text", text: preview };
  }
  const source = objectValue(objectValue(rendered?.artifact)?.source);
  const uri = stringValue(source?.uri);
  return uri && localImagePath(uri)
    ? { kind: "image", path: uri, alt }
    : undefined;
}

function mediaFromNodeSummary(
  value: unknown,
  alt: string,
): TraceMedia | undefined {
  const source = objectValue(objectValue(value)?.source);
  const uri = stringValue(source?.uri);
  if (uri && localImagePath(uri)) {
    return { kind: "image", path: uri, alt };
  }
  const text = stringValue(objectValue(value)?.textPreview);
  return text ? { kind: "text", text } : undefined;
}

function seedMedia(
  runInput: Record<string, unknown> | undefined,
): TraceMedia | undefined {
  const seed = seedInput(runInput);
  const nodeMedia = mediaFromNodeSummary(seed?.node, "seed");
  if (nodeMedia) {
    return nodeMedia;
  }
  const text = stringValue(seed?.promptPreview) ?? stringValue(seed?.prompt);
  return text ? { kind: "text", text } : undefined;
}

function seedPrompt(
  runInput: Record<string, unknown> | undefined,
): string | undefined {
  const seed = seedInput(runInput);
  return stringValue(seed?.promptPreview) ?? stringValue(seed?.prompt);
}

function seedInput(runInput: Record<string, unknown> | undefined) {
  return objectValue(runInput?.seed);
}

function unwrapInput(value: unknown): Record<string, unknown> | undefined {
  const root = objectValue(value);
  if (!root) {
    return undefined;
  }
  return (
    objectValue(root._input) ??
    objectValue(root.input) ??
    objectValue(root.arg0) ??
    root
  );
}

function opName(call: WeaveCall): string {
  const raw = call.display_name ?? call.op_name;
  const opSegment = raw.includes("/op/") ? raw.split("/op/")[1] : raw;
  return (opSegment ?? raw).split(":")[0] ?? raw;
}

function iterationCount(calls: WeaveCall[]): number {
  const iterations = calls
    .map((call) => numberValue(deepFind(call.attributes, "iteration")))
    .filter((value): value is number => value !== undefined);
  return iterations.length > 0 ? Math.max(...iterations) : 0;
}

function deepFind(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (key in value) {
    return (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value)) {
    const found = deepFind(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function localImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path) && path.startsWith("/");
}

function strategyName(entropy: string | undefined): string | undefined {
  return entropy?.match(/strategy=([^|]+)/)?.[1]?.trim();
}

function tagsForRun(
  runId: string,
  inputType: string,
  outputType: string,
  seeded: boolean,
): string[] {
  const idTags = runId
    .split(/[-_]/)
    .filter((part) => part.length > 2 && !/^[a-f0-9]{6,}$/i.test(part));
  return [
    ...new Set(
      [inputType, outputType, seeded ? "seeded" : "", ...idTags].filter(
        Boolean,
      ),
    ),
  ];
}

function snapshotPath(): string {
  return join(repoRoot(), ".agent", "traces", "volta-run-traces.json");
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/apps/web") ? resolve(cwd, "../..") : cwd;
}

function weaveProject(): string | undefined {
  return process.env.VOLTA_WEAVE_PROJECT ?? process.env.WEAVE_PROJECT;
}

function integerFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

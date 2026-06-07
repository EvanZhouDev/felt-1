"use client";

import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";

type TraceGraph = {
  generatedAt: string;
  stats: TraceStats;
  runs: TraceRun[];
  nodes: TraceNode[];
  edges: TraceEdge[];
};

type TraceStats = {
  runCount: number;
  completedRunCount: number;
  nodeCount: number;
  edgeCount: number;
  imageNodeCount: number;
  textNodeCount: number;
};

type TraceRun = {
  id: string;
  status: string;
  createdAt?: string;
  inputType: string;
  outputType: string;
  seedPrompt?: string;
  runPath: string;
  runJsonSha256: string;
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

type FlowTraceData = {
  trace: TraceNode;
  isActive: boolean;
  onOpen: (nodeId: string) => void;
} & Record<string, unknown>;

type TraceFlowNode = Node<FlowTraceData, "traceCard">;

const nodeTypes = {
  traceCard: TraceNodeCard,
};

export function TraceExplorer({ initialGraph }: { initialGraph?: TraceGraph }) {
  const [graph, setGraph] = useState<TraceGraph | undefined>(initialGraph);
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | undefined>(
    initialGraph?.runs[0]?.id,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(
    initialGraph?.runs[0]?.bestNodeId ?? initialGraph?.runs[0]?.targetNodeId,
  );

  useEffect(() => {
    if (initialGraph) {
      return;
    }
    let cancelled = false;
    fetch("/api/traces", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Trace API returned ${response.status}`);
        }
        return (await response.json()) as TraceGraph;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setGraph(payload);
        const firstRun = payload.runs[0];
        setActiveRunId(firstRun?.id);
        setSelectedNodeId(firstRun?.bestNodeId ?? firstRun?.targetNodeId);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialGraph]);

  const filteredRuns = useMemo(() => {
    if (!graph) {
      return [];
    }
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return graph.runs;
    }
    return graph.runs.filter((run) =>
      [run.id, run.inputType, run.outputType, run.seedPrompt, ...run.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [graph, query]);

  const activeRun = useMemo(
    () => graph?.runs.find((run) => run.id === activeRunId) ?? filteredRuns[0],
    [activeRunId, filteredRuns, graph],
  );

  const traceNodes = useMemo(
    () =>
      activeRun && graph
        ? graph.nodes.filter((node) => node.runId === activeRun.id)
        : [],
    [activeRun, graph],
  );
  const traceNodeIds = useMemo(
    () => new Set(traceNodes.map((node) => node.id)),
    [traceNodes],
  );
  const traceEdges = useMemo(
    () =>
      graph
        ? graph.edges.filter(
            (edge) =>
              traceNodeIds.has(edge.source) && traceNodeIds.has(edge.target),
          )
        : [],
    [graph, traceNodeIds],
  );

  const selectedTraceNode = useMemo(
    () =>
      traceNodes.find((node) => node.id === selectedNodeId) ??
      traceNodes.find((node) => node.id === activeRun?.bestNodeId) ??
      traceNodes[0],
    [activeRun, selectedNodeId, traceNodes],
  );

  const openNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const flowNodes = useMemo(
    () => layoutNodes(traceNodes, selectedTraceNode?.id, openNode),
    [openNode, selectedTraceNode, traceNodes],
  );
  const flowEdges = useMemo(
    () => layoutEdges(traceEdges, selectedTraceNode?.id),
    [selectedTraceNode, traceEdges],
  );

  if (error) {
    return (
      <main className="error-screen">
        <h1>Trace graph unavailable</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!graph || !activeRun) {
    return (
      <main className="loading-screen">
        <span className="loading-mark" />
        <span>Loading run traces</span>
      </main>
    );
  }

  return (
    <main className="trace-shell">
      <aside className="trace-sidebar">
        <header className="brand-block">
          <span className="eyebrow">Project Volta</span>
          <h1>Trace Graph</h1>
          <div className="stat-grid">
            <Metric label="Runs" value={graph.stats.runCount} />
            <Metric label="Images" value={graph.stats.imageNodeCount} />
            <Metric label="Nodes" value={graph.stats.nodeCount} />
            <Metric label="Edges" value={graph.stats.edgeCount} />
          </div>
        </header>

        <section className="run-controls" aria-label="Run selection">
          <label htmlFor="run-search">Search runs</label>
          <input
            id="run-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="dog, mona, flowers, text..."
          />
          <label htmlFor="run-select">Current run</label>
          <select
            id="run-select"
            value={activeRun.id}
            onChange={(event) => {
              const nextRun = graph.runs.find(
                (run) => run.id === event.currentTarget.value,
              );
              setActiveRunId(event.currentTarget.value);
              setSelectedNodeId(nextRun?.bestNodeId ?? nextRun?.targetNodeId);
            }}
          >
            {filteredRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id}
              </option>
            ))}
          </select>
        </section>

        <section className="run-list" aria-label="Recent runs">
          {filteredRuns.slice(0, 16).map((run) => (
            <button
              className={run.id === activeRun.id ? "run-row active" : "run-row"}
              key={run.id}
              onClick={() => {
                setActiveRunId(run.id);
                setSelectedNodeId(run.bestNodeId ?? run.targetNodeId);
              }}
              type="button"
            >
              <span>{compactRunName(run.id)}</span>
              <strong>{scoreText(run.bestAdjustedSimilarity)}</strong>
            </button>
          ))}
        </section>
      </aside>

      <section className="graph-stage">
        <div className="run-header">
          <div>
            <span className="eyebrow">
              {activeRun.inputType} to {activeRun.outputType}
            </span>
            <h2>{activeRun.id}</h2>
          </div>
          <div className="score-strip">
            <Metric
              label="Adjusted"
              value={scoreText(activeRun.bestAdjustedSimilarity)}
            />
            <Metric
              label="Neural"
              value={scoreText(activeRun.bestNeuralSimilarity)}
            />
            <Metric label="Total" value={scoreText(activeRun.bestScore)} />
            <Metric label="Turns" value={activeRun.iterationCount} />
          </div>
        </div>

        <div className="graph-canvas">
          <ReactFlow
            colorMode="light"
            edges={flowEdges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.25}
            nodeTypes={nodeTypes}
            nodes={flowNodes}
            nodesDraggable
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          >
            <Background color="#d8d5c8" gap={24} size={1} />
            <Controls position="bottom-left" />
            <MiniMap
              className="trace-minimap"
              maskColor="rgba(247, 246, 240, 0.72)"
              nodeColor={(node) => nodeColor(minimapRole(node.data))}
              pannable
              position="bottom-right"
              zoomable
            />
          </ReactFlow>
        </div>
      </section>

      <aside className="inspector">
        {selectedTraceNode ? (
          <NodeInspector node={selectedTraceNode} run={activeRun} />
        ) : (
          <p>No node selected.</p>
        )}
      </aside>
    </main>
  );
}

function TraceNodeCard({ data, selected }: NodeProps<TraceFlowNode>) {
  const node = data.trace;
  return (
    <button
      className={[
        "trace-node",
        `role-${node.role}`,
        selected || data.isActive ? "selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => data.onOpen(node.id)}
      type="button"
    >
      <Handle className="trace-handle" position={Position.Left} type="target" />
      <div className="node-topline">
        <span>{node.role}</span>
        {node.rank ? <strong>#{node.rank}</strong> : null}
      </div>
      <MediaBlock media={node.media} compact />
      <div className="node-copy">
        <h3>{node.label}</h3>
        {node.subtitle ? <p>{node.subtitle}</p> : null}
      </div>
      {node.score ? (
        <div className="node-scores">
          <span>n {scoreText(node.score.neuralSimilarity)}</span>
          <span>a {scoreText(node.score.adjustedSimilarity)}</span>
          <span>t {scoreText(node.score.total)}</span>
        </div>
      ) : null}
      <Handle
        className="trace-handle"
        position={Position.Right}
        type="source"
      />
    </button>
  );
}

function NodeInspector({ node, run }: { node: TraceNode; run: TraceRun }) {
  return (
    <div className="inspector-content">
      <div>
        <span className="eyebrow">{node.role}</span>
        <h2>{node.label}</h2>
        {node.subtitle ? <p className="muted">{node.subtitle}</p> : null}
      </div>
      <MediaBlock media={node.media} />
      {node.score ? (
        <div className="score-table">
          <Metric
            label="Raw neural"
            value={scoreText(node.score.neuralSimilarity)}
          />
          <Metric
            label="Adjusted"
            value={scoreText(node.score.adjustedSimilarity)}
          />
          <Metric label="Total" value={scoreText(node.score.total)} />
          <Metric
            label="Seed diag"
            value={scoreText(node.score.seedSimilarity)}
          />
          <Metric
            label="Specificity"
            value={scoreText(node.score.targetSpecificity)}
          />
          <Metric
            label="Contrast"
            value={scoreText(node.score.contrastSimilarity)}
          />
        </div>
      ) : null}
      {node.entropy ? (
        <section className="detail-block">
          <h3>Operator</h3>
          <p>{node.entropy}</p>
        </section>
      ) : null}
      {run.seedPrompt ? (
        <section className="detail-block">
          <h3>Seed</h3>
          <p>{run.seedPrompt}</p>
        </section>
      ) : null}
      <section className="detail-block">
        <h3>Trace</h3>
        <p>{run.runPath}</p>
        <p className="checksum">{run.runJsonSha256.slice(0, 16)}</p>
      </section>
    </div>
  );
}

function MediaBlock({
  compact = false,
  media,
}: {
  compact?: boolean;
  media?: TraceMedia;
}) {
  if (!media) {
    return <div className={compact ? "media-empty compact" : "media-empty"} />;
  }
  if (media.kind === "image") {
    return (
      <div className={compact ? "media-frame compact" : "media-frame"}>
        <Image
          alt={media.alt}
          fill
          sizes={compact ? "286px" : "360px"}
          src={mediaUrl(media.path)}
          style={{ objectFit: "contain" }}
          unoptimized
        />
      </div>
    );
  }
  return (
    <div className={compact ? "text-media compact" : "text-media"}>
      {compact ? truncate(media.text, 148) : media.text}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function layoutNodes(
  nodes: TraceNode[],
  activeNodeId: string | undefined,
  onOpen: (nodeId: string) => void,
): TraceFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "traceCard",
    position: nodePosition(node),
    style: { visibility: "visible" },
    data: {
      trace: node,
      isActive: node.id === activeNodeId,
      onOpen,
    },
  }));
}

function nodePosition(node: TraceNode): { x: number; y: number } {
  if (node.role === "target") {
    return { x: 40, y: 150 };
  }
  if (node.role === "seed") {
    return { x: 40, y: 430 };
  }
  if (node.role === "judge") {
    const iteration = node.iteration ?? 1;
    return { x: 460 + iteration * 430, y: 140 + (iteration - 1) * 90 };
  }
  const iteration = node.iteration ?? 1;
  const rank = node.rank ?? 1;
  return {
    x: 430 + (iteration - 1) * 430,
    y: 34 + (rank - 1) * 238,
  };
}

function layoutEdges(
  edges: TraceEdge[],
  activeNodeId: string | undefined,
): Edge[] {
  return edges.map((edge) => {
    const active = edge.source === activeNodeId || edge.target === activeNodeId;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: active ? edge.label : undefined,
      animated: edge.kind === "selection",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeColor(edge.kind, active),
      },
      style: {
        stroke: edgeColor(edge.kind, active),
        strokeWidth: active || edge.kind === "selection" ? 3 : 1.5,
      },
    };
  });
}

function mediaUrl(path: string): string {
  return `/api/trace-media?path=${encodeURIComponent(path)}`;
}

function scoreText(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

function compactRunName(id: string): string {
  return id.length > 42 ? `${id.slice(0, 39)}...` : id;
}

function minimapRole(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const trace = (data as { trace?: unknown }).trace;
  if (!trace || typeof trace !== "object") {
    return "";
  }
  return String((trace as { role?: unknown }).role ?? "");
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function nodeColor(role: string): string {
  if (role === "target") {
    return "#356f86";
  }
  if (role === "seed") {
    return "#9d6b22";
  }
  if (role === "judge") {
    return "#6f5a9d";
  }
  return "#2f7d5b";
}

function edgeColor(kind: TraceEdge["kind"], active: boolean): string {
  if (active) {
    return "#1f2937";
  }
  if (kind === "selection") {
    return "#1f8a5b";
  }
  if (kind === "seed") {
    return "#b57720";
  }
  if (kind === "target") {
    return "#2e6f88";
  }
  return "#928d80";
}

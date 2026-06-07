"use client";

import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  TraceEdge,
  TraceGraph,
  TraceMedia,
  TraceNode,
  TraceRun,
} from "./trace-data";

type FlowTraceData = {
  trace: TraceNode;
  isActive: boolean;
  onSelect: (nodeId: string) => void;
} & Record<string, unknown>;

type TraceFlowNode = Node<FlowTraceData, "traceCard">;

const nodeTypes = {
  traceCard: TraceNodeCard,
};

type TraceExplorerProps = {
  initialGraph?: TraceGraph;
  initialNodeId?: string;
  initialQuery?: string;
  initialRunId?: string;
};

export function TraceExplorer({
  initialGraph,
  initialNodeId,
  initialQuery = "",
  initialRunId,
}: TraceExplorerProps) {
  const initialRun =
    initialGraph?.runs.find((run) => run.id === initialRunId) ??
    initialGraph?.runs[0];
  const [graph, setGraph] = useState<TraceGraph | undefined>(initialGraph);
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState(initialQuery);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(
    initialRun?.id,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(
    initialNodeId ?? initialRun?.bestNodeId ?? initialRun?.targetNodeId,
  );

  useEffect(() => {
    document.documentElement.dataset.voltaTraceExplorer = "hydrated";
    return () => {
      delete document.documentElement.dataset.voltaTraceExplorer;
    };
  }, []);

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

  useEffect(() => {
    if (!graph || filteredRuns.length === 0) {
      return;
    }
    if (activeRunId && filteredRuns.some((run) => run.id === activeRunId)) {
      return;
    }
    const nextRun = filteredRuns[0];
    setActiveRunId(nextRun.id);
    setSelectedNodeId(nextRun.bestNodeId ?? nextRun.targetNodeId);
  }, [activeRunId, filteredRuns, graph]);

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

  const selectRun = useCallback(
    (runId: string) => {
      const nextRun = graph?.runs.find((run) => run.id === runId);
      if (!nextRun) {
        return;
      }
      setActiveRunId(nextRun.id);
      setSelectedNodeId(nextRun.bestNodeId ?? nextRun.targetNodeId);
    },
    [graph],
  );

  const selectTraceNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const selectFlowNode = useCallback<NodeMouseHandler>(
    (_, node) => {
      selectTraceNode(node.id);
    },
    [selectTraceNode],
  );

  const flowNodes = useMemo(
    () => layoutNodes(traceNodes, selectedTraceNode?.id, selectTraceNode),
    [selectTraceNode, selectedTraceNode, traceNodes],
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
            <Metric label="Text" value={graph.stats.textNodeCount ?? "n/a"} />
            <Metric label="Backend" value={graph.source} />
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
            onChange={(event) => selectRun(event.currentTarget.value)}
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
              onClick={() => selectRun(run.id)}
              type="button"
            >
              <span className="run-row-copy">
                <span>{compactRunName(run.id)}</span>
                <em>
                  {run.inputType} to {run.outputType}
                  {run.candidateCount
                    ? ` - ${run.candidateCount} candidates`
                    : ""}
                </em>
              </span>
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
            <Metric
              label="Candidates"
              value={activeRun.candidateCount ?? traceNodes.length}
            />
          </div>
        </div>

        <div className="graph-canvas">
          <ReactFlow
            colorMode="light"
            edges={flowEdges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            key={activeRun.id}
            minZoom={0.25}
            nodeTypes={nodeTypes}
            nodes={flowNodes}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeClick={selectFlowNode}
            panOnDrag
            panOnScroll
            proOptions={{ hideAttribution: true }}
            selectionOnDrag={false}
            zoomOnDoubleClick
            zoomOnPinch
            zoomOnScroll
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
  const selectNode = () => data.onSelect(node.id);
  return (
    <button
      className={[
        "nodrag",
        "nopan",
        "trace-node",
        `role-${node.role}`,
        selected || data.isActive ? "selected" : "",
        node.selected ? "winner" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={data.isActive}
      data-trace-node-id={node.id}
      onClick={(event) => {
        event.stopPropagation();
        selectNode();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        selectNode();
      }}
      type="button"
    >
      <Handle className="trace-handle" position={Position.Left} type="target" />
      <div className="node-topline">
        <span>{node.role}</span>
        <strong>
          {node.selected ? "selected" : node.rank ? `#${node.rank}` : ""}
        </strong>
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
        <p>{run.runPath || "Weave trace backend"}</p>
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
  onSelect: (nodeId: string) => void,
): TraceFlowNode[] {
  const candidateCountsByIteration = new Map<number, number>();
  for (const node of nodes) {
    if (node.role !== "candidate") {
      continue;
    }
    const iteration = node.iteration ?? 1;
    candidateCountsByIteration.set(
      iteration,
      (candidateCountsByIteration.get(iteration) ?? 0) + 1,
    );
  }

  return nodes.map((node) => ({
    id: node.id,
    type: "traceCard",
    position: nodePosition(node, candidateCountsByIteration),
    style: { visibility: "visible" },
    data: {
      trace: node,
      isActive: node.id === activeNodeId,
      onSelect,
    },
  }));
}

const candidateColumnX = 500;
const candidateColumnGap = 620;
const candidateRowY = 48;
const candidateRowGap = 350;
const judgeOffsetX = 440;

function nodePosition(
  node: TraceNode,
  candidateCountsByIteration: Map<number, number>,
): { x: number; y: number } {
  if (node.role === "target") {
    return { x: 40, y: 190 };
  }
  if (node.role === "seed") {
    return { x: 40, y: 560 };
  }
  const iteration = node.iteration ?? 1;
  const iterationX = candidateColumnX + (iteration - 1) * candidateColumnGap;
  if (node.role === "judge") {
    const candidateCount = candidateCountsByIteration.get(iteration) ?? 1;
    const centerY =
      candidateRowY + Math.max(0, candidateCount - 1) * candidateRowGap * 0.5;
    return { x: iterationX + judgeOffsetX, y: centerY };
  }
  const rank = node.rank ?? 1;
  return {
    x: iterationX,
    y: candidateRowY + (rank - 1) * candidateRowGap,
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
      type: "smoothstep",
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

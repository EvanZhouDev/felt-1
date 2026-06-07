import Image from "next/image";
import {
  loadTraceGraph,
  type TraceEdge,
  type TraceMedia,
  type TraceNode,
  type TraceRun,
} from "./trace-data";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const nodeWidth = 286;
const fallbackNodeHeight = 270;

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const graph = await loadTraceGraph();
  const query = paramValue(params?.q).trim().toLowerCase();
  const filteredRuns = filterRuns(graph.runs, query);
  const activeRun =
    filteredRuns.find((run) => run.id === paramValue(params?.run)) ??
    filteredRuns[0] ??
    graph.runs[0];
  const nodes = graph.nodes.filter((node) => node.runId === activeRun.id);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  const selectedNode =
    nodes.find((node) => node.id === paramValue(params?.node)) ??
    nodes.find((node) => node.id === activeRun.bestNodeId) ??
    nodes[0];
  const candidateNodes = candidateRanking(nodes);
  const positionedNodes = nodes.map((node) => ({
    node,
    position: nodePosition(node),
  }));
  const bounds = graphBounds(positionedNodes);

  return (
    <main className="trace-shell">
      <aside className="trace-sidebar">
        <header className="brand-block">
          <span className="eyebrow">Project Volta</span>
          <h1>Trace Graph</h1>
          <div className="stat-grid">
            <Metric label="Runs" value={graph.stats.runCount} />
            <Metric
              label="Done"
              value={graph.stats.completedRunCount ?? "n/a"}
            />
            <Metric label="Images" value={graph.stats.imageNodeCount} />
            <Metric label="Text" value={graph.stats.textNodeCount ?? "n/a"} />
            <Metric label="Backend" value={graph.source} />
          </div>
        </header>

        <form className="run-controls" method="get">
          <label htmlFor="run-search">Search runs</label>
          <input
            defaultValue={paramValue(params?.q)}
            id="run-search"
            name="q"
            placeholder="dog, mona, flowers, text..."
          />
          <label htmlFor="run-select">Current run</label>
          <select defaultValue={activeRun.id} id="run-select" name="run">
            {filteredRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id}
              </option>
            ))}
          </select>
          <button className="run-submit" type="submit">
            Open run
          </button>
        </form>

        <section className="run-list" aria-label="Recent runs">
          {filteredRuns.slice(0, 20).map((run) => (
            <a
              className={run.id === activeRun.id ? "run-row active" : "run-row"}
              href={pageHref({ q: query, run: run.id })}
              key={run.id}
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
            </a>
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
              value={activeRun.candidateCount ?? candidateNodes.length}
            />
          </div>
        </div>

        <nav className="graph-nav" aria-label="Graph nodes">
          {positionedNodes.map(({ node }) => (
            <a
              className={node.id === selectedNode?.id ? "active" : undefined}
              href={`${pageHref({
                node: node.id,
                q: query,
                run: activeRun.id,
              })}#${nodeDomId(node.id)}`}
              key={node.id}
            >
              {node.role}
              {node.rank ? ` #${node.rank}` : ""}
            </a>
          ))}
        </nav>

        <div className="static-graph-scroll">
          <div
            className="static-graph-spacer"
            style={{ height: bounds.height, width: bounds.width }}
          >
            <div
              className="static-graph-world"
              style={{ height: bounds.height, width: bounds.width }}
            >
              <svg
                aria-hidden="true"
                className="static-edges"
                height={bounds.height}
                width={bounds.width}
              >
                <defs>
                  <marker
                    id="arrow"
                    markerHeight="8"
                    markerWidth="8"
                    orient="auto-start-reverse"
                    refX="7"
                    refY="4"
                    viewBox="0 0 8 8"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
                  </marker>
                </defs>
                {edges.map((edge) => (
                  <StaticEdge
                    activeNodeId={selectedNode?.id}
                    edge={edge}
                    key={edge.id}
                    positions={positionedNodes}
                  />
                ))}
              </svg>

              {positionedNodes.map(({ node, position }) => (
                <a
                  className={[
                    "static-node",
                    "trace-node",
                    `role-${node.role}`,
                    node.id === selectedNode?.id ? "selected" : "",
                    node.selected ? "winner" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  id={nodeDomId(node.id)}
                  href={`${pageHref({
                    node: node.id,
                    q: query,
                    run: activeRun.id,
                  })}#${nodeDomId(node.id)}`}
                  key={node.id}
                  style={{ left: position.x, top: position.y }}
                >
                  <div className="node-topline">
                    <span>{node.role}</span>
                    <strong>
                      {node.selected
                        ? "selected"
                        : node.rank
                          ? `#${node.rank}`
                          : ""}
                    </strong>
                  </div>
                  <MediaBlock compact media={node.media} />
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
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      <aside className="inspector">
        {selectedNode ? (
          <NodeInspector
            candidates={candidateNodes}
            node={selectedNode}
            query={query}
            run={activeRun}
          />
        ) : (
          <p>No node selected.</p>
        )}
      </aside>
    </main>
  );
}

function StaticEdge({
  activeNodeId,
  edge,
  positions,
}: {
  activeNodeId?: string;
  edge: TraceEdge;
  positions: { node: TraceNode; position: { x: number; y: number } }[];
}) {
  const source = positions.find(({ node }) => node.id === edge.source);
  const target = positions.find(({ node }) => node.id === edge.target);
  if (!source || !target) {
    return null;
  }
  const active = edge.source === activeNodeId || edge.target === activeNodeId;
  const x1 = source.position.x + nodeWidth;
  const y1 = source.position.y + 132;
  const x2 = target.position.x;
  const y2 = target.position.y + 132;
  const midX = Math.round((x1 + x2) / 2);
  return (
    <path
      className={`static-edge ${active ? "active" : ""} edge-${edge.kind}`}
      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
      markerEnd="url(#arrow)"
    />
  );
}

function NodeInspector({
  candidates,
  node,
  query,
  run,
}: {
  candidates: TraceNode[];
  node: TraceNode;
  query: string;
  run: TraceRun;
}) {
  return (
    <div className="inspector-content">
      <div>
        <span className="eyebrow">{node.role}</span>
        <h2>{node.label}</h2>
        {node.subtitle ? <p className="muted">{node.subtitle}</p> : null}
      </div>
      <MediaBlock media={node.media} />
      <section className="run-facts" aria-label="Run facts">
        <Metric label="Status" value={run.status ?? "unknown"} />
        <Metric label="Selected" value={run.selectedAgentId ?? "n/a"} />
        <Metric label="Stop" value={run.stopReason ?? "n/a"} />
        <Metric label="Created" value={dateText(run.createdAt)} />
      </section>
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
            value={scoreText(node.score.seedAdherence)}
          />
          <Metric
            label="Calibrated"
            value={scoreText(node.score.calibratedSimilarity)}
          />
          <Metric
            label="Specificity"
            value={scoreText(node.score.targetSpecificity)}
          />
          <Metric
            label="Contrast"
            value={scoreText(node.score.contrastSimilarity)}
          />
          <Metric
            label="Penalty"
            value={scoreText(
              node.score.penalty ?? node.score.seedPromptPenalty,
            )}
          />
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <section className="candidate-ranking">
          <h3>Candidate Ranking</h3>
          <div className="candidate-ranking-list">
            {candidates.map((candidate) => (
              <a
                className={[
                  "candidate-rank-row",
                  candidate.id === node.id ? "active" : "",
                  candidate.selected ? "winner" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                href={`${pageHref({
                  node: candidate.id,
                  q: query,
                  run: run.id,
                })}#${nodeDomId(candidate.id)}`}
                key={candidate.id}
              >
                <span className="candidate-rank-title">
                  <strong>
                    {candidate.rank ? `#${candidate.rank}` : "candidate"}
                  </strong>
                  <span>{candidate.label}</span>
                  {candidate.selected ? <em>selected</em> : null}
                </span>
                <span className="candidate-score-bars">
                  <ScoreBar
                    label="total"
                    value={candidate.score?.total}
                    winner={candidate.selected}
                  />
                  <ScoreBar
                    label="adj"
                    value={candidate.score?.adjustedSimilarity}
                  />
                  <ScoreBar
                    label="raw"
                    value={candidate.score?.neuralSimilarity}
                  />
                </span>
              </a>
            ))}
          </div>
        </section>
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

function ScoreBar({
  label,
  value,
  winner = false,
}: {
  label: string;
  value?: number;
  winner?: boolean;
}) {
  const width = value === undefined ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="score-bar-row">
      <span>{label}</span>
      <span className={winner ? "score-bar winner" : "score-bar"}>
        <span style={{ width: `${width}%` }} />
      </span>
      <strong>{scoreText(value)}</strong>
    </span>
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

function filterRuns(runs: TraceRun[], query: string): TraceRun[] {
  if (!query) {
    return runs;
  }
  return runs.filter((run) =>
    [run.id, run.inputType, run.outputType, run.seedPrompt, ...run.tags]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

function candidateRanking(nodes: TraceNode[]): TraceNode[] {
  return nodes
    .filter((node) => node.role === "candidate")
    .sort((left, right) => {
      const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return (
        (right.score?.total ?? -Infinity) - (left.score?.total ?? -Infinity)
      );
    });
}

function nodePosition(node: TraceNode): { x: number; y: number } {
  if (node.role === "target") {
    return { x: 40, y: 180 };
  }
  if (node.role === "seed") {
    return { x: 40, y: 520 };
  }
  if (node.role === "judge") {
    const iteration = node.iteration ?? 1;
    return { x: 500 + iteration * 500, y: 170 + (iteration - 1) * 120 };
  }
  const iteration = node.iteration ?? 1;
  const rank = node.rank ?? 1;
  return {
    x: 460 + (iteration - 1) * 500,
    y: 40 + (rank - 1) * 340,
  };
}

function graphBounds(nodes: { position: { x: number; y: number } }[]): {
  height: number;
  width: number;
} {
  const width =
    Math.max(...nodes.map(({ position }) => position.x), 900) + nodeWidth + 120;
  const height =
    Math.max(...nodes.map(({ position }) => position.y), 640) +
    fallbackNodeHeight +
    120;
  return { height, width };
}

function mediaUrl(path: string): string {
  return `/api/trace-media?path=${encodeURIComponent(path)}`;
}

function pageHref({
  node,
  q,
  run,
}: {
  node?: string;
  q?: string;
  run: string;
}): string {
  const params = new URLSearchParams({ run });
  if (node) {
    params.set("node", node);
  }
  if (q) {
    params.set("q", q);
  }
  return `/?${params.toString()}`;
}

function nodeDomId(id: string): string {
  return `node-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function scoreText(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

function dateText(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function compactRunName(id: string): string {
  return id.length > 42 ? `${id.slice(0, 39)}...` : id;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

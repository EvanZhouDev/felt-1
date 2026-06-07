import type {
  ActivationTrace,
  AgentOutput,
  EvaluatedOutput,
  InputObj,
  JudgeDecision,
  NextIterationSeed,
  OutputObj,
  RenderedStimulus,
  ScoreBundle,
} from "@volta/core";
import type { WeaveConfig } from "./config.ts";

type TraceInput = Record<string, unknown>;

type TraceArgs<T> = {
  name: string;
  input: TraceInput;
  attributes?: TraceInput;
  run: () => Promise<T>;
  output?: (value: T) => unknown;
};

export type EvolutionJournal = {
  enabled: boolean;
  dashboardUrl?: string;
  trace<T>(args: TraceArgs<T>): Promise<T>;
};

type WeaveModule = {
  init(project: string): Promise<unknown>;
  op<T extends (input: TraceInput) => Promise<unknown>>(
    fn: T,
    options?: {
      name?: string;
    },
  ): T;
  withAttributes?<T>(
    attributes: TraceInput,
    fn: () => Promise<T>,
  ): Promise<T> | T;
};

export function createEvolutionJournal(config: WeaveConfig): EvolutionJournal {
  if (!config.enabled) {
    return new NoopEvolutionJournal();
  }
  if (!config.project) {
    throw new Error(
      "VOLTA_WEAVE_PROJECT is required when VOLTA_WEAVE_ENABLED=true.",
    );
  }
  return new WeaveEvolutionJournal(config);
}

export function runSummary(args: {
  runId: string;
  input: InputObj;
  output: OutputObj;
  loop: {
    maxIterations: number;
    similarityThreshold: number;
    candidateCount: number;
    scoringConcurrency: number;
    reuseTargetArchive: boolean;
    textMicroMutations: number;
    imageSeedMutations: number;
    imageLocalMutations: number;
    textProbeCount: number;
    textProbeRecombinations: number;
    textProbeLocalMutations: number;
    contrastTargetRoots: string[];
  };
}) {
  return {
    runId: args.runId,
    inputNode: summarizeNode(args.input.inputNode, false),
    seed: summarizeSeed(args.input.seed),
    output: args.output,
    loop: args.loop,
  };
}

export function targetSummary(args: {
  rendered: RenderedStimulus;
  activation: ActivationTrace;
}) {
  return {
    rendered: summarizeRendered(args.rendered),
    activation: summarizeActivation(args.activation),
  };
}

export function candidateSummary(output: AgentOutput) {
  return {
    agentId: output.agentId,
    entropy: output.entropy,
    outputNode: summarizeNode(output.outputNode, false),
  };
}

export function evaluatedOutputSummary(output: EvaluatedOutput) {
  return {
    agentId: output.agentId,
    entropy: output.entropy,
    outputNode: summarizeNode(output.outputNode, false),
    rendered: summarizeRendered(output.rendered),
    activation: summarizeActivation(output.activation),
    score: output.score,
  };
}

export function iterationSummary(args: {
  iteration: number;
  previous: NextIterationSeed;
  rankedOutputs: EvaluatedOutput[];
  judge: JudgeDecision;
  nextSeed: NextIterationSeed;
  stopReason?: string;
}) {
  return {
    iteration: args.iteration,
    previous: summarizeNextSeed(args.previous),
    rankings: args.rankedOutputs.map(evaluatedOutputSummary),
    judge: args.judge,
    nextSeed: summarizeNextSeed(args.nextSeed),
    stopReason: args.stopReason,
  };
}

export function scoreSummary(score: ScoreBundle) {
  return {
    neuralSimilarity: score.neuralSimilarity,
    adjustedSimilarity: score.adjustedSimilarity,
    calibratedSimilarity: score.calibratedSimilarity,
    contrastSimilarity: score.contrastSimilarity,
    discriminativeSimilarity: score.discriminativeSimilarity,
    residualSimilarity: score.residualSimilarity,
    residualAdjustedSimilarity: score.residualAdjustedSimilarity,
    retrievalMargin: score.retrievalMargin,
    cslsSimilarity: score.cslsSimilarity,
    hubnessPenalty: score.hubnessPenalty,
    searchProgressSignal: score.searchProgressSignal,
    calibrationTargetCount: score.calibrationTargetCount,
    calibrationVertexCount: score.calibrationVertexCount,
    targetSpecificity: score.targetSpecificity,
    penalty: score.penalty,
    seedAdherence: score.seedAdherence,
    coherence: score.coherence,
    diversity: score.diversity,
    total: score.total,
  };
}

export function renderedSummary(rendered: RenderedStimulus) {
  return summarizeRendered(rendered);
}

export function activationSummary(activation: ActivationTrace) {
  return summarizeActivation(activation);
}

class NoopEvolutionJournal implements EvolutionJournal {
  enabled = false;

  async trace<T>(args: TraceArgs<T>): Promise<T> {
    return args.run();
  }
}

class WeaveEvolutionJournal implements EvolutionJournal {
  enabled = true;
  dashboardUrl: string;
  private weave: Promise<WeaveModule> | undefined;
  private disabledByError = false;

  constructor(private readonly config: WeaveConfig) {
    this.dashboardUrl = buildWeaveDashboardUrl(config.project as string);
  }

  async trace<T>(args: TraceArgs<T>): Promise<T> {
    const weave = await this.getWeaveOrDisable();
    if (!weave) {
      return args.run();
    }

    let value: T | undefined;
    const op = weave.op(
      async (_input: TraceInput) => {
        value = await args.run();
        return args.output ? args.output(value) : summarizeUnknown(value);
      },
      {
        name: args.name,
      },
    );
    const input = this.sanitize(args.input);
    const runOp = () => op(input);

    if (weave.withAttributes && args.attributes) {
      await weave.withAttributes(args.attributes, runOp);
    } else {
      await runOp();
    }

    return value as T;
  }

  private async getWeave(): Promise<WeaveModule> {
    this.weave ??= import("weave").then(async (module) => {
      const weave = module as unknown as WeaveModule;
      await weave.init(this.config.project as string);
      return weave;
    });
    return this.weave;
  }

  private async getWeaveOrDisable(): Promise<WeaveModule | undefined> {
    if (this.disabledByError) {
      return undefined;
    }

    try {
      return await this.getWeave();
    } catch (error) {
      this.disabledByError = true;
      console.warn(
        `Weave tracing disabled after initialization failed: ${String(error)}`,
      );
      return undefined;
    }
  }

  private sanitize(value: TraceInput): TraceInput {
    if (this.config.capturePayloads) {
      return value;
    }
    return JSON.parse(JSON.stringify(value)) as TraceInput;
  }
}

function summarizeNode(
  node:
    | InputObj["inputNode"]
    | OutputObj["outputType"]
    | AgentOutput["outputNode"],
  capturePayloads: boolean,
) {
  if (typeof node === "string") {
    return {
      type: node,
    };
  }

  if (capturePayloads) {
    return node;
  }

  if (node.payload.type === "text") {
    return {
      type: node.type,
      textPreview: truncate(node.payload.text, 280),
      textLength: node.payload.text.length,
    };
  }

  if (node.payload.type === "audio") {
    return {
      type: node.type,
      source: node.payload.source,
      timing: node.payload.timing,
    };
  }

  if (node.payload.type === "image") {
    return {
      type: node.type,
      source: node.payload.source,
      timing: node.payload.timing,
      cachedVideo: node.payload.cachedVideo,
    };
  }

  return {
    type: node.type,
    entrypoint: node.payload.entrypoint,
    framework: node.payload.framework,
    viewport: node.payload.viewport,
    fileCount: Object.keys(node.payload.files).length,
    screenshots: node.payload.screenshots,
    stitchedScreenshot: node.payload.stitchedScreenshot,
    cachedVideo: node.payload.cachedVideo,
  };
}

function summarizeSeed(seed: InputObj["seed"]) {
  if (!seed) {
    return undefined;
  }
  return {
    promptPreview: truncate(seed.prompt, 280),
    promptLength: seed.prompt.length,
  };
}

function summarizeNextSeed(seed: NextIterationSeed) {
  if (seed.type === "fresh") {
    return seed;
  }
  return {
    type: seed.type,
    node: summarizeNode(seed.node, false),
    reasoning:
      seed.type === "selected-output-with-reasoning"
        ? truncate(seed.reasoning, 500)
        : undefined,
  };
}

function summarizeRendered(rendered: RenderedStimulus) {
  return {
    id: rendered.id,
    kind: rendered.kind,
    preview: truncate(rendered.preview, 280),
    artifact: rendered.artifact,
    sha256: rendered.sha256,
    metadata: rendered.metadata,
    eventCount: rendered.encoderInput.events.length,
  };
}

function summarizeActivation(activation: ActivationTrace) {
  return {
    model: activation.model,
    shape: activation.shape,
    artifactPath: activation.artifactPath,
    diagnostics: activation.diagnostics,
    summary: activation.summary,
  };
}

function summarizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      count: value.length,
    };
  }
  if (value && typeof value === "object") {
    return {
      keys: Object.keys(value),
    };
  }
  return value;
}

function buildWeaveDashboardUrl(project: string): string {
  return `https://wandb.ai/${project}/weave/traces`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

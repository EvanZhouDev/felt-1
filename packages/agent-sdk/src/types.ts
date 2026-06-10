import type {
  AgentOutput,
  AudioDescription,
  EvaluatedOutput,
  InputObj,
  JudgeDecision,
  OutputObj,
} from "@volta/core";

export type AgentRole = "candidate" | "judge";

export type AgentSpec =
  | {
      role: "candidate";
      id: string;
      model?: string;
      tools?: string[];
      instructions?: string;
    }
  | {
      role: "judge";
      id: string;
      model?: string;
      tools?: string[];
      instructions?: string;
    };

export type AgentWorkspace = {
  rootPath: string;
  cwd: string;
  outputPath: string;
  logsPath: string;
};

export type BaseAgentInvocation = {
  runId: string;
  iteration: number;
  input: InputObj;
  output: OutputObj;
  workspace: AgentWorkspace;
  // Perceptual description of an input the agent cannot read directly (e.g. an
  // audio target). When present it is injected into the prompt as steering
  // context; neural similarity remains the scoring signal.
  inputDescription?: AudioDescription;
};

export type CandidateAgentInvocation = BaseAgentInvocation & {
  role: "candidate";
  spec: Extract<AgentSpec, { role: "candidate" }>;
  trajectory?: TrajectoryContext;
  // Position within this round's parallel batch, so siblings can deliberately
  // diversify instead of converging on one approach.
  candidateIndex?: number;
  candidateCount?: number;
};

export type JudgeAgentInvocation = BaseAgentInvocation & {
  role: "judge";
  spec: Extract<AgentSpec, { role: "judge" }>;
  rankedOutputs: EvaluatedOutput[];
};

export type AgentInvocation = CandidateAgentInvocation | JudgeAgentInvocation;

export type AgentResult =
  | {
      role: "candidate";
      output: AgentOutput;
    }
  | {
      role: "judge";
      decision: JudgeDecision;
    };

export type AgentBackend = {
  run(invocation: AgentInvocation): Promise<AgentResult>;
};

// The optimization trajectory shown to candidate agents (OPRO-style): the
// best-scoring attempts so far, sorted ASCENDING by score so the strongest
// example sits last (closest to the generation point), plus the judge's
// critique of the current best (the Reflexion "verbal gradient"). This ranked,
// critiqued history is the entire steering mechanism — the agent infers the
// improvement direction from it.
export type TrajectoryContext = {
  bestNeuralSimilarity: number;
  critique?: string;
  entries: TrajectoryEntry[];
  // Mean activation similarity of the non-best entries to the current best,
  // in [0, 1]. High values mean past attempts collapsed onto one
  // activation-space attractor — surfaced so candidates diverge in form,
  // not just theme.
  meanCrowding?: number;
};

export type TrajectoryEntry = {
  iteration: number;
  agentId: string;
  neuralSimilarity: number;
  // How close this attempt's TRIBE activation sits to the current best's
  // (pooled cosine, [0, 1]). Near-1 with a different preview text means the
  // attempt was a new wording of the same neural point, not a new direction.
  activationSimilarityToBest?: number;
  preview: string;
};

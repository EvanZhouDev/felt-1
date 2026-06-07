import type {
  AgentOutput,
  AudioDescription,
  EvaluatedOutput,
  InputObj,
  JudgeDecision,
  NextIterationSeed,
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
  previous?: NextIterationSeed;
  entropy?: string;
  archive?: CandidateArchiveContext;
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

export type CandidateArchiveContext = {
  bestNeuralSimilarity?: number;
  top: CandidateArchivePromptItem[];
  diverse: CandidateArchivePromptItem[];
  recent: CandidateArchivePromptItem[];
  operatorStats: CandidateArchiveOperatorStat[];
  notes: string[];
};

export type CandidateArchivePromptItem = {
  iteration: number;
  agentId: string;
  entropy?: string;
  neuralSimilarity: number;
  total: number;
  behaviorKey: string;
  text?: string;
};

export type CandidateArchiveOperatorStat = {
  operator: string;
  count: number;
  bestNeuralSimilarity: number;
  meanNeuralSimilarity: number;
};

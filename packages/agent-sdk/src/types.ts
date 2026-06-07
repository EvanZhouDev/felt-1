import type {
  AgentOutput,
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
  adjustedSimilarity?: number;
  total: number;
  behaviorKey: string;
  text?: string;
};

export type CandidateArchiveOperatorStat = {
  operator: string;
  count: number;
  bestTotal: number;
  meanTotal: number;
  bestAdjustedSimilarity?: number;
  meanAdjustedSimilarity?: number;
  bestNeuralSimilarity: number;
  meanNeuralSimilarity: number;
};

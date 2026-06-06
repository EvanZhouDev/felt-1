import type {
  AgentOutput,
  InputObj,
  NextIterationSeed,
  OutputObj,
} from "../types.ts";

export type AgentContext = {
  input: InputObj;
  output: OutputObj;
  previous?: NextIterationSeed;
  entropy?: string;
};

export type GenerationAgent = (context: AgentContext) => Promise<AgentOutput>;

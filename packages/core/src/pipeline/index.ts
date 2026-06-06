import type {
  AgentOutput,
  EvaluatedOutput,
  InputObj,
  NextIterationSeed,
  OutputObj,
} from "../types.ts";

export type PipelineIterationInput = {
  input: InputObj;
  output: OutputObj;
  previous?: NextIterationSeed;
};

export type PipelineIterationResult = {
  outputs: AgentOutput[];
  evaluated: EvaluatedOutput[];
  next?: NextIterationSeed;
};

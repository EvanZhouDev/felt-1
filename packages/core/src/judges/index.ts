import type { EvaluatedOutput, InputObj, JudgeDecision } from "../types.ts";

export type JudgeContext = {
  input: InputObj;
  rankedOutputs: EvaluatedOutput[];
};

export type Judge = (context: JudgeContext) => Promise<JudgeDecision>;

import type {
  AgentBackend,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "./types.ts";

export async function runCandidateAgent(
  backend: AgentBackend,
  invocation: CandidateAgentInvocation,
) {
  const result = await backend.run(invocation);
  if (result.role !== "candidate") {
    throw new Error(`Expected candidate result from ${invocation.spec.id}.`);
  }
  return result.output;
}

export async function runJudgeAgent(
  backend: AgentBackend,
  invocation: JudgeAgentInvocation,
) {
  const result = await backend.run(invocation);
  if (result.role !== "judge") {
    throw new Error(`Expected judge result from ${invocation.spec.id}.`);
  }
  return result.decision;
}

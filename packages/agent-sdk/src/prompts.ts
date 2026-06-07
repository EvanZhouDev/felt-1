import type { AudioDescription, EvaluatedOutput } from "@volta/core";
import type {
  BaseAgentInvocation,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "./types.ts";

export function buildCandidatePrompt(
  invocation: CandidateAgentInvocation,
): string {
  if (!invocation.previous || invocation.previous.type === "fresh") {
    return buildFirstGenerationCandidatePrompt(invocation);
  }
  return buildRefinementCandidatePrompt(invocation);
}

export function buildFirstGenerationCandidatePrompt(
  invocation: CandidateAgentInvocation,
): string {
  return [
    `You are Volta candidate agent ${invocation.spec.id}.`,
    "Generate the first output candidate for a vibe-transfer run.",
    candidateSharedInstructions(invocation),
    "There is no previous selected output. Start fresh, but use the optional seed to steer content if present.",
    "Return only a JSON object matching the provided output schema.",
  ].join("\n\n");
}

export function buildRefinementCandidatePrompt(
  invocation: CandidateAgentInvocation,
): string {
  return [
    `You are Volta refinement candidate agent ${invocation.spec.id}.`,
    "Generate the next output candidate by improving on the previous selected output.",
    candidateSharedInstructions(invocation),
    `Previous seed:\n${stableJson(invocation.previous)}`,
    "Preserve what worked, fix what did not, and keep the output aimed at the target vibe. If the previous seed is written as instructions or an image-generation prompt, convert it into declarative descriptive prose before refining.",
    "Return only a JSON object matching the provided output schema.",
  ].join("\n\n");
}

export function buildJudgePrompt(invocation: JudgeAgentInvocation): string {
  return [
    `You are Volta judge agent ${invocation.spec.id}.`,
    "Choose which candidate should become the seed for the next iteration.",
    "Use the TRIBE neural similarity scores as the primary signal, but write useful reasoning about why the chosen output worked.",
    "If the Codex run includes attached images, inspect them directly as visual context for the target or candidates.",
    "Return only a JSON object matching the provided output schema.",
    `Input object:\n${stableJson(invocation.input)}`,
    inputDescriptionBlock(invocation),
    `Output request:\n${stableJson(invocation.output)}`,
    `Ranked candidate summaries:\n${stableJson(
      invocation.rankedOutputs.map(summarizeEvaluatedOutput),
    )}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function candidateSharedInstructions(
  invocation: CandidateAgentInvocation,
): string {
  return [
    "The inputNode is the target whose emotion, energy, and perceptual feel should be matched.",
    "If the Codex run includes attached images, inspect them directly; they are visual evidence for the target or rendered candidate nodes.",
    "The optional seed is content direction, not the target itself.",
    "Do not train a model. Produce one renderable output node.",
    "For text output, write a direct description of the perceived subject, mood, composition, and affect. Do not write drawing instructions, image-generation prompts, commands, or phrases like render it, use, keep, make, or create.",
    "For image output, produce an image node referencing the intended generated image asset URI.",
    "For code output, produce a complete code node with HTML or React files that can be rendered to screenshots.",
    `Input object:\n${stableJson(invocation.input)}`,
    inputDescriptionBlock(invocation),
    `Output request:\n${stableJson(invocation.output)}`,
    `Entropy cue:\n${invocation.entropy ?? "none"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The input node may be a medium the agent cannot perceive from its payload
// (e.g. audio, whose payload is just an asset URI). When a perceptual
// description is supplied, surface it so the agent can match the vibe.
function inputDescriptionBlock(invocation: BaseAgentInvocation): string {
  const description = invocation.inputDescription;
  if (!description) {
    return "";
  }
  return [
    "What the input sounds/feels like (perceptual description of the target the agent cannot directly perceive):",
    stableJson(compactDescription(description)),
    "Treat this as evidence about the target vibe, not as content to copy verbatim.",
  ].join("\n");
}

function compactDescription(
  description: AudioDescription,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(description).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value != null,
    ),
  );
}

function summarizeEvaluatedOutput(output: EvaluatedOutput) {
  return {
    agentId: output.agentId,
    entropy: output.entropy,
    outputNode: output.outputNode,
    score: output.score,
    rendered: {
      id: output.rendered.id,
      kind: output.rendered.kind,
      preview: output.rendered.preview,
      sha256: output.rendered.sha256,
    },
    activation: {
      model: output.activation.model,
      shape: output.activation.shape,
      summary: output.activation.summary,
    },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

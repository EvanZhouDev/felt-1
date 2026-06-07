import type { EvaluatedOutput } from "@volta/core";
import type {
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
    archiveInstructions(invocation),
    "There is no previous selected output. Start fresh, but use the optional seed to steer content if present.",
    "Return only a JSON object matching the provided output schema.",
  ].join("\n\n");
}

export function buildRefinementCandidatePrompt(
  invocation: CandidateAgentInvocation,
): string {
  return [
    `You are Volta refinement candidate agent ${invocation.spec.id}.`,
    "Generate the next output candidate for a score-driven neural similarity search.",
    candidateSharedInstructions(invocation),
    archiveInstructions(invocation),
    `Previous seed:\n${stableJson(invocation.previous)}`,
    "Use the previous selected output as evidence, not as a script to copy. Preserve what worked, change one or two meaningful variables, and keep the output aimed at the target neural activation.",
    "If the previous seed is written as instructions or an image-generation prompt, convert it into declarative descriptive prose before refining.",
    "Return only a JSON object matching the provided output schema.",
  ].join("\n\n");
}

export function buildJudgePrompt(invocation: JudgeAgentInvocation): string {
  return [
    `You are Volta judge agent ${invocation.spec.id}.`,
    "Choose which candidate should become the seed for the next iteration.",
    "Use score.total as the authoritative ranking signal. If score.adjustedSimilarity is present, treat it as the optimized similarity; raw score.neuralSimilarity is diagnostic only.",
    "If score.contrastSimilarity or score.targetSpecificity is present, penalize generic attractors that score well against unrelated contrast targets.",
    "If auxiliary diagnostics such as Yeo-7 network deltas are present, treat them as mutation-axis hints only; never let them override the score.total ranking.",
    "Reason like an optimizer: name what to keep, what to discard, and what mutation should be tried next. Include the selected candidate's neural similarity and the runner-up's neural similarity when available.",
    "If the Codex run includes attached images, inspect them directly as visual context for the target or candidates.",
    "Return only a JSON object matching the provided output schema.",
    `Input object:\n${stableJson(invocation.input)}`,
    `Output request:\n${stableJson(invocation.output)}`,
    `Ranked candidate summaries:\n${stableJson(
      invocation.rankedOutputs.map(summarizeEvaluatedOutput),
    )}`,
  ].join("\n\n");
}

function candidateSharedInstructions(
  invocation: CandidateAgentInvocation,
): string {
  return [
    "The inputNode is the target whose emotion, energy, and perceptual feel should be matched.",
    "If the Codex run includes attached images, inspect them directly; they are visual evidence for the target or rendered candidate nodes.",
    "The optional seed is content direction, not the target itself. When a seed is present, keep the generated output about the seed's requested topic or medium while matching the input target's perceptual feel.",
    "For same-medium transfers such as text-to-text, do not solve the task by copying or paraphrasing the target. Translate the target's activation feel into the seed topic.",
    "Do not train a model. Produce one renderable output node.",
    "The entropy cue is an assigned evolutionary operator. Follow it so parallel candidates behave like a population: elite preservation, point mutation, crossover, novelty injection, ablation, or representation reset.",
    "For text output, write a compact activation code by default: comma-separated phrase fragments, 6-8 units, 10-18 words total, no full sentence, no title, no labels, no proper names, no explanatory prose.",
    "For text-output mutation, treat each comma-separated unit as a genotype slot. Change only the slot requested by the operator and keep the strongest high-scoring slots stable.",
    "For first-pass text output, favor perceptual-state units over object inventory: motion level, attention, emotional temperature, ambiguity, atmosphere, light, texture, distance, and visual weight. Use at most one concrete subject anchor unless the seed requires a topic.",
    "For text output, optimize for TRIBE neural similarity rather than art-historical correctness. Avoid adding proper names, dates, or explanatory facts unless they are central to the seed.",
    "For image output, produce an image node referencing the intended generated image asset URI.",
    "For code output, produce a complete code node with HTML or React files that can be rendered to screenshots.",
    `Input object:\n${stableJson(invocation.input)}`,
    `Output request:\n${stableJson(invocation.output)}`,
    `Entropy cue:\n${invocation.entropy ?? "none"}`,
  ].join("\n\n");
}

function archiveInstructions(invocation: CandidateAgentInvocation): string {
  if (!invocation.archive) {
    return "Search archive: none yet. This is an exploration candidate.";
  }
  return [
    "Search archive:",
    stableJson(invocation.archive),
    "Use the archive as the evolving population. Consider each entry's score, behavior key, and entropy/operator lineage. Do not copy archive text verbatim; generate a child candidate that follows your assigned operator.",
    "If top entries come from text-probe-calibration, treat them as freshly scored basis vectors for this target. A probe-elite operator should preserve the best probe's strongest slots and mutate or inherit only the assigned slot.",
  ].join("\n\n");
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
      diagnostics: output.activation.diagnostics,
      summary: output.activation.summary,
    },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

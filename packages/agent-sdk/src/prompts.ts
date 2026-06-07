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
    "Use the TRIBE neural similarity scores as the primary signal, but write useful reasoning about why the chosen output worked.",
    "If auxiliary diagnostics such as Yeo-7 network deltas are present, treat them as mutation-axis hints only; never let them override the full-vector neural similarity ranking.",
    "Reason like an optimizer: name what to keep, what to discard, and what mutation should be tried next. Include the selected candidate's neural similarity and the runner-up's neural similarity when available.",
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
    "The optional seed is content direction, not the target itself. When a seed is present, keep the generated output about the seed's requested topic or medium while matching the input target's perceptual feel.",
    "For same-medium transfers such as text-to-text, do not solve the task by copying or paraphrasing the target. Translate the target's activation feel into the seed topic.",
    "Do not train a model. Produce one renderable output node.",
    "The entropy cue is an assigned evolutionary operator. Follow it so parallel candidates behave like a population: elite preservation, point mutation, crossover, novelty injection, ablation, or representation reset.",
    "For text output, write language that makes a reader FEEL the target's vibe — its emotional charge, energy, mood, and atmosphere — rather than cataloguing what is in it. TRIBE scores the predicted emotional/perceptual response, not description, so flat inventories and comma-separated keyword lists score worst. Do not write drawing instructions, image-generation prompts, commands, or phrases like render it, use, keep, make, or create.",
    "Match the target's register: an intense, turbulent target wants charged, moving prose; a calm, still target wants quiet, restrained language. The best register varies by target, so let it follow the target rather than defaulting to one form. Use concrete subject anchors sparingly unless the entropy cue asks for more.",
    "For text output, optimize for TRIBE neural similarity rather than art-historical correctness. Avoid adding proper names, dates, or explanatory facts unless they are central to the seed.",
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

function archiveInstructions(invocation: CandidateAgentInvocation): string {
  if (!invocation.archive) {
    return "Search archive: none yet. This is an exploration candidate.";
  }
  return [
    "Search archive:",
    stableJson(invocation.archive),
    "Use the archive as the evolving population. Consider each entry's score, behavior key, and entropy/operator lineage. Do not copy archive text verbatim; generate a child candidate that follows your assigned operator.",
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

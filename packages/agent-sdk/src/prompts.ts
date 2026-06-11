import type { AudioDescription, EvaluatedOutput } from "@volta/core";
import type {
  BaseAgentInvocation,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "./types.ts";

// Candidate prompts implement an OPRO-style optimization step (Yang et al.
// 2023, "Large Language Models as Optimizers"): the agent sees the score-sorted
// trajectory of past attempts plus the judge's critique of the current best
// (Reflexion-style verbal feedback), and is asked to propose a candidate that
// scores higher. The ranked history IS the steering signal — there are no
// hand-coded mutation operators.

export function buildCandidatePrompt(
  invocation: CandidateAgentInvocation,
): string {
  if (!invocation.trajectory) {
    return buildExplorationPrompt(invocation);
  }
  return buildImprovementPrompt(invocation);
}

// Round 1: no scored attempts yet. Parallel candidates span distinct emotional
// registers — TRIBE scores the predicted felt response, so the first round's
// job is to cover different affective stances toward the same target and let
// the scores reveal which one the target rewards.
function buildExplorationPrompt(invocation: CandidateAgentInvocation): string {
  return [
    `You are Volta candidate agent ${invocation.spec.id}.`,
    "Generate the first output candidate for a vibe-transfer run. No attempts have been scored yet — this is the exploration round.",
    candidateSharedInstructions(invocation),
    siblingDiversityInstruction(invocation),
    "Choose ONE distinct emotional register through which the target is felt (for example: awe, tenderness, bodily sensation, stillness, tension, lyric intensity) and inhabit it fully. Read the target's actual vibe THROUGH that register — a calm target read with awe yields quiet awe, not forced drama.",
    "Commit to a FORM that physically enacts that register, not just words that name it: sentence length and rhythm, syntax density, line shape, sound texture. An agitated target wants clipped, percussive, off-balance prose; a calm one wants long, even, unhurried lines. The scorer responds to perceptual form at least as much as to imagery.",
    "Return only a JSON object matching the provided output schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildImprovementPrompt(invocation: CandidateAgentInvocation): string {
  const trajectory = invocation.trajectory;
  return [
    `You are Volta candidate agent ${invocation.spec.id}.`,
    "Generate the next output candidate for a score-driven neural-similarity search.",
    candidateSharedInstructions(invocation),
    [
      "Score trajectory — past attempts sorted worst to best (higher neuralSimilarity is better; the LAST entry is the current best). Each entry's activationSimilarityToBest says how close that attempt landed to the current best in neural-activation space: near 1 with different wording means it was a re-skin of the same neural point, not a new direction.",
      stableJson(trajectory?.entries ?? []),
      trajectory?.critique
        ? `Judge critique of the current best:\n${trajectory.critique}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    crowdingInstruction(invocation),
    "Propose a NEW candidate you expect to score HIGHER than the current best. Study what the higher-scoring attempts share, and use the critique to fix what the best one still lacks. Preserve what is working; change what the evidence says is holding the score back.",
    "Do not repeat any prior attempt verbatim or near-verbatim, and do not land where prior attempts already sit in activation space — both are penalized at scoring time. Changing the imagery while keeping the same register and rhythm counts as landing in the same place.",
    siblingDiversityInstruction(invocation),
    "Return only a JSON object matching the provided output schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Reflexion-style verbal gradient for the attractor failure mode (issue #6):
// when past attempts cluster in activation space, more wording variations of
// the same evocative register cannot improve the score — say so explicitly and
// demand divergence in perceptual form.
function crowdingInstruction(invocation: CandidateAgentInvocation): string {
  const crowding = invocation.trajectory?.meanCrowding;
  if (crowding === undefined || crowding < CROWDING_WARNING_THRESHOLD) {
    return "";
  }
  return [
    `WARNING: past attempts are crowded in neural-activation space (mean similarity to the best: ${crowding}). To the scorer they are nearly ONE point — likely a shared evocative-literary register acting as an attractor.`,
    "Another thematic variation in that register will not move the score. Diverge in perceptual FORM: change the rhythm, sentence length and shape, syntactic density, concreteness, and sound texture so the text is FELT differently, while staying true to the target's vibe.",
  ].join(" ");
}

const CROWDING_WARNING_THRESHOLD = 0.85;

export function buildJudgePrompt(invocation: JudgeAgentInvocation): string {
  return [
    `You are Volta judge agent ${invocation.spec.id}.`,
    "Choose which candidate best matches the target's neural activation, and critique it.",
    "Use the TRIBE neural similarity scores as the primary signal.",
    "If auxiliary diagnostics such as Yeo-7 network deltas are present, treat them as hints only; never let them override the full-vector neural similarity ranking.",
    "Your reasoning doubles as the critique fed to the next round's candidate agents. State concretely: what the selected candidate does that earns its score, what it still lacks relative to the target's vibe, and what a higher-scoring attempt should try next.",
    invocation.input.seed
      ? "This run has a SEED: the output is required to depict the seed's content while carrying the target's vibe. For EVERY candidate in the ranked list, rate seedAdherence in [0, 1]: 1.0 = the seed content is clearly and fully depicted; 0.5 = partially present or heavily transformed; 0.0 = the seed content was abandoned. Inspect attached candidate images where available. Rate every agentId exactly once. These ratings carry real score weight — an output that abandons the seed to chase the vibe must pay for it."
      : "",
    "Low diversity scores mean the candidates are crowding one region of activation space — usually a shared generically-evocative register rather than the target's specific signature. When you see that, say so in the critique and direct the next round to diverge in perceptual form (rhythm, sentence shape, density), not just imagery.",
    "If the Codex run includes attached images, inspect them directly as visual context for the target or candidates.",
    "Return only a JSON object matching the provided output schema.",
    `Input object:\n${stableJson(sanitizeInput(invocation.input))}`,
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
    outputTypeInstruction(invocation),
    `Input object:\n${stableJson(sanitizeInput(invocation.input))}`,
    inputDescriptionBlock(invocation),
    `Output request:\n${stableJson(invocation.output)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function outputTypeInstruction(invocation: CandidateAgentInvocation): string {
  const outputType = invocation.output.outputType;
  if (outputType === "text") {
    // TRIBE predicts the reader's emotional/perceptual neural response, not
    // semantic accuracy: flat description scores worst, and the register that
    // scores best is target-dependent, so we ask for felt language and let the
    // scores select the register.
    return [
      "For text output, write a piece of LITERATURE — a poem, a story fragment, a scene, any prose form — that re-creates in its reader the same emotion the target evokes. Not a text about the target. TRIBE scores the predicted emotional/perceptual response, not semantic accuracy: flat description scores worst. The reader will never see the target or its description; the piece must do its emotional work standing completely alone. Do not write drawing instructions, image-generation prompts, or commands.",
      "The input description and its features (key, BPM, tempo, instrument names, genre labels) are EVIDENCE for you, not material for the piece. Never quote or mention them: no note names, no beats-per-minute, no 'minor key', no instrument inventory, no music-theory vocabulary at all. Translate them into lived, bodily, perceptual experience — a tempo is a heartbeat, a pace of walking, breath; brightness is light, temperature, edge; an instrument is at most the gesture it makes, never its name. A text that explains what the music is doing has failed; a text that does to the reader what the music does has succeeded.",
      "Carry the vibe in the FORM, not only the imagery: line and sentence length, rhythm, density, sound texture. An agitated, stormy target wants clipped, percussive, off-balance lines; a calm target wants long, even, unhurried ones; a grand, building target wants lines that accumulate and swell. Soft abstract evocative-literary writing is the default register every target gets pulled toward — it reads 'emotional in general' to the scorer regardless of the target, so reach for the specific perceptual shape of THIS target instead.",
      "Avoid proper names, dates, or explanatory facts unless they are central to the seed. Keep it short and high-signal.",
    ].join(" ");
  }
  if (outputType === "image") {
    return [
      'For image output, set payload.source.uri to "flux:" followed by a complete image-generation prompt (example: "flux:oil painting of a storm-lit harbor, heavy impasto, cold teal and slate palette, low horizon"). The orchestrator generates the image from that prompt and scores what was generated — the prompt IS your output medium, and prior attempts\' prompts appear in the score trajectory.',
      "Express the vibe through palette, light, composition, subject anchors, texture, framing, and atmosphere. Set source.mime to image/png and source.sha256 to null.",
    ].join(" ");
  }
  return "For code output, produce a complete code node with HTML or React files that can be rendered to screenshots. Express the vibe through layout, density, typography, color/contrast, and texture.";
}

// Parallel candidates within one round share the same trajectory; without an
// explicit push they converge on one approach and the round wastes oracle
// calls scoring near-duplicates.
// Parallel candidates are generated simultaneously, so a sibling cannot read
// what the others wrote — telling it to "differ from your siblings" leaves a
// deterministic backend with the same prompt minus an index, and it collapses
// to one text (observed: 3 of 4 identical candidates). Instead ASSIGN each
// index a concrete, mutually distinct perceptual FORM so divergence is forced
// by construction, not left to imagination. The forms are deliberately
// orthogonal in rhythm/syntax/length so the resulting texts land far apart in
// activation space; each still reads the SAME target vibe through its form.
const SIBLING_FORMS = [
  "long, unbroken lines that accumulate clauses and resist stopping — one continuous breath, few full stops",
  "short, clipped, fragmentary lines; heavy stops; staccato rhythm with abrupt breaks",
  "a plain, concrete, low-adjective register: short declarative lines naming physical particulars",
  "dense, sound-driven lines foregrounding texture — assonance, repetition, and stress patterns over imagery",
  "a sparse, white-space-heavy form: very short lines with long pauses, each landing alone",
  "a building, list-like accumulation that escalates in intensity from one line to the next",
];

function siblingDiversityInstruction(
  invocation: CandidateAgentInvocation,
): string {
  const count = invocation.candidateCount ?? 1;
  if (count <= 1) {
    return "";
  }
  const index = invocation.candidateIndex ?? 0;
  const position = index + 1;
  const form = SIBLING_FORMS[index % SIBLING_FORMS.length];
  return `You are candidate ${position} of ${count} generated in parallel this round. Your ASSIGNED perceptual form is: ${form}. Write THIS candidate in that form — it is what makes you different from your siblings, who are each assigned a different one. The difference must be FORMAL (rhythm, sentence length, syntactic density, sound), not merely thematic: imagery alone leaves siblings on the same point in activation space and wastes the round. Still read the target's actual vibe THROUGH your assigned form.`;
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

// Strip identifying file names / paths from any node source before it reaches a
// prompt. Otherwise a uri like "file:///tmp/audio/clair_de_lune.wav" leaks the
// title to the agent, which then writes from recognizing the famous work rather
// than from the target's actual perceptual content — a leakage path that
// invalidates vibe-transfer results. Replace the uri with the medium + a short
// content hash so renders still have a stable id, minus the human-readable name.
function sanitizeInput<T>(input: T): T {
  return JSON.parse(JSON.stringify(input), (key, value) => {
    if (key === "uri" && typeof value === "string") {
      const ext = value.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin";
      return `anonymized-source.${ext}`;
    }
    return value;
  });
}

import type { TrajectoryContext, TrajectoryEntry } from "@volta/agent-sdk";
import type { EvaluatedOutput } from "@volta/core";

// The optimization trajectory fed back to candidate agents (OPRO-style): the
// top-K scored attempts so far, sorted ASCENDING by neural similarity so the
// strongest example sits last, plus the judge's critique of the current best.
// This ranked, critiqued history is the loop's entire steering mechanism.

const TRAJECTORY_LIMIT = 8;
const TEXT_PREVIEW_LIMIT = 700;

export type ScoredAttempt = {
  iteration: number;
  output: EvaluatedOutput;
};

export function buildTrajectoryContext(args: {
  attempts: ScoredAttempt[];
  critique?: string;
}): TrajectoryContext | undefined {
  const deduped = dedupeByStimulus(args.attempts);
  if (deduped.length === 0) {
    return undefined;
  }
  const ranked = deduped
    .sort(
      (left, right) =>
        right.output.score.neuralSimilarity -
        left.output.score.neuralSimilarity,
    )
    .slice(0, TRAJECTORY_LIMIT)
    .reverse();

  return {
    bestNeuralSimilarity: ranked.at(-1)?.output.score.neuralSimilarity ?? 0,
    critique: args.critique,
    entries: ranked.map(trajectoryEntry),
  };
}

// The best-so-far is re-ranked every iteration, so the same rendered stimulus
// shows up once per iteration it survived; keep only its first (originating)
// record.
function dedupeByStimulus(attempts: ScoredAttempt[]): ScoredAttempt[] {
  const first = new Map<string, ScoredAttempt>();
  for (const attempt of attempts) {
    const key = attempt.output.rendered.sha256;
    if (!first.has(key)) {
      first.set(key, attempt);
    }
  }
  return [...first.values()];
}

function trajectoryEntry(attempt: ScoredAttempt): TrajectoryEntry {
  return {
    iteration: attempt.iteration,
    agentId: attempt.output.agentId,
    neuralSimilarity: round(attempt.output.score.neuralSimilarity),
    preview: truncate(
      attempt.output.outputNode.type === "text"
        ? attempt.output.outputNode.payload.text
        : attempt.output.rendered.preview,
      TEXT_PREVIEW_LIMIT,
    ),
  };
}

// Novelty of a candidate text against everything already scored, in [0, 1].
// 1 = nothing like it has been tried; 0 = verbatim repeat of a prior attempt.
// This is the soft anti-reward-hack guard: the neural metric is optimized by
// search pressure, and the cheapest false win is resubmitting (or trivially
// rephrasing) the current best, so near-duplicates lose their diversity share
// of the total score instead of riding the leader's neural similarity.
export function textNovelty(text: string, priorTexts: string[]): number {
  if (priorTexts.length === 0) {
    return 1;
  }
  const grams = trigrams(text);
  if (grams.size === 0) {
    return 1;
  }
  let maxOverlap = 0;
  for (const prior of priorTexts) {
    const overlap = jaccard(grams, trigrams(prior));
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
    }
  }
  return 1 - maxOverlap;
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let index = 0; index + 2 < words.length; index += 1) {
    grams.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

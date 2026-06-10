import type { TrajectoryContext, TrajectoryEntry } from "@volta/agent-sdk";
import {
  type ActivationTrace,
  type EvaluatedOutput,
  pooledActivationSimilarity,
} from "@volta/core";

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

  const best = ranked.at(-1);
  const entries = ranked.map((attempt) =>
    trajectoryEntry(
      attempt,
      attempt === best ? undefined : best?.output.activation,
    ),
  );
  return {
    bestNeuralSimilarity: best?.output.score.neuralSimilarity ?? 0,
    critique: args.critique,
    entries,
    meanCrowding: meanCrowding(entries),
  };
}

// Mean activation similarity of the non-best entries to the best. High values
// mean the trajectory has collapsed onto one activation-space attractor — the
// attempts read as different texts to a human but as ONE point to TRIBE, which
// is exactly the generic-evocative failure mode this number makes visible to
// the next round's candidates.
function meanCrowding(entries: TrajectoryEntry[]): number | undefined {
  const similarities = entries
    .slice(0, -1)
    .map((entry) => entry.activationSimilarityToBest)
    .filter((value): value is number => typeof value === "number");
  if (similarities.length === 0) {
    return undefined;
  }
  return round(
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length,
  );
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

function trajectoryEntry(
  attempt: ScoredAttempt,
  bestActivation?: ActivationTrace,
): TrajectoryEntry {
  const similarityToBest = bestActivation
    ? pooledActivationSimilarity(attempt.output.activation, bestActivation)
    : undefined;
  return {
    iteration: attempt.iteration,
    agentId: attempt.output.agentId,
    neuralSimilarity: round(attempt.output.score.neuralSimilarity),
    activationSimilarityToBest:
      similarityToBest === undefined ? undefined : round(similarityToBest),
    preview: truncate(attemptPreview(attempt), TEXT_PREVIEW_LIMIT),
  };
}

// What the next round's optimizer sees as "the attempt". Text shows the text;
// generated images show their generation prompt (the searchable medium) —
// a file path would be opaque to the agents.
function attemptPreview(attempt: ScoredAttempt): string {
  const node = attempt.output.outputNode;
  if (node.type === "text") {
    return node.payload.text;
  }
  if (node.type === "image" && node.payload.prompt) {
    return `image prompt: ${node.payload.prompt}`;
  }
  return attempt.output.rendered.preview;
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

// Novelty of a candidate's TRIBE activation against prior attempts', in [0, 1].
// 1 = it landed somewhere no attempt has been; 0 = it landed exactly where a
// prior attempt already sits. Text trigrams can't see the failure mode this
// guards against: texts that are semantically distinct to a human but share one
// evocative register evoke nearly the SAME predicted neural response, so the
// search collapses onto a single generically-evocative attractor that scores
// well against any emotional target. Distance is the pooled cosine only —
// the temporal terms are excluded because matching the target's pacing is
// desirable convergence, not crowding. Priors without per-vertex values (e.g.
// attempts reloaded from disk on resume) contribute nothing; with no usable
// prior, novelty is unknowable and we return undefined rather than a default.
export function activationNovelty(
  candidate: ActivationTrace,
  priors: ActivationTrace[],
): number | undefined {
  let maxSimilarity: number | undefined;
  for (const prior of priors) {
    const similarity = pooledActivationSimilarity(candidate, prior);
    if (similarity === undefined) {
      continue;
    }
    if (maxSimilarity === undefined || similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }
  return maxSimilarity === undefined ? undefined : 1 - maxSimilarity;
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

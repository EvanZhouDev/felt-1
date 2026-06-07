import type { ActivationTrace, ScoreBundle } from "../types.ts";

// How much the neural similarity leans on the spatial pattern at each timestep
// vs. the frame-to-frame *change*. Both terms are needed: the spatial term
// anchors "what is firing", the dynamics term captures "how it moves over time"
// — the turbulence/stillness signature that a time-averaged vector throws away.
// Validated on real TRIBE activations (see exp-2 probe set): at this split the
// true cross-modal vibe-match ranks #1 against hard counterfactuals (incl. a
// calm night sky) AND the degenerate-repetition reward-hack scores well below
// it. Dynamics alone is hack-prone, so we keep it at half weight.
const TEMPORAL_WEIGHT = 0.5;
const DYNAMICS_WEIGHT = 1 - TEMPORAL_WEIGHT;

export function scoreActivations(args: {
  target: ActivationTrace;
  candidate: ActivationTrace;
  seedAdherence?: number;
  coherence?: number;
  diversity?: number;
}): ScoreBundle {
  const neuralSimilarity = neuralTrajectorySimilarity(
    args.target,
    args.candidate,
  );
  const seedAdherence = args.seedAdherence ?? 0.5;
  const coherence = args.coherence ?? 0.5;
  const diversity = args.diversity ?? 0.5;

  return {
    neuralSimilarity,
    seedAdherence,
    coherence,
    diversity,
    total:
      neuralSimilarity * 0.7 +
      seedAdherence * 0.15 +
      coherence * 0.1 +
      diversity * 0.05,
  };
}

// Similarity between two TRIBE activation trajectories, in [0, 1].
//
// When both traces carry the full [timesteps, vertices] matrix (timesteps >= 2)
// we combine two cosines:
//   - temporal: mean over timesteps of the *mean-centered* per-frame cosine.
//     Centering removes the generic-language DC baseline that makes unrelated
//     prose look similar; per-frame keeps the activation's temporal pattern
//     instead of averaging it into one washed-out vector.
//   - dynamics: mean over timesteps of the cosine between the frame-to-frame
//     deltas. This compares how activation *moves*, which is where turbulence
//     vs. stillness shows up.
// The raw score lives in [-1, 1]; we map it to [0, 1] so existing
// similarity-threshold stop conditions keep their meaning.
//
// If either trace is single-timestep or sparse (mock oracle, 1-segment text),
// we fall back to a single mean-centered cosine over the flattened values, and
// finally to the summary-stat vector when no values are present at all.
export function neuralTrajectorySimilarity(
  target: ActivationTrace,
  candidate: ActivationTrace,
): number {
  const a = target.values;
  const b = candidate.values;

  if (a && b && a.length >= 2 && b.length >= 2) {
    const temporal = temporalCenteredCosine(a, b);
    const dynamics = deltaCosine(a, b);
    const raw = TEMPORAL_WEIGHT * temporal + DYNAMICS_WEIGHT * dynamics;
    return (raw + 1) / 2;
  }

  // Single-timestep or mixed: mean-centered global cosine. Still drops the
  // generic baseline; just can't use temporal structure.
  const flatA = flattenTrace(target);
  const flatB = flattenTrace(candidate);
  if (a && b) {
    const raw = cosineSimilarity(centerInPlace(flatA), centerInPlace(flatB));
    return (raw + 1) / 2;
  }

  // No per-vertex values at all (sparse summary-only trace): keep the legacy
  // uncentered cosine over the summary vector, which is already non-negative.
  return cosineSimilarity(flatA, flatB);
}

// Mean over min(T) timesteps of the mean-centered cosine between aligned frames.
function temporalCenteredCosine(a: number[][], b: number[][]): number {
  const steps = Math.min(a.length, b.length);
  let sum = 0;
  for (let t = 0; t < steps; t += 1) {
    sum += cosineSimilarity(centerInPlace([...a[t]]), centerInPlace([...b[t]]));
  }
  return steps > 0 ? sum / steps : 0;
}

// Mean over the frame-to-frame deltas of the cosine between aligned deltas.
function deltaCosine(a: number[][], b: number[][]): number {
  const da = frameDeltas(a);
  const db = frameDeltas(b);
  const steps = Math.min(da.length, db.length);
  let sum = 0;
  for (let t = 0; t < steps; t += 1) {
    sum += cosineSimilarity(da[t], db[t]);
  }
  return steps > 0 ? sum / steps : 0;
}

// Frame-to-frame differences: deltas[t] = frames[t+1] - frames[t].
function frameDeltas(frames: number[][]): number[][] {
  const deltas: number[][] = [];
  for (let t = 1; t < frames.length; t += 1) {
    const prev = frames[t - 1];
    const cur = frames[t];
    const width = Math.min(prev.length, cur.length);
    const delta = new Array<number>(width);
    for (let i = 0; i < width; i += 1) {
      delta[i] = (cur[i] ?? 0) - (prev[i] ?? 0);
    }
    deltas.push(delta);
  }
  return deltas;
}

// Subtract the mean from a vector in place and return it.
function centerInPlace(values: number[]): number[] {
  if (values.length === 0) {
    return values;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  const mean = sum / values.length;
  for (let i = 0; i < values.length; i += 1) {
    values[i] -= mean;
  }
  return values;
}

export function flattenTrace(trace: ActivationTrace): number[] {
  if (!trace.values) {
    return [
      trace.summary.mean,
      trace.summary.std,
      trace.summary.norm,
      trace.shape[0],
      trace.shape[1],
    ];
  }
  return trace.values.flat();
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }

  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

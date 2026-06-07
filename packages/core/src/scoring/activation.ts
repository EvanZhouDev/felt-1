import type { ActivationTrace, ScoreBundle } from "../types.ts";

// The neural similarity blends three views of the activation trajectory:
//   - pooled: cosine of the mean-centered time-AVERAGE. Length-invariant, so it
//     grounds cross-modal pairs whose timestep counts differ wildly (an image is
//     ~2 frames; the text rendered from it is ~23). This is the backbone.
//   - temporal: mean per-frame mean-centered cosine, after resampling BOTH
//     traces to their common (max) length so every frame contributes — anchors
//     "what is firing" over time.
//   - dynamics: mean cosine of the frame-to-frame deltas (also on the resampled
//     traces) — "how it moves", the turbulence/stillness signature a time-
//     average throws away. Dynamics alone is hack-prone, so it gets the least.
// Validated on real TRIBE activations (exp-2 probe set + the Starry-Night
// image->text pair): at this split the true vibe-match ranks #1 against hard
// counterfactuals (incl. a calm night sky), the repetition reward-hack scores
// ~0.08 below the match, and cross-modal scoring uses all frames instead of
// silently truncating the longer trace to min(T).
const POOLED_WEIGHT = 0.4;
const TEMPORAL_WEIGHT = 0.35;
const DYNAMICS_WEIGHT = 0.25;

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
// we blend the pooled / temporal / dynamics cosines described above. Crucially,
// the temporal and dynamics terms first resample BOTH traces to their common
// (max) length, so a 2-frame image target and a 23-frame text candidate are
// compared frame-for-frame across their whole span instead of truncating the
// candidate to the target's 2 frames (the old min(T) alignment threw away 21 of
// 23 frames and capped cross-modal scores).
// The raw blend lives in [-1, 1]; we map it to [0, 1] so existing
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
    const pooled = cosineSimilarity(
      centerInPlace(meanFrame(a)),
      centerInPlace(meanFrame(b)),
    );
    const length = Math.max(a.length, b.length);
    const ar = resampleFrames(a, length);
    const br = resampleFrames(b, length);
    const temporal = temporalCenteredCosine(ar, br);
    const dynamics = deltaCosine(ar, br);
    const raw =
      POOLED_WEIGHT * pooled +
      TEMPORAL_WEIGHT * temporal +
      DYNAMICS_WEIGHT * dynamics;
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

// Mean over timesteps of the mean-centered cosine between aligned frames. Both
// inputs are assumed already resampled to the same length.
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

// Time-average of a [timesteps, vertices] matrix into one R^vertices frame.
function meanFrame(frames: number[][]): number[] {
  const width = frames[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < width; i += 1) {
      out[i] += frame[i] ?? 0;
    }
  }
  if (frames.length > 0) {
    for (let i = 0; i < width; i += 1) {
      out[i] /= frames.length;
    }
  }
  return out;
}

// Resample a [timesteps, vertices] matrix to `length` frames by nearest-index
// selection, so two traces of different lengths can be compared frame-for-frame
// across their whole span. Returns the input unchanged when already at length.
function resampleFrames(frames: number[][], length: number): number[][] {
  const source = frames.length;
  if (source === length || source === 0) {
    return frames;
  }
  const out: number[][] = new Array(length);
  for (let k = 0; k < length; k += 1) {
    const index =
      length > 1 ? Math.round((k * (source - 1)) / (length - 1)) : 0;
    out[k] = frames[index];
  }
  return out;
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

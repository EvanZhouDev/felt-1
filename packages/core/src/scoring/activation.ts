import type { ActivationTrace, ScoreBundle } from "../types.ts";

// The neural similarity blends three views of the activation trajectory:
//   - pooled (0.4): cosine of the mean-centered time-AVERAGE. Length-invariant,
//     it grounds cross-modal pairs whose timestep counts differ wildly (an image
//     is ~2 frames; the text rendered from it is ~23) and keeps the metric
//     non-gameable — it is what makes the true text<->text vibe-match rank #1
//     over a same-topic-opposite-vibe counterfactual.
//   - resampled trajectory (0.3): the temporal + dynamics cosines (per-frame
//     pattern and frame-to-frame motion) after resampling BOTH traces to their
//     common (max) length so every frame contributes. Captures the
//     turbulence/stillness signature a time-average throws away.
//   - best-match (0.3): for each target frame, its cosine to the *best-matching*
//     candidate frame (averaged both directions). This is the term that widens
//     the cross-modal gradient — it lets a 2-frame image align to whichever text
//     frames resemble it, instead of diluting the signal across a rigid resample.
// Validated on real TRIBE activations (exp-2 probe set + Starry-Night
// image->text + an 8-persona style sweep): the true vibe-match ranks #1, the
// repetition reward-hack scores ~0.08 below it, flat semantic description ranks
// dead last (TRIBE rewards emotional response, not description), and the
// cross-modal style gradient is ~2x wider than resample-only.
const POOLED_WEIGHT = 0.4;
const TRAJECTORY_WEIGHT = 0.3;
const BEST_MATCH_WEIGHT = 0.3;
// Within the resampled-trajectory term, split evenly between the per-frame
// pattern (temporal) and its motion (dynamics).
const TEMPORAL_SHARE = 0.5;
const DYNAMICS_SHARE = 0.5;

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
    const trajectory =
      TEMPORAL_SHARE * temporalCenteredCosine(ar, br) +
      DYNAMICS_SHARE * deltaCosine(ar, br);
    const bestMatch = symmetricBestMatchCosine(a, b);
    const raw =
      POOLED_WEIGHT * pooled +
      TRAJECTORY_WEIGHT * trajectory +
      BEST_MATCH_WEIGHT * bestMatch;
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

// Soft frame alignment: for each frame on one side, take its cosine to the
// best-matching frame on the other side (mean-centered), and average both
// directions. Unlike the rigid resample, this lets a short trace align to
// whichever frames of a long trace resemble it — widening the cross-modal
// gradient without assuming the two traces share a time base. Operates on the
// ORIGINAL (un-resampled) frames so no information is duplicated or dropped.
function symmetricBestMatchCosine(a: number[][], b: number[][]): number {
  const bc = b.map((frame) => centerInPlace([...frame]));
  const ac = a.map((frame) => centerInPlace([...frame]));
  const forward = meanBestMatch(ac, bc);
  const backward = meanBestMatch(bc, ac);
  return (forward + backward) / 2;
}

// Mean over `from` frames of each frame's max cosine to any `to` frame. Inputs
// are assumed already mean-centered.
function meanBestMatch(from: number[][], to: number[][]): number {
  if (from.length === 0 || to.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const frame of from) {
    let best = Number.NEGATIVE_INFINITY;
    for (const other of to) {
      const c = cosineSimilarity(frame, other);
      if (c > best) {
        best = c;
      }
    }
    sum += best;
  }
  return sum / from.length;
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

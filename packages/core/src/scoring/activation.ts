import type { ActivationTrace, ScoreBundle } from "../types.ts";

export function scoreActivations(args: {
  target: ActivationTrace;
  candidate: ActivationTrace;
  seedAdherence?: number;
  coherence?: number;
  diversity?: number;
}): ScoreBundle {
  const neuralSimilarity = cosineSimilarity(
    flattenTrace(args.target),
    flattenTrace(args.candidate),
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

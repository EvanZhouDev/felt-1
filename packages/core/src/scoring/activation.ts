import type { ActivationTrace, ScoreBundle } from "../types.ts";

export function scoreActivations(args: {
  target: ActivationTrace;
  candidate: ActivationTrace;
  contrastTargets?: ActivationTrace[];
  seedAdherence?: number;
  coherence?: number;
  diversity?: number;
  penalty?: number;
}): ScoreBundle {
  const candidateVector = flattenTrace(args.candidate);
  const neuralSimilarity = cosineSimilarity(
    flattenTrace(args.target),
    candidateVector,
  );
  const contrastSimilarity = maxContrastSimilarity({
    candidate: candidateVector,
    targets: args.contrastTargets ?? [],
  });
  const residualSimilarity = residualizedSimilarity({
    target: flattenTrace(args.target),
    candidate: candidateVector,
    contrastTargets: args.contrastTargets ?? [],
  });
  const targetSpecificity =
    contrastSimilarity === undefined
      ? undefined
      : neuralSimilarity - contrastSimilarity;
  const contrastPenalty =
    targetSpecificity === undefined ? 0 : Math.min(0, targetSpecificity);
  const adjustedSimilarity =
    (residualSimilarity ?? targetSpecificity ?? neuralSimilarity) +
    contrastPenalty;
  const seedAdherence = args.seedAdherence ?? 0.5;
  const coherence = args.coherence ?? 0.5;
  const diversity = args.diversity ?? 0.5;
  const penalty = args.penalty ?? 0;
  const auxiliarySignal =
    (seedAdherence - 0.5) * 0.04 +
    (coherence - 0.5) * 0.04 +
    (diversity - 0.5) * 0.02;

  return {
    neuralSimilarity,
    adjustedSimilarity,
    contrastSimilarity,
    residualSimilarity,
    targetSpecificity,
    penalty: penalty > 0 ? penalty : undefined,
    seedAdherence,
    coherence,
    diversity,
    total: adjustedSimilarity + auxiliarySignal - penalty,
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

function maxContrastSimilarity(args: {
  candidate: number[];
  targets: ActivationTrace[];
}): number | undefined {
  if (args.targets.length === 0) {
    return undefined;
  }

  return Math.max(
    ...args.targets.map((target) =>
      cosineSimilarity(args.candidate, flattenTrace(target)),
    ),
  );
}

function residualizedSimilarity(args: {
  target: number[];
  candidate: number[];
  contrastTargets: ActivationTrace[];
}): number | undefined {
  if (args.contrastTargets.length === 0) {
    return undefined;
  }

  const contrastBasis = orthonormalBasis(
    args.contrastTargets.map(flattenTrace),
  );
  if (contrastBasis.length === 0) {
    return undefined;
  }
  return cosineSimilarity(
    removeSubspaceProjection(args.target, contrastBasis),
    removeSubspaceProjection(args.candidate, contrastBasis),
  );
}

function orthonormalBasis(vectors: number[][]): number[][] {
  const basis: number[][] = [];
  for (const vector of vectors) {
    let residual = vector.slice();
    for (const basisVector of basis) {
      residual = removeVectorProjection(residual, basisVector);
    }
    const residualNorm = vectorNorm(residual);
    if (residualNorm <= 1e-9) {
      continue;
    }
    basis.push(residual.map((value) => value / residualNorm));
  }
  return basis;
}

function removeSubspaceProjection(
  vector: number[],
  basis: number[][],
): number[] {
  let residual = vector.slice();
  for (const basisVector of basis) {
    residual = removeVectorProjection(residual, basisVector);
  }
  return residual;
}

function removeVectorProjection(vector: number[], basis: number[]): number[] {
  const length = Math.min(vector.length, basis.length);
  const basisNorm = vectorDot(basis, basis, length);
  if (basisNorm <= 0) {
    return vector.slice(0, length);
  }
  const scale = vectorDot(vector, basis, length) / basisNorm;
  return vector.slice(0, length).map((value, index) => {
    return value - scale * (basis[index] ?? 0);
  });
}

function vectorDot(a: number[], b: number[], length: number): number {
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return dot;
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vectorDot(vector, vector, vector.length));
}

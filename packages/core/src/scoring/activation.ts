import type { ActivationTrace, ScoreBundle } from "../types.ts";

const MIN_CALIBRATED_CONTRAST_TARGETS = 6;
const MIN_RESIDUAL_CONTRAST_TARGETS = 6;
const SELF_MATCH_SIMILARITY = 0.9995;
const NEAR_MISS_CALIBRATED_WEIGHT = 0.65;

export function scoreActivations(args: {
  target: ActivationTrace;
  candidate: ActivationTrace;
  contrastTargets?: ActivationTrace[];
  seedAdherence?: number;
  seedModality?: "text" | "image";
  seedSimilarity?: number;
  seedTargetSimilarity?: number;
  seedSpecificity?: number;
  seedPromptAdherence?: number;
  seedPromptPenalty?: number;
  coherence?: number;
  diversity?: number;
  penalty?: number;
  useResidualAdjustedSimilarity?: boolean;
  useRawAdjustedSimilarity?: boolean;
}): ScoreBundle {
  const targetVector = flattenTrace(args.target);
  const candidateVector = flattenTrace(args.candidate);
  const contrastTargets = sameLengthContrastTargets(
    args.contrastTargets ?? [],
    targetVector.length,
  );
  const neuralSimilarity = cosineSimilarity(targetVector, candidateVector);
  const contrastSimilarity = maxContrastSimilarity({
    candidate: candidateVector,
    targets: contrastTargets,
  });
  const residualSimilarity = residualizedSimilarity({
    target: targetVector,
    candidate: candidateVector,
    contrastTargets,
  });
  const calibrated = calibratedRetrievalSimilarity({
    target: targetVector,
    candidate: candidateVector,
    contrastTargets,
  });
  const targetSpecificity =
    contrastSimilarity === undefined
      ? undefined
      : neuralSimilarity - contrastSimilarity;
  const contrastPenalty =
    targetSpecificity === undefined ? 0 : Math.min(0, targetSpecificity);
  const calibratedAdjustedSimilarity =
    calibrated?.calibratedSimilarity ??
    (residualSimilarity ?? targetSpecificity ?? neuralSimilarity) +
      contrastPenalty;
  const residualAdjustedSimilarity =
    args.useResidualAdjustedSimilarity && residualSimilarity !== undefined
      ? clamp01(residualSimilarity)
      : undefined;
  const rawAdjustedSimilarity = args.useRawAdjustedSimilarity
    ? clamp01(neuralSimilarity)
    : undefined;
  const adjustedSimilarity = Math.max(
    calibratedAdjustedSimilarity,
    residualAdjustedSimilarity ?? Number.NEGATIVE_INFINITY,
    rawAdjustedSimilarity ?? Number.NEGATIVE_INFINITY,
  );
  const seedAdherence = args.seedAdherence ?? 0.5;
  const coherence = args.coherence ?? 0.5;
  const diversity = args.diversity ?? 0.5;
  const penalty = args.penalty ?? 0;
  const searchProgressSignal = calibrated
    ? Math.min(0.04, calibrated.searchProgressSignal * 0.04)
    : 0;
  const auxiliarySignal =
    (seedAdherence - 0.5) * 0.04 +
    (coherence - 0.5) * 0.04 +
    (diversity - 0.5) * 0.02;

  return {
    neuralSimilarity,
    adjustedSimilarity,
    calibratedSimilarity: calibrated?.calibratedSimilarity,
    rawAdjustedSimilarity,
    contrastSimilarity,
    discriminativeSimilarity: calibrated?.discriminativeSimilarity,
    residualSimilarity,
    residualAdjustedSimilarity,
    retrievalMargin: calibrated?.retrievalMargin,
    nearMissSimilarity: calibrated?.nearMissSimilarity,
    cslsSimilarity: calibrated?.cslsSimilarity,
    hubnessPenalty: calibrated?.hubnessPenalty,
    searchProgressSignal:
      searchProgressSignal > 0 ? searchProgressSignal : undefined,
    calibrationTargetCount: calibrated?.calibrationTargetCount,
    calibrationVertexCount: calibrated?.calibrationVertexCount,
    targetSpecificity,
    seedModality: args.seedModality,
    seedSimilarity: args.seedSimilarity,
    seedTargetSimilarity: args.seedTargetSimilarity,
    seedSpecificity: args.seedSpecificity,
    seedPromptAdherence: args.seedPromptAdherence,
    seedPromptPenalty: args.seedPromptPenalty,
    penalty: penalty > 0 ? penalty : undefined,
    seedAdherence,
    coherence,
    diversity,
    total:
      adjustedSimilarity + searchProgressSignal + auxiliarySignal - penalty,
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
  if (a.length !== b.length) {
    return 0;
  }
  const length = a.length;
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

  const similarities = args.targets.map((target) =>
    cosineSimilarity(args.candidate, flattenTrace(target)),
  );
  const nonSelfSimilarities = similarities.filter(
    (similarity) => similarity < SELF_MATCH_SIMILARITY,
  );

  return Math.max(
    ...(nonSelfSimilarities.length > 0 ? nonSelfSimilarities : similarities),
  );
}

function calibratedRetrievalSimilarity(args: {
  target: number[];
  candidate: number[];
  contrastTargets: ActivationTrace[];
}):
  | {
      calibratedSimilarity: number;
      discriminativeSimilarity: number;
      retrievalMargin: number;
      nearMissSimilarity: number;
      cslsSimilarity: number;
      hubnessPenalty: number;
      searchProgressSignal: number;
      calibrationTargetCount: number;
      calibrationVertexCount: number;
    }
  | undefined {
  if (args.contrastTargets.length < MIN_CALIBRATED_CONTRAST_TARGETS) {
    return undefined;
  }

  const contrastVectors = args.contrastTargets.map(flattenTrace);
  const prototype = meanVector(contrastVectors);
  const standardDeviations = standardDeviationVector(
    contrastVectors,
    prototype,
  );
  const selectedVertices = topTargetSpecificityIndices(
    args.target,
    prototype,
    standardDeviations,
    calibrationVertexCount(args.target.length),
  );
  if (selectedVertices.length === 0) {
    return undefined;
  }

  const target = selectCentered(args.target, prototype, selectedVertices);
  const candidate = selectCentered(args.candidate, prototype, selectedVertices);
  const contrasts = contrastVectors.map((contrast) =>
    selectCentered(contrast, prototype, selectedVertices),
  );
  if (vectorNorm(target) <= 1e-9 || vectorNorm(candidate) <= 1e-9) {
    return undefined;
  }

  const discriminativeSimilarity = cosineSimilarity(target, candidate);
  const candidateContrastSimilarities = withoutSelfMatches(
    contrasts.map((contrast) => cosineSimilarity(candidate, contrast)),
  ).sort((left, right) => right - left);
  const targetContrastSimilarities = contrasts
    .map((contrast) => cosineSimilarity(target, contrast))
    .sort((left, right) => right - left);
  const nearestContrastSimilarity = candidateContrastSimilarities[0] ?? 0;
  const neighborCount = Math.min(3, contrasts.length);
  const candidateNeighborhood = mean(
    candidateContrastSimilarities.slice(0, neighborCount),
  );
  const targetNeighborhood = mean(
    targetContrastSimilarities.slice(0, neighborCount),
  );
  const cslsSimilarity =
    2 * discriminativeSimilarity - candidateNeighborhood - targetNeighborhood;
  const retrievalMargin = discriminativeSimilarity - nearestContrastSimilarity;
  const calibratedBase = 0.5 + 0.5 * Math.tanh(cslsSimilarity);
  const nearMissSimilarity =
    calibratedBase * retrievalMarginNearMissConfidence(retrievalMargin);
  const retrievalWinSimilarity =
    calibratedBase * retrievalMarginConfidence(retrievalMargin);

  return {
    calibratedSimilarity: Math.max(
      retrievalWinSimilarity,
      nearMissSimilarity * NEAR_MISS_CALIBRATED_WEIGHT,
    ),
    discriminativeSimilarity,
    retrievalMargin,
    nearMissSimilarity,
    cslsSimilarity,
    hubnessPenalty: Math.max(0, candidateNeighborhood),
    searchProgressSignal: nearMissSimilarity,
    calibrationTargetCount: contrastVectors.length + 1,
    calibrationVertexCount: selectedVertices.length,
  };
}

function withoutSelfMatches(similarities: number[]): number[] {
  const nonSelfSimilarities = similarities.filter(
    (similarity) => similarity < SELF_MATCH_SIMILARITY,
  );
  return nonSelfSimilarities.length > 0 ? nonSelfSimilarities : similarities;
}

function residualizedSimilarity(args: {
  target: number[];
  candidate: number[];
  contrastTargets: ActivationTrace[];
}): number | undefined {
  if (args.contrastTargets.length < MIN_RESIDUAL_CONTRAST_TARGETS) {
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

function sameLengthContrastTargets(
  targets: ActivationTrace[],
  vectorLength: number,
): ActivationTrace[] {
  return targets.filter(
    (target) => flattenTrace(target).length === vectorLength,
  );
}

function calibrationVertexCount(vectorLength: number): number {
  if (vectorLength < 128) {
    return Math.max(4, Math.floor(vectorLength * 0.25));
  }
  return Math.min(512, Math.max(32, Math.floor(vectorLength * 0.005)));
}

function topTargetSpecificityIndices(
  target: number[],
  prototype: number[],
  standardDeviations: number[],
  count: number,
): number[] {
  return target
    .map((value, index) => ({
      index,
      targetSpecificity: Math.abs(
        (value - (prototype[index] ?? 0)) /
          ((standardDeviations[index] ?? 0) + 0.05),
      ),
    }))
    .sort((left, right) => right.targetSpecificity - left.targetSpecificity)
    .slice(0, count)
    .map((item) => item.index)
    .sort((left, right) => left - right);
}

function meanVector(vectors: number[][]): number[] {
  const length = vectors[0]?.length ?? 0;
  const result = new Array<number>(length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < length; index += 1) {
      result[index] += vector[index] ?? 0;
    }
  }
  return result.map((value) => value / vectors.length);
}

function standardDeviationVector(
  vectors: number[][],
  meanValues: number[],
): number[] {
  return meanValues.map((meanValue, index) => {
    let sum = 0;
    for (const vector of vectors) {
      sum += ((vector[index] ?? 0) - meanValue) ** 2;
    }
    return Math.sqrt(sum / vectors.length);
  });
}

function selectCentered(
  vector: number[],
  prototype: number[],
  indices: number[],
): number[] {
  return indices.map((index) => (vector[index] ?? 0) - (prototype[index] ?? 0));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function retrievalMarginConfidence(retrievalMargin: number): number {
  return clamp01(retrievalMargin / 0.35);
}

function retrievalMarginNearMissConfidence(retrievalMargin: number): number {
  return clamp01((retrievalMargin + 0.15) / 0.15);
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

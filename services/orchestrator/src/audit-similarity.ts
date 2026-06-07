import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActivationTrace,
  type EvaluatedOutput,
  scoreActivations,
} from "@volta/core";
import { loadCalibrationActivations } from "./calibration.ts";

type TargetArtifact = {
  rendered: {
    preview: string;
    sha256: string;
    kind: string;
  };
  activation: ActivationTrace;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rawArgs = process.argv.slice(2);
const autoCalibration = !rawArgs.includes("--no-auto-calibration");
const maxCalibration =
  Number.parseInt(
    rawArgs
      .find((arg) => arg.startsWith("--max-calibration="))
      ?.slice("--max-calibration=".length) ?? "",
    10,
  ) || 96;
const targetPaths = rawArgs.filter((arg) => !arg.startsWith("--"));
const scorePaths = rawArgs
  .filter((arg) => arg.startsWith("--scores="))
  .map((arg) => arg.slice("--scores=".length));

if (targetPaths.length < 2) {
  throw new Error(
    "Usage: bun services/orchestrator/src/audit-similarity.ts <target.json> <target.json>... [--scores=scores.json] [--no-auto-calibration] [--max-calibration=96]",
  );
}

const targets = targetPaths.map((path) => ({
  path,
  label: targetLabel(path, readJson<TargetArtifact>(path)),
  artifact: readJson<TargetArtifact>(path),
}));
const contrastBankCache = new Map<number, ActivationTrace[]>();

console.log("targets");
for (const target of targets) {
  console.log(
    JSON.stringify({
      label: target.label,
      path: target.path,
      preview: target.artifact.rendered.preview,
      model: target.artifact.activation.model,
      shape: target.artifact.activation.shape,
      summary: target.artifact.activation.summary,
    }),
  );
}

console.log(
  JSON.stringify({
    autoCalibration,
    maxCalibration,
  }),
);

console.log("\ntarget_pairs");
for (let left = 0; left < targets.length - 1; left += 1) {
  for (let right = left + 1; right < targets.length; right += 1) {
    const forward = scoreActivations({
      target: targets[left].artifact.activation,
      candidate: targets[right].artifact.activation,
      contrastTargets: contrastBankForTarget(left),
    });
    const reverse = scoreActivations({
      target: targets[right].artifact.activation,
      candidate: targets[left].artifact.activation,
      contrastTargets: contrastBankForTarget(right),
    });
    console.log(
      JSON.stringify({
        left: targets[left].label,
        right: targets[right].label,
        neuralSimilarity: forward.neuralSimilarity,
        retrievalAdjustedSimilarity:
          (forward.adjustedSimilarity + reverse.adjustedSimilarity) / 2,
        forwardAdjustedSimilarity: forward.adjustedSimilarity,
        reverseAdjustedSimilarity: reverse.adjustedSimilarity,
        forwardRetrievalMargin: forward.retrievalMargin,
        reverseRetrievalMargin: reverse.retrievalMargin,
        forwardDiscriminativeSimilarity: forward.discriminativeSimilarity,
        reverseDiscriminativeSimilarity: reverse.discriminativeSimilarity,
        forwardSearchProgressSignal: forward.searchProgressSignal,
        reverseSearchProgressSignal: reverse.searchProgressSignal,
        residualSimilarity: forward.residualSimilarity,
        calibratedSimilarity: forward.calibratedSimilarity,
        calibrationTargetCount: forward.calibrationTargetCount,
        calibrationVertexCount: forward.calibrationVertexCount,
      }),
    );
  }
}

for (const scorePath of scorePaths) {
  if (!existsSync(scorePath)) {
    continue;
  }
  const outputs = readJson<EvaluatedOutput[]>(scorePath);
  console.log(`\noutputs ${scorePath}`);
  for (const output of outputs) {
    if (!output.activation.values) {
      continue;
    }
    console.log(
      JSON.stringify({
        agentId: output.agentId,
        text:
          output.rendered.preview ??
          (output.outputNode.type === "text"
            ? output.outputNode.payload.text
            : undefined),
        scores: targets.map((target) => {
          const targetIndex = targets.indexOf(target);
          const score = scoreActivations({
            target: target.artifact.activation,
            candidate: output.activation,
            contrastTargets: contrastBankForTarget(targetIndex),
          });
          return {
            target: target.label,
            neuralSimilarity: score.neuralSimilarity,
            calibratedSimilarity: score.calibratedSimilarity,
            discriminativeSimilarity: score.discriminativeSimilarity,
            residualSimilarity: score.residualSimilarity,
            retrievalMargin: score.retrievalMargin,
            cslsSimilarity: score.cslsSimilarity,
            hubnessPenalty: score.hubnessPenalty,
            searchProgressSignal: score.searchProgressSignal,
            adjustedSimilarity: score.adjustedSimilarity,
            total: score.total,
          };
        }),
      }),
    );
  }
}

function contrastBankForTarget(targetIndex: number): ActivationTrace[] {
  const cached = contrastBankCache.get(targetIndex);
  if (cached) {
    return cached;
  }

  const current = targets[targetIndex];
  const listedTargets = targets
    .filter((_, index) => index !== targetIndex)
    .map((target) => target.artifact.activation);
  if (!autoCalibration) {
    contrastBankCache.set(targetIndex, listedTargets);
    return listedTargets;
  }

  const bank = uniqueActivations([
    ...listedTargets,
    ...loadCalibrationActivations({
      repoRoot: REPO_ROOT,
      targetActivation: current.artifact.activation,
      targetSha: current.artifact.rendered.sha256,
      maxActivations: maxCalibration,
    }),
  ]);
  contrastBankCache.set(targetIndex, bank);
  return bank;
}

function uniqueActivations(activations: ActivationTrace[]): ActivationTrace[] {
  const seen = new Set<string>();
  return activations.filter((activation) => {
    const key = activationKey(activation);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function activationKey(activation: ActivationTrace): string {
  const firstValues = activation.values?.[0]?.slice(0, 8) ?? [];
  return [
    activation.model,
    activation.shape.join("x"),
    activation.summary.norm.toFixed(6),
    ...firstValues.map((value) => value.toFixed(6)),
  ].join(":");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function targetLabel(path: string, artifact: TargetArtifact): string {
  const preview = artifact.rendered.preview.toLowerCase();
  if (preview.includes("mona")) {
    return "mona-image";
  }
  if (preview.includes("backrooms")) {
    return "backrooms-image";
  }
  if (preview.includes("dog")) {
    return "dog-image";
  }
  return basename(path);
}

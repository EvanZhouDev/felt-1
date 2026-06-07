import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  type ActivationTrace,
  type EvaluatedOutput,
  scoreActivations,
} from "@volta/core";

type TargetArtifact = {
  rendered: {
    preview: string;
    sha256: string;
    kind: string;
  };
  activation: ActivationTrace;
};

const targetPaths = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--scores="));
const scorePaths = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("--scores="))
  .map((arg) => arg.slice("--scores=".length));

if (targetPaths.length < 2) {
  throw new Error(
    "Usage: bun services/orchestrator/src/audit-similarity.ts <target.json> <target.json>... [--scores=scores.json]",
  );
}

const targets = targetPaths.map((path) => ({
  path,
  label: targetLabel(path, readJson<TargetArtifact>(path)),
  artifact: readJson<TargetArtifact>(path),
}));

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

console.log("\ntarget_pairs");
for (let left = 0; left < targets.length - 1; left += 1) {
  for (let right = left + 1; right < targets.length; right += 1) {
    const score = scoreActivations({
      target: targets[left].artifact.activation,
      candidate: targets[right].artifact.activation,
      contrastTargets: targets
        .filter((_, index) => index !== left && index !== right)
        .map((target) => target.artifact.activation),
    });
    console.log(
      JSON.stringify({
        left: targets[left].label,
        right: targets[right].label,
        neuralSimilarity: score.neuralSimilarity,
        residualSimilarity: score.residualSimilarity,
        adjustedSimilarity: score.adjustedSimilarity,
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
          const contrastTargets = targets
            .filter((candidate) => candidate !== target)
            .map((candidate) => candidate.artifact.activation);
          const score = scoreActivations({
            target: target.artifact.activation,
            candidate: output.activation,
            contrastTargets,
          });
          return {
            target: target.label,
            neuralSimilarity: score.neuralSimilarity,
            residualSimilarity: score.residualSimilarity,
            adjustedSimilarity: score.adjustedSimilarity,
          };
        }),
      }),
    );
  }
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

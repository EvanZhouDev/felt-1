import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ActivationTrace,
  cosineSimilarity,
  type EvaluatedOutput,
  flattenTrace,
} from "@volta/core";

const NEAR_DUPLICATE_TARGET_SIMILARITY = 0.995;

type TargetArtifact = {
  rendered?: {
    sha256?: string;
    kind?: string;
  };
  activation?: ActivationTrace;
};

export function loadCalibrationActivations(args: {
  repoRoot: string;
  runsRoot?: string;
  targetActivation: ActivationTrace;
  targetSha?: string;
  explicitTargetRoots?: string[];
  maxActivations?: number;
  includeScoreActivations?: boolean;
  targetKind?: string;
  additionalRenderedKinds?: string[];
}): ActivationTrace[] {
  const maxActivations = args.maxActivations ?? 96;
  const items: CalibrationItem[] = [];
  const seen = new Set<string>();
  const addItem = (item: CalibrationItem, limit = maxActivations) => {
    if (items.length >= limit) {
      return false;
    }
    if (!usableCalibrationItem(item, args)) {
      return false;
    }
    if (seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    items.push(item);
    return true;
  };
  const targetCacheItems = targetCacheRoots(args).flatMap(loadTargetCacheItems);
  const targetCacheLimit = Math.min(
    maxActivations,
    Math.max(8, Math.floor(maxActivations / 2)),
  );

  for (const item of targetCacheItems) {
    addItem(item, targetCacheLimit);
  }

  if (args.includeScoreActivations !== false) {
    for (const scorePath of aggregateScoreFiles(args.repoRoot, args.runsRoot)) {
      if (items.length >= maxActivations) {
        break;
      }
      const sourceTarget = scoreTargetArtifact(scorePath);
      if (sameSourceTarget(sourceTarget, args)) {
        continue;
      }
      for (const item of loadScoreItems(
        scorePath,
        sourceTarget?.rendered?.sha256,
      )) {
        addItem(item);
      }
    }
  }

  for (const item of targetCacheItems) {
    addItem(item);
  }

  return items.map((item) => item.activation);
}

type CalibrationItem = {
  key: string;
  activation: ActivationTrace;
  sourceTargetSha?: string;
  renderedKind?: string;
};

function targetCacheRoots(args: {
  repoRoot: string;
  runsRoot?: string;
  explicitTargetRoots?: string[];
}): string[] {
  return uniqueStrings([
    ...(args.runsRoot
      ? [resolve(join(args.runsRoot, "..", "target-cache"))]
      : []),
    ...discoverTargetCacheRoots(args.repoRoot),
    ...(args.explicitTargetRoots ?? []),
  ]);
}

function loadTargetCacheItems(root: string): CalibrationItem[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root)
    .sort()
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      const cachedTarget = readOptionalJson<TargetArtifact>(join(root, entry));
      if (!cachedTarget?.activation) {
        return [];
      }
      const sha = cachedTarget.rendered?.sha256 ?? entry;
      return [
        {
          key: `target:${cachedTarget.activation.model}:${sha}`,
          activation: cachedTarget.activation,
          sourceTargetSha: sha,
          renderedKind: cachedTarget.rendered?.kind,
        },
      ];
    });
}

function aggregateScoreFiles(repoRoot: string, runsRoot?: string): string[] {
  return uniqueStrings(
    [
      ...(runsRoot ? [runsRoot] : []),
      join(repoRoot, ".volta"),
      join(repoRoot, "services/orchestrator/.volta"),
    ].flatMap((root) => findAggregateScoreFiles(root, 8)),
  ).sort();
}

function loadScoreItems(
  scorePath: string,
  sourceTargetSha: string | undefined,
): CalibrationItem[] {
  const outputs = readOptionalJson<EvaluatedOutput[]>(scorePath);
  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs.flatMap((output, index) => {
    if (!output.activation?.values) {
      return [];
    }
    const renderedSha = output.rendered?.sha256;
    const key = renderedSha
      ? `score:${output.activation.model}:${renderedSha}`
      : `score:${output.activation.model}:${scorePath}:${index}`;
    return [
      {
        key,
        activation: output.activation,
        sourceTargetSha,
        renderedKind: output.rendered?.kind,
      },
    ];
  });
}

function usableCalibrationItem(
  item: CalibrationItem,
  args: {
    targetActivation: ActivationTrace;
    targetSha?: string;
    targetKind?: string;
    additionalRenderedKinds?: string[];
  },
): boolean {
  const allowedKinds = new Set(
    [args.targetKind, ...(args.additionalRenderedKinds ?? [])].filter(
      (kind): kind is string => Boolean(kind),
    ),
  );
  return Boolean(
    item.activation.values &&
      item.activation.model === args.targetActivation.model &&
      sameActivationShape(item.activation, args.targetActivation) &&
      (allowedKinds.size === 0 || allowedKinds.has(item.renderedKind ?? "")) &&
      !nearDuplicateTarget(item.activation, args.targetActivation) &&
      (!args.targetSha || item.sourceTargetSha !== args.targetSha),
  );
}

function nearDuplicateTarget(
  activation: ActivationTrace,
  target: ActivationTrace,
): boolean {
  if (!sameActivationShape(activation, target)) {
    return false;
  }
  return (
    cosineSimilarity(flattenTrace(activation), flattenTrace(target)) >=
    NEAR_DUPLICATE_TARGET_SIMILARITY
  );
}

function scoreTargetArtifact(scorePath: string): TargetArtifact | undefined {
  return (
    readOptionalJson<TargetArtifact>(join(dirname(scorePath), "target.json")) ??
    readOptionalJson<TargetArtifact>(
      join(dirname(scorePath), "..", "..", "target.json"),
    )
  );
}

function sameSourceTarget(
  sourceTarget: TargetArtifact | undefined,
  args: {
    targetActivation: ActivationTrace;
    targetSha?: string;
  },
): boolean {
  return Boolean(
    (sourceTarget?.rendered?.sha256 &&
      sourceTarget.rendered.sha256 === args.targetSha) ||
      (sourceTarget?.activation &&
        nearDuplicateTarget(sourceTarget.activation, args.targetActivation)),
  );
}

function discoverTargetCacheRoots(repoRoot: string): string[] {
  return uniqueStrings(
    [join(repoRoot, ".volta"), join(repoRoot, "services/orchestrator/.volta")]
      .flatMap((root) => findTargetCacheRoots(root, 5))
      .map((root) => resolve(root)),
  ).sort();
}

function findTargetCacheRoots(root: string, maxDepth: number): string[] {
  if (maxDepth < 0 || !existsSync(root)) {
    return [];
  }
  const roots: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.name === "target-cache") {
      roots.push(path);
      continue;
    }
    roots.push(...findTargetCacheRoots(path, maxDepth - 1));
  }
  return roots;
}

function findAggregateScoreFiles(root: string, maxDepth: number): string[] {
  if (maxDepth < 0 || !existsSync(root)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...findAggregateScoreFiles(path, maxDepth - 1));
      continue;
    }
    if (entry.name === "scores.json") {
      paths.push(path);
    }
  }
  return paths;
}

function sameActivationShape(
  left: ActivationTrace,
  right: ActivationTrace,
): boolean {
  return left.shape[0] === right.shape[0] && left.shape[1] === right.shape[1];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function readOptionalJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

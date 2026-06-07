import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivationTrace, ImagePayload } from "@volta/core";
import { scoreActivations } from "@volta/core";
import { loadCalibrationActivations } from "./calibration.ts";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

type TargetFile = {
  rendered?: {
    sha256?: string;
    kind?: string;
  };
  activation: ActivationTrace;
};

type ImageProbe = {
  id?: string;
  image: string;
  video?: string;
  mime?: string;
  durationSec?: number;
  fps?: number;
  fit?: ImagePayload["fit"];
  background?: string;
};

type ProbeResult = {
  id: string;
  image: string;
  video?: string;
  neuralSimilarity: number;
  adjustedSimilarity: number;
  calibratedSimilarity?: number;
  rawAdjustedSimilarity?: number;
  contrastSimilarity?: number;
  discriminativeSimilarity?: number;
  residualSimilarity?: number;
  residualAdjustedSimilarity?: number;
  retrievalMargin?: number;
  nearMissSimilarity?: number;
  cslsSimilarity?: number;
  hubnessPenalty?: number;
  searchProgressSignal?: number;
  calibrationVertexCount?: number;
  targetSpecificity?: number;
  total: number;
  activation: {
    model: string;
    shape: [number, number];
    summary: ActivationTrace["summary"];
  };
};

const args = parseArgs(process.argv.slice(2));
if (!args.target || !args.images) {
  throw new Error(
    "Usage: bun services/orchestrator/src/probe-images.ts --target target.json --images images.json [--out results.json] [--calibrated]",
  );
}

const target = JSON.parse(await readFile(args.target, "utf8")) as TargetFile;
const probes = normalizeImageProbes(
  JSON.parse(await readFile(args.images, "utf8")) as unknown,
);
const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  oracleMode: args.oracle ?? baseConfig.oracleMode,
};
const contrastTargets = args.calibrated
  ? loadCalibrationActivations({
      repoRoot: config.repoRoot,
      runsRoot: config.runsRoot,
      targetActivation: target.activation,
      targetSha: target.rendered?.sha256,
      targetKind: target.rendered?.kind,
      additionalRenderedKinds: [],
      includeScoreActivations: target.rendered?.kind === "video",
    })
  : [];
const oracle = createOracle(config);
const createdAt = new Date().toISOString();

try {
  const results: ProbeResult[] = [];
  for (const [index, probe] of probes.entries()) {
    const id = probe.id ?? `probe-${String(index + 1).padStart(2, "0")}`;
    try {
      const payload = imagePayload(probe);
      const rendered = await renderPayload(payload);
      const activation = await oracle.encode(rendered.encoderInput);
      const score = scoreActivations({
        target: target.activation,
        candidate: activation,
        contrastTargets,
        diversity: 0.5,
        useResidualAdjustedSimilarity: target.rendered?.kind === "video",
        useRawAdjustedSimilarity: target.rendered?.kind !== "video",
      });
      results.push({
        id,
        image: probe.image,
        video: probe.video,
        neuralSimilarity: score.neuralSimilarity,
        adjustedSimilarity: score.adjustedSimilarity,
        calibratedSimilarity: score.calibratedSimilarity,
        rawAdjustedSimilarity: score.rawAdjustedSimilarity,
        contrastSimilarity: score.contrastSimilarity,
        discriminativeSimilarity: score.discriminativeSimilarity,
        residualSimilarity: score.residualSimilarity,
        residualAdjustedSimilarity: score.residualAdjustedSimilarity,
        retrievalMargin: score.retrievalMargin,
        nearMissSimilarity: score.nearMissSimilarity,
        cslsSimilarity: score.cslsSimilarity,
        hubnessPenalty: score.hubnessPenalty,
        searchProgressSignal: score.searchProgressSignal,
        calibrationVertexCount: score.calibrationVertexCount,
        targetSpecificity: score.targetSpecificity,
        total: score.total,
        activation: {
          model: activation.model,
          shape: activation.shape,
          summary: activation.summary,
        },
      });
      console.log(
        [
          id,
          score.neuralSimilarity.toFixed(6),
          score.adjustedSimilarity.toFixed(6),
          score.total.toFixed(6),
          probe.image,
        ].join("\t"),
      );
      await writeProbeReport(results, { status: "partial" });
    } catch (error) {
      await writeProbeReport(results, {
        status: "failed",
        error: `Probe ${id} failed: ${error}`,
      });
      throw error;
    }
  }

  const report = await writeProbeReport(results, { status: "completed" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await oracle.shutdown?.();
}

async function writeProbeReport(
  results: ProbeResult[],
  options: {
    status: "partial" | "completed" | "failed";
    error?: string;
  },
) {
  const report = {
    target: args.target,
    images: args.images,
    oracleMode: config.oracleMode,
    createdAt,
    updatedAt: new Date().toISOString(),
    status: options.status,
    error: options.error,
    calibrated: args.calibrated === true,
    contrastTargetCount: contrastTargets.length,
    results: [...results].sort((left, right) => right.total - left.total),
  };

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function imagePayload(probe: ImageProbe): ImagePayload {
  return {
    type: "image",
    source: {
      uri: probe.image,
      mime: probe.mime ?? mimeFromPath(probe.image),
    },
    ...(probe.video
      ? {
          cachedVideo: {
            uri: probe.video,
            mime: "video/mp4",
          },
        }
      : {}),
    timing: {
      durationSec: probe.durationSec ?? 0.5,
      fps: probe.fps ?? 2,
    },
    fit: probe.fit ?? "contain",
    background: probe.background ?? "#000000",
  };
}

function normalizeImageProbes(value: unknown): ImageProbe[] {
  if (!Array.isArray(value)) {
    throw new Error("Image probes must be a JSON array.");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { image: item };
    }
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { image?: unknown }).image !== "string"
    ) {
      throw new Error(`Invalid image probe at index ${index}.`);
    }
    const probe = item as ImageProbe;
    if (probe.video !== undefined && typeof probe.video !== "string") {
      throw new Error(`Invalid video path for image probe at index ${index}.`);
    }
    return probe;
  });
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/png";
}

function parseArgs(argv: string[]): {
  target?: string;
  images?: string;
  out?: string;
  oracle?: "mock" | "tribe" | "http";
  calibrated?: boolean;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--calibrated") {
      parsed.calibrated = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (flag === "--target") {
      parsed.target = value;
      index += 1;
    } else if (flag === "--images") {
      parsed.images = value;
      index += 1;
    } else if (flag === "--out") {
      parsed.out = value;
      index += 1;
    } else if (flag === "--oracle") {
      if (!["mock", "tribe", "http"].includes(value)) {
        throw new Error(`Invalid oracle mode: ${value}`);
      }
      parsed.oracle = value as "mock" | "tribe" | "http";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}.`);
    }
  }
  return parsed;
}

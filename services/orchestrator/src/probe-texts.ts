import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivationTrace } from "@volta/core";
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

type TextProbe = {
  id?: string;
  text: string;
};

type ProbeResult = {
  id: string;
  text: string;
  neuralSimilarity: number;
  adjustedSimilarity: number;
  calibratedSimilarity?: number;
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
if (!args.target || !args.texts) {
  throw new Error(
    "Usage: bun services/orchestrator/src/probe-texts.ts --target target.json --texts texts.json [--out results.json] [--calibrated]",
  );
}

const target = JSON.parse(await readFile(args.target, "utf8")) as TargetFile;
const probes = normalizeTextProbes(
  JSON.parse(await readFile(args.texts, "utf8")) as unknown,
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
      additionalRenderedKinds: target.rendered?.kind === "text" ? [] : ["text"],
      includeScoreActivations: target.rendered?.kind === "text",
    })
  : [];
const oracle = createOracle(config);
const createdAt = new Date().toISOString();

try {
  const results: ProbeResult[] = [];
  for (const [index, probe] of probes.entries()) {
    const id = probe.id ?? `probe-${String(index + 1).padStart(2, "0")}`;
    try {
      const rendered = await renderPayload({
        type: "text",
        text: probe.text,
      });
      const activation = await oracle.encode(rendered.encoderInput);
      const score = scoreActivations({
        target: target.activation,
        candidate: activation,
        contrastTargets,
        diversity: 0.5,
      });
      results.push({
        id,
        text: probe.text,
        neuralSimilarity: score.neuralSimilarity,
        adjustedSimilarity: score.adjustedSimilarity,
        calibratedSimilarity: score.calibratedSimilarity,
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
          probe.text.slice(0, 100),
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
    texts: args.texts,
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

function normalizeTextProbes(value: unknown): TextProbe[] {
  if (!Array.isArray(value)) {
    throw new Error("Text probes must be a JSON array.");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { text: item };
    }
    if (
      item &&
      typeof item === "object" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      return item as TextProbe;
    }
    throw new Error(`Invalid text probe at index ${index}.`);
  });
}

function parseArgs(argv: string[]): {
  target?: string;
  texts?: string;
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
    } else if (flag === "--texts") {
      parsed.texts = value;
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
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

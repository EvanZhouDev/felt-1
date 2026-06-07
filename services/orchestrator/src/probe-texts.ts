import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivationTrace } from "@volta/core";
import { scoreActivations } from "@volta/core";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

type TargetFile = {
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
    "Usage: bun services/orchestrator/src/probe-texts.ts --target target.json --texts texts.json [--out results.json]",
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
        diversity: 0.5,
      });
      results.push({
        id,
        text: probe.text,
        neuralSimilarity: score.neuralSimilarity,
        total: score.total,
        activation: {
          model: activation.model,
          shape: activation.shape,
          summary: activation.summary,
        },
      });
      console.log(
        `${id}\t${score.neuralSimilarity.toFixed(6)}\t${probe.text.slice(
          0,
          100,
        )}`,
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
    results: [...results].sort(
      (left, right) => right.neuralSimilarity - left.neuralSimilarity,
    ),
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
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
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

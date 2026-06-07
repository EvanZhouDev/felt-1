import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TextPayload } from "@volta/core";
import { loadConfig, type OracleMode } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

const TEXT_CALIBRATION_LIBRARY = [
  "A dog.",
  "A puppy sits in grass.",
  "A person faces the viewer.",
  "A dark-haired person sits for a portrait.",
  "An empty yellow room.",
  "A hallway opens into a carpeted room.",
  "A forest landscape.",
  "A mountain landscape.",
  "A city street.",
  "A beach scene.",
  "A plate of food.",
  "An abstract image.",
  "A close portrait with folded hands.",
  "A bright outdoor scene.",
  "A dim indoor scene.",
  "A warm textured painting.",
];

const args = parseArgs(process.argv.slice(2));
const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  oracleMode: args.oracle ?? baseConfig.oracleMode,
};
const outRoot = resolve(
  args.outRoot ?? join(baseConfig.repoRoot, ".volta/calibration-text"),
);
const targetCacheRoot = join(outRoot, "target-cache");
const oracle = createOracle(config);

try {
  await mkdir(targetCacheRoot, { recursive: true });
  const texts = TEXT_CALIBRATION_LIBRARY.slice(0, args.limit);
  const results = [];

  for (const [index, text] of texts.entries()) {
    const payload: TextPayload = {
      type: "text",
      text,
    };
    const rendered = await renderPayload(payload);
    const cachePath = join(
      targetCacheRoot,
      `${oracleCacheKey(oracle.model)}-${rendered.sha256}.json`,
    );

    if (existsSync(cachePath) && !args.force) {
      results.push({
        text,
        cachePath,
        status: "skipped-existing",
      });
      continue;
    }

    const activation = await oracle.encode(rendered.encoderInput);
    await writeJson(cachePath, {
      rendered,
      activation,
    });
    results.push({
      text,
      cachePath,
      status: "encoded",
      model: activation.model,
      summary: activation.summary,
    });
    console.log(
      [
        "encoded",
        `text-${String(index + 1).padStart(2, "0")}`,
        activation.model,
        activation.summary.norm.toFixed(6),
        text,
      ].join("\t"),
    );
  }

  console.log(
    JSON.stringify(
      {
        oracleMode: config.oracleMode,
        targetCacheRoot,
        count: results.length,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await oracle.shutdown?.();
}

function oracleCacheKey(model: string | undefined): string {
  return (model ?? "unknown-oracle").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv: string[]): {
  outRoot?: string;
  oracle?: OracleMode;
  limit?: number;
  force?: boolean;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") {
      parsed.force = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (flag === "--out-root") {
      parsed.outRoot = value;
      index += 1;
    } else if (flag === "--oracle") {
      if (!["mock", "tribe", "http"].includes(value)) {
        throw new Error(`Invalid oracle mode: ${value}`);
      }
      parsed.oracle = value as OracleMode;
      index += 1;
    } else if (flag === "--limit") {
      parsed.limit = positiveInteger(value, flag);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

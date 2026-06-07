import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ImagePayload } from "@volta/core";
import { loadConfig, type OracleMode } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

const args = parseArgs(process.argv.slice(2));
const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  oracleMode: args.oracle ?? baseConfig.oracleMode,
};
const imagesRoot = resolve(
  args.imagesRoot ??
    join(baseConfig.repoRoot, ".volta/calibration-assets/images"),
);
const videosRoot = resolve(
  args.videosRoot ??
    join(baseConfig.repoRoot, ".volta/calibration-assets/videos"),
);
const outRoot = resolve(
  args.outRoot ?? join(baseConfig.repoRoot, ".volta/calibration-local"),
);
const targetCacheRoot = join(outRoot, "target-cache");
const oracle = createOracle(config);

try {
  await mkdir(targetCacheRoot, { recursive: true });
  const imagePaths = (await calibrationImagePaths(imagesRoot)).slice(
    0,
    args.limit,
  );
  const results = [];

  for (const imagePath of imagePaths) {
    const stem = basename(imagePath, extname(imagePath));
    const videoPath = join(videosRoot, `${stem}-0.5s.mp4`);
    const payload: ImagePayload = {
      type: "image",
      source: {
        uri: imagePath,
        mime: mimeForImage(imagePath),
      },
      ...(existsSync(videoPath)
        ? {
            cachedVideo: {
              uri: videoPath,
              mime: "video/mp4",
            },
          }
        : {}),
      timing: {
        durationSec: 0.5,
        fps: 2,
      },
      fit: "contain",
      background: "#000000",
    };
    const rendered = await renderPayload(payload);
    const cachePath = join(
      targetCacheRoot,
      `${oracleCacheKey(oracle.model)}-${rendered.sha256}.json`,
    );

    if (existsSync(cachePath) && !args.force) {
      results.push({
        imagePath,
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
      imagePath,
      cachePath,
      status: "encoded",
      model: activation.model,
      summary: activation.summary,
    });
    console.log(
      [
        "encoded",
        stem,
        activation.model,
        activation.summary.norm.toFixed(6),
        cachePath,
      ].join("\t"),
    );
  }

  console.log(
    JSON.stringify(
      {
        oracleMode: config.oracleMode,
        imagesRoot,
        videosRoot,
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

async function calibrationImagePaths(root: string): Promise<string[]> {
  return (await readdir(root))
    .filter((entry) => /\.(jpe?g|png)$/i.test(entry))
    .sort()
    .map((entry) => join(root, entry));
}

function mimeForImage(path: string): string {
  return extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

function oracleCacheKey(model: string | undefined): string {
  return (model ?? "unknown-oracle").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv: string[]): {
  imagesRoot?: string;
  videosRoot?: string;
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
    if (flag === "--images-root") {
      parsed.imagesRoot = value;
      index += 1;
    } else if (flag === "--videos-root") {
      parsed.videosRoot = value;
      index += 1;
    } else if (flag === "--out-root") {
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

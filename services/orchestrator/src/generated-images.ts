import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentOutput, ImagePayload } from "@volta/core";

const DEFAULT_FLUX_URL = "https://images.bryanhu.com";
const DEFAULT_FLUX_MODEL = "klein";
const DEFAULT_FLUX_STEPS = "4";
const DEFAULT_IMAGE_DURATION_SEC = 0.5;
const DEFAULT_IMAGE_FPS = 2;
const DEFAULT_FLUX_TIMEOUT_MS = 180_000;

export async function materializeGeneratedImageCandidate(args: {
  candidate: AgentOutput;
  runPath: string;
  fluxUrl?: string;
}): Promise<AgentOutput> {
  if (args.candidate.outputNode.type !== "image") {
    return args.candidate;
  }

  const materialized = await materializeFluxImagePayload({
    payload: args.candidate.outputNode.payload,
    runPath: args.runPath,
    agentId: args.candidate.agentId,
    fluxUrl: args.fluxUrl,
  });
  if (materialized === args.candidate.outputNode.payload) {
    return args.candidate;
  }

  return {
    ...args.candidate,
    entropy: [args.candidate.entropy, "materialized=flux-image"]
      .filter(Boolean)
      .join(" | "),
    outputNode: {
      type: "image",
      payload: materialized,
    },
  };
}

async function materializeFluxImagePayload(args: {
  payload: ImagePayload;
  runPath: string;
  agentId: string;
  fluxUrl?: string;
}): Promise<ImagePayload> {
  const request = parseFluxGenerationUri(args.payload.source.uri);
  if (!request) {
    return args.payload;
  }

  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error("Flux image generation URI is missing prompt.");
  }

  const model = request.model ?? DEFAULT_FLUX_MODEL;
  const steps = request.steps ?? DEFAULT_FLUX_STEPS;
  const seed = request.seed ?? stableSeed(prompt);
  const key = sha256(JSON.stringify({ prompt, model, steps, seed })).slice(
    0,
    16,
  );
  const assetRoot = join(args.runPath, "generated-assets", args.agentId);
  const imagePath = join(assetRoot, `${key}.png`);
  const videoPath = join(assetRoot, `${key}-0.5s.mp4`);
  await mkdir(assetRoot, { recursive: true });

  if (!existsSync(imagePath)) {
    await downloadFluxImage({
      url: args.fluxUrl ?? DEFAULT_FLUX_URL,
      prompt,
      model,
      steps,
      seed,
      outPath: imagePath,
    });
  }
  if (!existsSync(videoPath)) {
    await createStillVideo({
      imagePath,
      videoPath,
      durationSec:
        args.payload.timing?.durationSec ?? DEFAULT_IMAGE_DURATION_SEC,
      fps: args.payload.timing?.fps ?? DEFAULT_IMAGE_FPS,
    });
  }

  return {
    ...args.payload,
    source: {
      uri: imagePath,
      mime: "image/png",
    },
    cachedVideo: {
      uri: videoPath,
      mime: "video/mp4",
    },
    timing: {
      durationSec:
        args.payload.timing?.durationSec ?? DEFAULT_IMAGE_DURATION_SEC,
      fps: args.payload.timing?.fps ?? DEFAULT_IMAGE_FPS,
    },
    fit: args.payload.fit ?? "contain",
    background: args.payload.background ?? "#000000",
  };
}

function parseFluxGenerationUri(uri: string):
  | {
      prompt: string;
      model?: string;
      steps?: string;
      seed?: string;
    }
  | undefined {
  if (!uri.startsWith("flux://generate")) {
    return undefined;
  }

  const parsed = new URL(uri);
  return {
    prompt: parsed.searchParams.get("prompt") ?? "",
    model: parsed.searchParams.get("model") ?? undefined,
    steps: parsed.searchParams.get("steps") ?? undefined,
    seed: parsed.searchParams.get("seed") ?? undefined,
  };
}

async function downloadFluxImage(args: {
  url: string;
  prompt: string;
  model: string;
  steps: string;
  seed: string;
  outPath: string;
}): Promise<void> {
  const url = new URL("/generate", args.url.replace(/\/+$/, ""));
  url.searchParams.set("prompt", args.prompt);
  url.searchParams.set("model", args.model);
  url.searchParams.set("steps", args.steps);
  url.searchParams.set("seed", args.seed);

  const response = await fetchWithTimeout(url, DEFAULT_FLUX_TIMEOUT_MS);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Flux generation failed: ${response.status} ${detail}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Flux generation returned non-image response: ${detail}`);
  }

  await writeFile(args.outPath, new Uint8Array(await response.arrayBuffer()));
}

function createStillVideo(args: {
  imagePath: string;
  videoPath: string;
  durationSec: number;
  fps: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      args.imagePath,
      "-t",
      String(args.durationSec),
      "-r",
      String(args.fps),
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=black",
      "-pix_fmt",
      "yuv420p",
      args.videoPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg still-video generation failed: ${stderr}`));
    });
  });
}

async function fetchWithTimeout(
  url: URL,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function stableSeed(value: string): string {
  return String(Number.parseInt(sha256(value).slice(0, 8), 16));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

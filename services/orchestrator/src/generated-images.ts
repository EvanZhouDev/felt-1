import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentOutput, ImagePayload, RenderedStimulus } from "@volta/core";

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
  targetRendered?: RenderedStimulus;
  inheritTargetStyle?: boolean;
}): Promise<AgentOutput> {
  if (args.candidate.outputNode.type !== "image") {
    return args.candidate;
  }

  const targetStyle = args.inheritTargetStyle
    ? await targetImageStyle(args.targetRendered)
    : undefined;
  const materialized = await materializeFluxImagePayload({
    payload: args.candidate.outputNode.payload,
    runPath: args.runPath,
    agentId: args.candidate.agentId,
    fluxUrl: args.fluxUrl,
    targetStyle,
  });
  if (materialized === args.candidate.outputNode.payload) {
    return args.candidate;
  }

  const targetFidelity = targetStyle
    ? targetFidelityMode(targetStyle)
    : undefined;

  return {
    ...args.candidate,
    entropy: [
      args.candidate.entropy,
      "materialized=flux-image",
      targetStyle
        ? `targetStyle=${targetStyle.width}x${targetStyle.height}`
        : undefined,
      targetFidelity ? `targetFidelity=${targetFidelity}` : undefined,
    ]
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
  targetStyle?: ImageGeometry;
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
  const rawImagePath = join(assetRoot, `${key}.png`);
  const styledImagePath = join(assetRoot, `${key}-target-style.png`);
  const targetFidelity = args.targetStyle
    ? targetFidelityMode(args.targetStyle)
    : undefined;
  const fidelityImagePath = join(assetRoot, `${key}-target-fidelity.png`);
  const imagePath = targetFidelity
    ? fidelityImagePath
    : args.targetStyle
      ? styledImagePath
      : rawImagePath;
  const videoPath = join(
    assetRoot,
    targetFidelity
      ? `${key}-target-fidelity-0.5s.mp4`
      : args.targetStyle
        ? `${key}-target-style-0.5s.mp4`
        : `${key}-0.5s.mp4`,
  );
  await mkdir(assetRoot, { recursive: true });

  if (!existsSync(rawImagePath)) {
    await downloadFluxImage({
      url: args.fluxUrl ?? DEFAULT_FLUX_URL,
      prompt,
      model,
      steps,
      seed,
      outPath: rawImagePath,
    });
  }
  if (args.targetStyle && !existsSync(styledImagePath)) {
    await createTargetStyleImage({
      inputPath: rawImagePath,
      outputPath: styledImagePath,
      geometry: args.targetStyle,
    });
  }
  if (targetFidelity && !existsSync(fidelityImagePath)) {
    await createTargetFidelityImage({
      inputPath: styledImagePath,
      outputPath: fidelityImagePath,
      mode: targetFidelity,
    });
  }
  if (!existsSync(videoPath)) {
    await createStillVideo({
      imagePath,
      videoPath,
      durationSec:
        args.payload.timing?.durationSec ?? DEFAULT_IMAGE_DURATION_SEC,
      fps: args.payload.timing?.fps ?? DEFAULT_IMAGE_FPS,
      geometry: args.targetStyle,
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

type ImageGeometry = {
  width: number;
  height: number;
};

type TargetFidelityMode = "soft-muted";

async function targetImageStyle(
  targetRendered: RenderedStimulus | undefined,
): Promise<ImageGeometry | undefined> {
  const artifactPath = targetRendered?.encoderInput.artifactPath;
  const localPath = localArtifactPath(artifactPath);
  if (!localPath) {
    return undefined;
  }
  return probeVideoGeometry(localPath).catch(() => undefined);
}

function targetFidelityMode(
  geometry: ImageGeometry,
): TargetFidelityMode | undefined {
  const area = geometry.width * geometry.height;
  return area <= 512 * 512 ? "soft-muted" : undefined;
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

function createTargetStyleImage(args: {
  inputPath: string;
  outputPath: string;
  geometry: ImageGeometry;
}): Promise<void> {
  return runProcess("ffmpeg", [
    "-y",
    "-i",
    args.inputPath,
    "-vf",
    `scale=${args.geometry.width}:${args.geometry.height}:force_original_aspect_ratio=increase,crop=${args.geometry.width}:${args.geometry.height}`,
    "-frames:v",
    "1",
    "-update",
    "1",
    args.outputPath,
  ]).then(() => undefined);
}

function createTargetFidelityImage(args: {
  inputPath: string;
  outputPath: string;
  mode: TargetFidelityMode;
}): Promise<void> {
  const filter =
    args.mode === "soft-muted"
      ? "boxblur=0.8:1,eq=contrast=0.92:saturation=0.88:brightness=-0.02"
      : undefined;
  if (!filter) {
    throw new Error(`Unsupported target fidelity mode: ${args.mode}`);
  }
  return runProcess("ffmpeg", [
    "-y",
    "-i",
    args.inputPath,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-update",
    "1",
    args.outputPath,
  ]).then(() => undefined);
}

function createStillVideo(args: {
  imagePath: string;
  videoPath: string;
  durationSec: number;
  fps: number;
  geometry?: ImageGeometry;
}): Promise<void> {
  const geometry = args.geometry ?? { width: 512, height: 512 };
  return runProcess("ffmpeg", [
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
    `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=decrease,pad=${geometry.width}:${geometry.height}:-1:-1:color=black`,
    "-pix_fmt",
    "yuv420p",
    args.videoPath,
  ]).then(() => undefined);
}

async function probeVideoGeometry(path: string): Promise<ImageGeometry> {
  const output = await runProcess("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(output.stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
  };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) {
    throw new Error(`ffprobe found no video dimensions for ${path}.`);
  }
  return {
    width: stream.width,
    height: stream.height,
  };
}

function localArtifactPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  if (path.startsWith("file://")) {
    return path.slice("file://".length);
  }
  if (path.includes("://")) {
    return undefined;
  }
  return path;
}

function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed with code ${code}: ${stderr}`));
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

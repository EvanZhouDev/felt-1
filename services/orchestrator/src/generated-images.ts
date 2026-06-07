import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentOutput, ImagePayload, RenderedStimulus } from "@volta/core";

const DEFAULT_FLUX_URL = "https://images.bryanhu.com";
const DEFAULT_FLUX_MODEL = "klein";
const DEFAULT_FLUX_STEPS = "4";
const DEFAULT_IMAGE_DURATION_SEC = 0.5;
const DEFAULT_IMAGE_FPS = 2;
const DEFAULT_FLUX_TIMEOUT_MS = 180_000;
const FLUX_RETRY_DELAY_MS = 1500;
const FLUX_MAX_ATTEMPTS = 3;

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
  const sourceUri = args.candidate.outputNode.payload.source.uri;
  const fluxMaterialized = await materializeFluxImagePayload({
    payload: args.candidate.outputNode.payload,
    runPath: args.runPath,
    agentId: args.candidate.agentId,
    fluxUrl: args.fluxUrl,
    targetStyle,
  });
  const materialized =
    fluxMaterialized === args.candidate.outputNode.payload
      ? await materializeLocalStyledImagePayload({
          payload: args.candidate.outputNode.payload,
          runPath: args.runPath,
          agentId: args.candidate.agentId,
          targetStyle,
        })
      : fluxMaterialized;
  if (materialized === args.candidate.outputNode.payload) {
    return args.candidate;
  }

  const targetFidelity = targetStyle
    ? targetFidelityMode(targetStyle, requestedTargetFidelity(sourceUri))
    : undefined;
  const materializationKind = materializationKindForUri(sourceUri);
  const generationStyle =
    targetStyle && materializationKind === "flux-image"
      ? fluxGenerationGeometry(targetStyle)
      : undefined;

  return {
    ...args.candidate,
    entropy: [
      args.candidate.entropy,
      `materialized=${materializationKind}`,
      targetStyle
        ? `targetStyle=${targetStyle.width}x${targetStyle.height}`
        : undefined,
      generationStyle
        ? `fluxSize=${generationStyle.width}x${generationStyle.height}`
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

function materializationKindForUri(
  uri: string,
): "flux-image" | "local-image-style" {
  return parseLocalStyleUri(uri) ? "local-image-style" : "flux-image";
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
  const generationStyle =
    request.width && request.height
      ? { width: Number(request.width), height: Number(request.height) }
      : args.targetStyle
        ? fluxGenerationGeometry(args.targetStyle)
        : undefined;
  const key = sha256(
    JSON.stringify({ prompt, model, steps, seed, generationStyle }),
  ).slice(0, 16);
  const rawAssetRoot = join(args.runPath, "generated-assets", "_raw");
  const assetRoot = join(args.runPath, "generated-assets", args.agentId);
  const rawImagePath = join(assetRoot, `${key}.png`);
  const sharedRawImagePath = join(rawAssetRoot, `${key}.png`);
  const styledImagePath = join(assetRoot, `${key}-target-style.png`);
  const targetFidelity = args.targetStyle
    ? targetFidelityMode(args.targetStyle, request.voltaStyle)
    : undefined;
  const fidelityImagePath =
    targetFidelity && targetFidelity !== "style-only"
      ? join(
          assetRoot,
          `${key}-${targetFidelityPathSuffix(targetFidelity)}.png`,
        )
      : undefined;
  const imagePath =
    fidelityImagePath ?? (args.targetStyle ? styledImagePath : rawImagePath);
  const videoPath = join(
    assetRoot,
    `${key}-${imageRenderSuffix({
      hasTargetStyle: Boolean(args.targetStyle),
      targetFidelity,
    })}-0.5s.mp4`,
  );
  await mkdir(rawAssetRoot, { recursive: true });
  await mkdir(assetRoot, { recursive: true });

  if (!existsSync(sharedRawImagePath)) {
    if (existsSync(rawImagePath)) {
      await copyFile(rawImagePath, sharedRawImagePath);
    } else {
      await downloadFluxImage({
        url: args.fluxUrl ?? DEFAULT_FLUX_URL,
        prompt,
        model,
        steps,
        seed,
        geometry: generationStyle,
        outPath: sharedRawImagePath,
      });
    }
  }
  if (!existsSync(rawImagePath)) {
    await copyFile(sharedRawImagePath, rawImagePath);
  }
  if (args.targetStyle && !existsSync(styledImagePath)) {
    await createTargetStyleImage({
      inputPath: rawImagePath,
      outputPath: styledImagePath,
      geometry: args.targetStyle,
    });
  }
  if (targetFidelity && fidelityImagePath && !existsSync(fidelityImagePath)) {
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

async function materializeLocalStyledImagePayload(args: {
  payload: ImagePayload;
  runPath: string;
  agentId: string;
  targetStyle?: ImageGeometry;
}): Promise<ImagePayload> {
  const request = parseLocalStyleUri(args.payload.source.uri);
  if (!request) {
    return args.payload;
  }

  const sourcePath = localImagePath(request.src);
  if (!sourcePath) {
    throw new Error(`Unsupported local style source URI: ${request.src}`);
  }

  const key = sha256(
    JSON.stringify({
      sourcePath,
      style: request.style,
      targetStyle: args.targetStyle,
    }),
  ).slice(0, 16);
  const assetRoot = join(args.runPath, "generated-assets", args.agentId);
  const normalizedImagePath = join(assetRoot, `${key}-target-style.png`);
  const fidelityImagePath = join(
    assetRoot,
    `${key}-${targetFidelityPathSuffix(request.style)}.png`,
  );
  const imagePath =
    request.style === "style-only" ? normalizedImagePath : fidelityImagePath;
  const videoPath = join(
    assetRoot,
    `${key}-${targetFidelityPathSuffix(request.style)}-0.5s.mp4`,
  );
  await mkdir(assetRoot, { recursive: true });

  if (args.targetStyle) {
    if (!existsSync(normalizedImagePath)) {
      await createTargetStyleImage({
        inputPath: sourcePath,
        outputPath: normalizedImagePath,
        geometry: args.targetStyle,
      });
    }
  } else if (!existsSync(normalizedImagePath)) {
    await copyFile(sourcePath, normalizedImagePath);
  }

  if (request.style !== "style-only" && !existsSync(fidelityImagePath)) {
    await createTargetFidelityImage({
      inputPath: normalizedImagePath,
      outputPath: fidelityImagePath,
      mode: request.style,
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

type TargetFidelityMode =
  | "style-only"
  | "soft-muted"
  | "soft-muted-strong"
  | "flat-warm"
  | "flat-cool"
  | "crisp-neutral"
  | "crisp-warm"
  | "darker-crisp"
  | "hard-neutral"
  | "hard-neutral-sharp"
  | "hard-neutral-saturated";

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
  requestedMode?: string,
): TargetFidelityMode | undefined {
  if (isTargetFidelityMode(requestedMode)) {
    return requestedMode;
  }
  const area = geometry.width * geometry.height;
  return area <= 512 * 512 ? "soft-muted" : undefined;
}

function isTargetFidelityMode(
  mode: string | undefined,
): mode is TargetFidelityMode {
  return (
    mode === "style-only" ||
    mode === "soft-muted" ||
    mode === "soft-muted-strong" ||
    mode === "flat-warm" ||
    mode === "flat-cool" ||
    mode === "crisp-neutral" ||
    mode === "crisp-warm" ||
    mode === "darker-crisp" ||
    mode === "hard-neutral" ||
    mode === "hard-neutral-sharp" ||
    mode === "hard-neutral-saturated"
  );
}

function targetFidelityPathSuffix(mode: TargetFidelityMode): string {
  return mode === "soft-muted" ? "target-fidelity" : `target-${mode}`;
}

function imageRenderSuffix(args: {
  hasTargetStyle: boolean;
  targetFidelity?: TargetFidelityMode;
}): string {
  if (args.targetFidelity) {
    return targetFidelityPathSuffix(args.targetFidelity);
  }
  return args.hasTargetStyle ? "target-style" : "raw";
}

function fluxGenerationGeometry(geometry: ImageGeometry): ImageGeometry {
  const maxDimension = 768;
  const scale = Math.min(
    maxDimension / geometry.width,
    maxDimension / geometry.height,
  );
  return {
    width: generationDimension(geometry.width * scale),
    height: generationDimension(geometry.height * scale),
  };
}

function generationDimension(value: number): number {
  const multiple = 8;
  const rounded = Math.round(value / multiple) * multiple;
  return Math.min(1440, Math.max(256, rounded));
}

function parseFluxGenerationUri(uri: string):
  | {
      prompt: string;
      model?: string;
      steps?: string;
      seed?: string;
      width?: string;
      height?: string;
      voltaStyle?: string;
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
    width: parsed.searchParams.get("width") ?? undefined,
    height: parsed.searchParams.get("height") ?? undefined,
    voltaStyle: parsed.searchParams.get("voltaStyle") ?? undefined,
  };
}

function parseLocalStyleUri(
  uri: string,
): { src: string; style: TargetFidelityMode } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "volta-style:" || parsed.hostname !== "image") {
    return undefined;
  }
  const src = parsed.searchParams.get("src");
  const style = parsed.searchParams.get("style") ?? undefined;
  if (!src || !isTargetFidelityMode(style)) {
    return undefined;
  }
  return {
    src,
    style,
  };
}

function requestedTargetFidelity(uri: string): string | undefined {
  return (
    parseFluxGenerationUri(uri)?.voltaStyle ?? parseLocalStyleUri(uri)?.style
  );
}

function localImagePath(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    return uri.slice("file://".length);
  }
  if (uri.startsWith("/")) {
    return uri;
  }
  return undefined;
}

async function downloadFluxImage(args: {
  url: string;
  prompt: string;
  model: string;
  steps: string;
  seed: string;
  geometry?: ImageGeometry;
  outPath: string;
}): Promise<void> {
  const url = new URL("/generate", args.url.replace(/\/+$/, ""));
  url.searchParams.set("prompt", args.prompt);
  url.searchParams.set("model", args.model);
  url.searchParams.set("steps", args.steps);
  url.searchParams.set("seed", args.seed);
  if (args.geometry) {
    url.searchParams.set("width", String(args.geometry.width));
    url.searchParams.set("height", String(args.geometry.height));
  }

  const response = await fetchFluxWithRetries(url);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Flux generation returned non-image response: ${detail}`);
  }

  await writeFile(args.outPath, new Uint8Array(await response.arrayBuffer()));
}

async function fetchFluxWithRetries(url: URL): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FLUX_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, DEFAULT_FLUX_TIMEOUT_MS);
      if (response.ok || !isRetryableFluxStatus(response.status)) {
        return response;
      }
      const detail = await response.text().catch(() => "");
      lastError = new Error(
        `Flux generation failed: ${response.status} ${detail}`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < FLUX_MAX_ATTEMPTS) {
      await delay(FLUX_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function isRetryableFluxStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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
  const filter = targetFidelityFilter(args.mode);
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

function targetFidelityFilter(mode: TargetFidelityMode): string | undefined {
  switch (mode) {
    case "style-only":
      return undefined;
    case "soft-muted":
      return "boxblur=0.8:1,eq=contrast=0.92:saturation=0.88:brightness=-0.02";
    case "soft-muted-strong":
      return "boxblur=1.2:1,eq=contrast=0.86:saturation=0.78:brightness=-0.03";
    case "flat-warm":
      return "boxblur=0.6:1,eq=contrast=0.88:saturation=0.82:brightness=-0.01:gamma_r=1.04:gamma_b=0.96";
    case "flat-cool":
      return "boxblur=0.6:1,eq=contrast=0.9:saturation=0.86:brightness=-0.01:gamma_r=0.96:gamma_b=1.04";
    case "crisp-neutral":
      return "eq=contrast=0.98:saturation=0.95:brightness=-0.01,unsharp=3:3:0.25:3:3:0.0";
    case "crisp-warm":
      return "eq=contrast=0.98:saturation=0.95:brightness=-0.01:gamma_r=1.02:gamma_b=0.98,unsharp=3:3:0.25:3:3:0.0";
    case "darker-crisp":
      return "eq=contrast=1.02:saturation=0.92:brightness=-0.04:gamma_r=1.03:gamma_b=0.95,unsharp=3:3:0.20:3:3:0.0";
    case "hard-neutral":
      return "eq=contrast=1.05:saturation=0.96:brightness=-0.015,unsharp=5:5:0.35:3:3:0.0";
    case "hard-neutral-sharp":
      return "eq=contrast=1.05:saturation=0.96:brightness=-0.015,unsharp=5:5:0.45:3:3:0.0";
    case "hard-neutral-saturated":
      return "eq=contrast=1.05:saturation=1.00:brightness=-0.015,unsharp=5:5:0.35:3:3:0.0";
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableSeed(value: string): string {
  return String(Number.parseInt(sha256(value).slice(0, 8), 16));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

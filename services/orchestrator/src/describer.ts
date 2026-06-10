import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioDescription, AudioNode } from "@volta/core";
import type { OrchestratorConfig } from "./config.ts";

// The audio describer gives candidate agents perceptual context they cannot get
// from the AudioNode (which is just an asset URI) — neural similarity stays the
// scoring signal; this only steers generation. It has two tiers:
//
//   1. Hosted Qwen2.5-Omni (VOLTA_AUDIO_URL, POST /describe) writes a fluent
//      perceptual CAPTION — mood, texture, atmosphere.
//   2. A local DSP pass (audio_features.py: numpy + soundfile, CPU, sub-second)
//      adds the objective MUSICAL structure the caption misses — tempo, energy,
//      brightness, key. In testing Qwen called a clear C-major arpeggio a
//      "computer beep"; the DSP pass labels it "C major, fast, bright."
//
// The two are merged into one AudioDescription. Either tier may be absent: if
// the hosted service is down we still get the local features, and if local DSP
// is unavailable we still get the caption. Only when BOTH fail is the result
// undefined, and the run proceeds on neural similarity alone.

const AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

const FEATURES_SCRIPT = "services/orchestrator/python/audio_features.py";

// Asks the audio model for the perceptual dimensions that steer a vibe-transfer
// candidate. Deliberately NOT for the piece/artist name — we want what it
// SOUNDS like, so the candidate matches the felt vibe, not a title.
const DESCRIBE_PROMPT =
  "Describe what this audio sounds like for someone who cannot hear it: its " +
  "mood and emotional temperature, energy, instruments and texture, and " +
  "overall atmosphere. Be vivid and perceptual. Do NOT name the piece, " +
  "composer, or genre — describe the felt experience of the sound itself.";

export type AudioDescriberOptions = {
  baseUrl: string;
  pythonPath: string;
  repoRoot: string;
  timeoutMs?: number;
};

export function createAudioDescriber(
  config: OrchestratorConfig,
): ((node: AudioNode) => Promise<AudioDescription | undefined>) | undefined {
  if (!config.describeAudio) {
    return undefined;
  }
  const describer = new HostedAudioDescriber({
    baseUrl: config.audioUrl,
    pythonPath: config.pythonPath,
    repoRoot: config.repoRoot,
  });
  return (node) => describer.describe(node);
}

export class HostedAudioDescriber {
  private readonly baseUrl: string;
  private readonly pythonPath: string;
  private readonly repoRoot: string;
  private readonly timeoutMs: number;

  constructor(options: AudioDescriberOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.pythonPath = options.pythonPath;
    this.repoRoot = options.repoRoot;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async describe(node: AudioNode): Promise<AudioDescription | undefined> {
    const uri = node.payload.source.uri;
    const [caption, features] = await Promise.all([
      this.requestCaption(uri),
      this.localFeatures(uri),
    ]);
    if (!caption && !features) {
      return undefined;
    }
    return {
      // A bare features summary stands in when the hosted caption is missing,
      // so agents always get at least the structural description.
      caption: caption ?? summarizeFeatures(features),
      ...features,
    };
  }

  // Hosted Qwen2.5-Omni: multipart POST /describe with the audio FILE (not its
  // name — the model hears the waveform, so no title leaks) and a perceptual
  // prompt. Returns { description, elapsed_seconds }. Fails soft to undefined.
  private async requestCaption(uri: string): Promise<string | undefined> {
    try {
      const file = await readAudio(uri);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const form = new FormData();
        form.append("file", file.blob, file.name);
        form.append("prompt", DESCRIBE_PROMPT);
        const response = await fetch(`${this.baseUrl}/describe`, {
          method: "POST",
          body: form,
          signal: controller.signal,
          headers: { "user-agent": "volta-describer" },
        });
        if (!response.ok) {
          throw new Error(`describe failed: ${response.status}`);
        }
        const body = (await response.json()) as { description?: unknown };
        return typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      console.warn(
        `Audio caption skipped (${this.baseUrl}): ${message(error)}`,
      );
      return undefined;
    }
  }

  // Local DSP: run audio_features.py through the configured Python interpreter
  // (the TRIBE venv, which has numpy + soundfile). Local files only — remote
  // URLs are left to the hosted caption. Fails soft to undefined.
  private async localFeatures(uri: string): Promise<AudioFeatures | undefined> {
    const path = localPath(uri);
    if (!path) {
      return undefined;
    }
    try {
      const raw = await this.runFeatureScript(path);
      const parsed = JSON.parse(raw) as AudioFeatures & { error?: string };
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed;
    } catch (error) {
      console.warn(`Audio features skipped: ${message(error)}`);
      return undefined;
    }
  }

  private runFeatureScript(audioPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.pythonPath,
        [join(this.repoRoot, FEATURES_SCRIPT), audioPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("audio_features.py timed out"));
      }, 30_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(`audio_features.py exited ${code}: ${stderr.trim()}`),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}

// The structural fields audio_features.py contributes (a subset of
// AudioDescription, all optional).
type AudioFeatures = Pick<
  AudioDescription,
  "tempo" | "energy" | "tempoBpm" | "brightness" | "key" | "durationSec"
>;

// One-line caption built from the DSP features alone, used when the hosted
// service is unavailable so agents still get a perceptual handle on the audio.
function summarizeFeatures(features: AudioFeatures | undefined): string {
  if (!features) {
    return "An audio clip (no perceptual description available).";
  }
  const parts = [
    features.key,
    features.tempo && `${features.tempo} tempo`,
    features.tempoBpm && `~${Math.round(features.tempoBpm)} BPM`,
    features.energy && `${features.energy} energy`,
    features.brightness && `${features.brightness} timbre`,
  ].filter(Boolean);
  return parts.length
    ? `An audio clip: ${parts.join(", ")}.`
    : "An audio clip (no perceptual description available).";
}

async function readAudio(uri: string): Promise<{ blob: Blob; name: string }> {
  const local = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  if (local.startsWith("http://") || local.startsWith("https://")) {
    const response = await fetch(local);
    if (!response.ok) {
      throw new Error(`fetch ${local} failed: ${response.status}`);
    }
    return {
      blob: await response.blob(),
      name: basename(new URL(local).pathname),
    };
  }
  if (local.includes("://")) {
    throw new Error(`unsupported audio URI scheme: ${uri}`);
  }
  const bytes = await readFile(local);
  const name = basename(local);
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return {
    blob: new Blob([bytes], {
      type: AUDIO_MIME[ext] ?? "application/octet-stream",
    }),
    name,
  };
}

function localPath(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  if (uri.includes("://")) {
    return undefined;
  }
  return uri;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

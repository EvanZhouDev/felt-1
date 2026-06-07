import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AudioDescription, AudioNode } from "@volta/core";
import type { OrchestratorConfig } from "./config.ts";

// Audio describer backed by the hosted audio-understanding service
// (https://audio.ai.bryanhu.com). The service actually ingests the waveform, so
// it reports what the audio *sounds like* — caption, mood, tempo, instruments —
// which the candidate agents cannot hear from the AudioNode themselves. The
// description is injected into their prompt as steering context; neural
// similarity remains the scoring signal.
//
// The describer fails soft: if the service is unreachable or returns garbage, it
// returns undefined and the run proceeds on neural similarity alone.
//
// NOTE: the service was offline while this was written, so the request/response
// mapping lives entirely in `requestDescription` / `parseDescription` — adjust
// those two if the live API differs. Everything else is service-agnostic.

const AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export type AudioDescriberOptions = {
  baseUrl: string;
  timeoutMs?: number;
};

export function createAudioDescriber(
  config: OrchestratorConfig,
): ((node: AudioNode) => Promise<AudioDescription | undefined>) | undefined {
  if (!config.describeAudio) {
    return undefined;
  }
  const describer = new HostedAudioDescriber({ baseUrl: config.audioUrl });
  return (node) => describer.describe(node);
}

export class HostedAudioDescriber {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AudioDescriberOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async describe(node: AudioNode): Promise<AudioDescription | undefined> {
    try {
      const file = await this.readAudio(node.payload.source.uri);
      const raw = await this.requestDescription(file);
      return parseDescription(raw);
    } catch (error) {
      console.warn(
        `Audio describer skipped (${this.baseUrl}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  private async readAudio(uri: string): Promise<{ blob: Blob; name: string }> {
    const local = uri.startsWith("file://") ? new URL(uri).pathname : uri;
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

  // Multipart upload to the hosted Qwen2.5-Omni audio model (Ollama-style API at
  // audio.bryanhu.com): POST /api/generate with the audio FILE (not its name —
  // the model hears the waveform, so no title leaks), a describe prompt, and the
  // model id. Returns the raw JSON ({ response: "<caption>" }); the shape mapping
  // happens in parseDescription so the two ends stay decoupled.
  private async requestDescription(file: {
    blob: Blob;
    name: string;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.append("audio", file.blob, file.name);
      form.append("model", DESCRIBE_MODEL);
      form.append("prompt", DESCRIBE_PROMPT);
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        body: form,
        signal: controller.signal,
        headers: { "user-agent": "volta-describer" },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`describe failed: ${response.status} ${detail}`.trim());
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

const DESCRIBE_MODEL = "qwen2.5-omni";
// Ask for the perceptual dimensions that steer a vibe-transfer candidate.
// Deliberately NOT asking it to name the piece/artist — we want what it SOUNDS
// like, not what it IS, so the candidate matches the felt vibe, not a title.
const DESCRIBE_PROMPT =
  "Describe what this audio sounds like for someone who cannot hear it: its " +
  "mood and emotional temperature, tempo and energy, instruments and texture, " +
  "and overall atmosphere. Be vivid and perceptual. Do NOT name the piece, " +
  "composer, or genre — describe the felt experience of the sound itself.";

// Accept either a flat description object or a wrapper like { description: {...} }
// / { caption: "..." }, and tolerate the caption arriving as plain text.
function parseDescription(raw: unknown): AudioDescription | undefined {
  const obj = unwrap(raw);
  if (!obj) {
    return undefined;
  }

  const caption =
    asString(obj.caption) ??
    asString(obj.response) ??
    asString(obj.text) ??
    asString(obj.summary);
  if (!caption) {
    return undefined;
  }
  return {
    caption,
    tags: asStringArray(obj.tags),
    mood: asStringArray(obj.mood) ?? asStringArray(obj.moods),
    tempo: asEnum(obj.tempo, ["slow", "medium", "fast"] as const),
    energy: asEnum(obj.energy, ["low", "medium", "high"] as const),
    instruments: asStringArray(obj.instruments),
    structure: asString(obj.structure),
  };
}

function unwrap(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    return { caption: raw };
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const inner = obj.description ?? obj.result ?? obj.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return obj;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .map((item) => item.trim());
  return items.length ? items : undefined;
}

function asEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

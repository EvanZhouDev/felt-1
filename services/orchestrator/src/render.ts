import { createHash } from "node:crypto";
import type {
  AssetRef,
  EncoderStimulusKind,
  Node,
  Payload,
  RenderedStimulus,
  RenderTiming,
  StimulusEvent,
  TribeArtifact,
} from "@volta/core";

const TEXT_SECONDS_PER_WORD = 0.35;

export async function renderNode(node: Node): Promise<RenderedStimulus> {
  return renderPayload(node.payload);
}

export async function renderPayload(
  payload: Payload,
): Promise<RenderedStimulus> {
  if (payload.type === "text") {
    const duration = textDuration(payload.text);
    return buildRenderedStimulus({
      payload,
      kind: "text",
      artifact: {
        kind: "text",
        text: payload.text,
      },
      preview: payload.text,
      events: textEvents(payload.text, duration),
      text: payload.text,
      digestSalt: `text-seconds-per-word:${TEXT_SECONDS_PER_WORD}`,
    });
  }

  if (payload.type === "audio") {
    const duration = payload.timing?.durationSec ?? 0.5;
    return buildRenderedStimulus({
      payload,
      kind: "audio",
      artifact: {
        kind: "audio",
        source: payload.source,
        timing: payload.timing,
      },
      preview: payload.source.uri,
      events: [assetEvent("Audio", payload.source, duration)],
      artifactPath: payload.source.uri,
    });
  }

  if (payload.type === "image") {
    const source = payload.cachedVideo ?? payload.source;
    const eventType = payload.cachedVideo ? "Video" : "Image";
    return buildRenderedStimulus({
      payload,
      kind: "video",
      artifact: videoArtifact(source, payload.timing),
      preview: payload.source.uri,
      events: [assetEvent(eventType, source, payload.timing?.durationSec)],
      artifactPath: source.uri,
    });
  }

  const fallbackScreenshot =
    payload.stitchedScreenshot ??
    payload.screenshots?.[0] ??
    ({
      uri: `asset://code/${sha256(JSON.stringify(payload.files))}.png`,
      mime: "image/png",
    } satisfies AssetRef);
  const source = payload.cachedVideo ?? fallbackScreenshot;
  const eventType = payload.cachedVideo ? "Video" : "Image";

  return buildRenderedStimulus({
    payload,
    kind: "video",
    artifact: videoArtifact(source, payload.timing),
    preview: `${payload.framework}:${payload.entrypoint}`,
    events: [assetEvent(eventType, source, payload.timing?.durationSec)],
    artifactPath: source.uri,
    metadata: {
      entrypoint: payload.entrypoint,
      framework: payload.framework,
      viewport: payload.viewport,
    },
  });
}

function buildRenderedStimulus(args: {
  payload: Payload;
  kind: EncoderStimulusKind;
  artifact: TribeArtifact;
  preview: string;
  events: StimulusEvent[];
  text?: string;
  artifactPath?: string;
  metadata?: Record<string, unknown>;
  digestSalt?: string;
}): RenderedStimulus {
  const digest = sha256(
    args.digestSalt
      ? JSON.stringify({ payload: args.payload, salt: args.digestSalt })
      : JSON.stringify(args.payload),
  );

  return {
    id: `${args.payload.type}-${digest.slice(0, 12)}`,
    kind: args.kind,
    artifact: args.artifact,
    preview: args.preview,
    encoderInput: {
      kind: args.kind,
      events: args.events,
      text: args.text,
      artifactPath: args.artifactPath,
    },
    sha256: digest,
    metadata: args.metadata ?? {},
  };
}

function videoArtifact(source: AssetRef, timing?: RenderTiming): TribeArtifact {
  return {
    kind: "video",
    source,
    timing,
  };
}

function assetEvent(
  type: "Audio" | "Image" | "Video",
  source: AssetRef,
  duration = 0.5,
): StimulusEvent {
  return {
    type,
    start: 0,
    duration,
    timeline: "main",
    subject: "stimulus",
    filepath: source.uri,
  };
}

function textEvents(text: string, duration: number): StimulusEvent[] {
  const words = textWords(text);
  const wordDuration = duration / Math.max(words.length, 1);
  const events: StimulusEvent[] = [
    {
      type: "Text",
      start: 0,
      duration,
      timeline: "main",
      subject: "stimulus",
      text,
      language: "english",
      modality: "heard",
    },
  ];

  words.forEach((word, index) => {
    events.push({
      type: "Word",
      start: index * wordDuration,
      duration: wordDuration,
      timeline: "main",
      subject: "stimulus",
      text: word,
      language: "english",
      modality: "heard",
    });
  });

  return events;
}

function textDuration(text: string): number {
  return Math.max(textWords(text).length, 1) * TEXT_SECONDS_PER_WORD;
}

function textWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

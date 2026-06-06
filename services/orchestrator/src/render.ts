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

export async function renderNode(node: Node): Promise<RenderedStimulus> {
  return renderPayload(node.payload);
}

export async function renderPayload(
  payload: Payload,
): Promise<RenderedStimulus> {
  if (payload.type === "text") {
    return buildRenderedStimulus({
      payload,
      kind: "text",
      artifact: {
        kind: "text",
        text: payload.text,
      },
      preview: payload.text,
      events: [
        {
          type: "Text",
          start: 0,
          duration: 0.5,
          timeline: "main",
          subject: "stimulus",
          text: payload.text,
        },
      ],
      text: payload.text,
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
    return buildRenderedStimulus({
      payload,
      kind: "video",
      artifact: videoArtifact(source, payload.timing),
      preview: payload.source.uri,
      events: [
        assetEvent("Image", payload.source, payload.timing?.durationSec),
      ],
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

  return buildRenderedStimulus({
    payload,
    kind: "video",
    artifact: videoArtifact(source, payload.timing),
    preview: `${payload.framework}:${payload.entrypoint}`,
    events: [
      assetEvent("Image", fallbackScreenshot, payload.timing?.durationSec),
    ],
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
}): RenderedStimulus {
  const digest = sha256(JSON.stringify(args.payload));

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
  type: "Audio" | "Image",
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

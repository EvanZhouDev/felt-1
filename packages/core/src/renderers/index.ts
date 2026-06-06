import type { NodeType, Payload, RenderedStimulus } from "../types.ts";
import type { AudioRenderer } from "./audio.ts";
import type { CodeRenderer } from "./code.ts";
import type { ImageRenderer } from "./image.ts";
import type { TextRenderer } from "./text.ts";

export type RendererRegistry = {
  text?: TextRenderer;
  audio?: AudioRenderer;
  image?: ImageRenderer;
  code?: CodeRenderer;
};

export type RenderPayload = (
  payload: Payload,
  registry: RendererRegistry,
) => Promise<RenderedStimulus>;

export type RendererKey = NodeType;

export type { AudioRenderer, CodeRenderer, ImageRenderer, TextRenderer };

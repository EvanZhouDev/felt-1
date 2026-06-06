import type { ImagePayload, RenderedStimulus } from "../types.ts";

export type ImageRenderer = (
  payload: ImagePayload,
) => Promise<RenderedStimulus>;

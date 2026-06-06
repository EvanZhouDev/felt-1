import type { AudioPayload, RenderedStimulus } from "../types.ts";

export type AudioRenderer = (
  payload: AudioPayload,
) => Promise<RenderedStimulus>;

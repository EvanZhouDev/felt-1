import type { RenderedStimulus, TextPayload } from "../types.ts";

export type TextRenderer = (payload: TextPayload) => Promise<RenderedStimulus>;

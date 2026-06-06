import type { CodePayload, RenderedStimulus } from "../types.ts";

export type CodeRenderer = (payload: CodePayload) => Promise<RenderedStimulus>;

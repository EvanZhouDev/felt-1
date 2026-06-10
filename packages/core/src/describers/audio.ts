import type { AudioNode } from "../types.ts";

// Perceptual description of an audio target. `caption` is the fluent prose from
// the hosted audio-LLM; the remaining fields are objective structure from a
// local DSP pass (see services/orchestrator/python/audio_features.py). Any
// field may be absent depending on which tier produced the description.
export type AudioDescription = {
  caption: string;
  tags?: string[];
  mood?: string[];
  tempo?: "slow" | "medium" | "fast";
  tempoBpm?: number;
  energy?: "low" | "medium" | "high";
  brightness?: "dark" | "warm" | "bright";
  key?: string;
  instruments?: string[];
  structure?: string;
  durationSec?: number;
};

export type AudioDescriber = (node: AudioNode) => Promise<AudioDescription>;

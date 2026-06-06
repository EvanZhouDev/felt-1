import type { AudioNode } from "../types.ts";

export type AudioDescription = {
  caption: string;
  tags?: string[];
  mood?: string[];
  tempo?: "slow" | "medium" | "fast";
  energy?: "low" | "medium" | "high";
  instruments?: string[];
  structure?: string;
};

export type AudioDescriber = (node: AudioNode) => Promise<AudioDescription>;

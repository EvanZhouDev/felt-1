import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EncoderStimulusKind } from "@volta/core";

// Modality anchors: the pooled mean TRIBE activation of a diverse corpus per
// encoder modality. Subtracting the matching anchor from a trace removes the
// modality common mode ("hearing music" / "reading English" / "watching a
// still") that dominates raw similarity — measured at 0.88–0.96 between
// emotionally OPPOSITE inputs — and leaves the input-specific signal the
// search is supposed to optimize. Built once by build-anchors.ts against the
// real oracle; absent file = anchoring disabled (legacy behavior).

export type AnchorSet = Partial<Record<EncoderStimulusKind, number[]>>;

export function loadAnchors(repoRoot: string): AnchorSet {
  const path =
    process.env.VOLTA_ANCHORS_PATH ??
    join(repoRoot, "services/orchestrator/anchors/anchors.json");
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8")) as AnchorSet;
}

export function anchorFor(
  anchors: AnchorSet,
  kind: EncoderStimulusKind,
): number[] | undefined {
  return anchors[kind];
}

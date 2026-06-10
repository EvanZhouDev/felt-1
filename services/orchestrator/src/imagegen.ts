import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssetRef } from "@volta/core";
import type { OrchestratorConfig } from "./config.ts";

// Image-output candidates can't paint: the agent returns `flux:<prompt>` as the
// image source and the orchestrator materializes it here through the hosted
// Flux API before rendering/scoring. The seed derives from the prompt, so the
// same prompt yields the same image (and the same TRIBE score) across rounds.

const FLUX_MODEL = "klein";
const FLUX_STEPS = 4;
const FLUX_TIMEOUT_MS = 180_000;
const FLUX_ATTEMPTS = 3;

export const FLUX_URI_PREFIX = "flux:";

export type ImageGenerator = (args: {
  prompt: string;
  outPath: string;
}) => Promise<AssetRef>;

export function createImageGenerator(
  config: Pick<OrchestratorConfig, "fluxUrl">,
): ImageGenerator {
  return async ({ prompt, outPath }) => {
    const seed = seedFromPrompt(prompt);
    const url = `${config.fluxUrl}/generate?prompt=${encodeURIComponent(
      prompt,
    )}&model=${FLUX_MODEL}&steps=${FLUX_STEPS}&seed=${seed}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= FLUX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(FLUX_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`Flux generate failed: ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0) {
          throw new Error("Flux generate returned an empty body.");
        }
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, bytes);
        return {
          uri: pathToFileURL(outPath).href,
          mime: response.headers.get("content-type") ?? "image/png",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Image generation failed after ${FLUX_ATTEMPTS} attempts for prompt "${prompt.slice(0, 120)}": ${lastError}`,
    );
  };
}

function seedFromPrompt(prompt: string): number {
  const digest = createHash("sha256").update(prompt).digest();
  return digest.readUInt32BE(0) % 2_147_483_647;
}

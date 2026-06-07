import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssetRef, AudioNode, RenderTiming } from "@volta/core";

// Default still-frame timing shared with the renderers (IO_MODULES Hackathon
// Defaults). Audio is uploaded as-is; timing only annotates the stimulus event.
const DEFAULT_AUDIO_TIMING: RenderTiming = {
  durationSec: 0.5,
  fps: 10,
};

const AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export type LoadAudioOptions = {
  timing?: RenderTiming;
};

// Resolve a local path or http(s) URL into an AudioNode. Local files are hashed
// (sha256) so identical inputs share a stable AssetRef; remote URLs are passed
// through untouched (the http oracle fetches them at encode time).
export async function loadAudioNode(
  source: string,
  options: LoadAudioOptions = {},
): Promise<AudioNode> {
  const timing = options.timing ?? DEFAULT_AUDIO_TIMING;
  const ref = await resolveAudioAsset(source);
  return {
    type: "audio",
    payload: {
      type: "audio",
      source: ref,
      timing,
    },
  };
}

async function resolveAudioAsset(source: string): Promise<AssetRef> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return {
      uri: source,
      mime: mimeForExtension(extname(new URL(source).pathname)),
    };
  }

  const localPath = source.startsWith("file://")
    ? new URL(source).pathname
    : isAbsolute(source)
      ? source
      : resolve(process.cwd(), source);

  const suffix = extname(localPath).toLowerCase();
  if (!(suffix in AUDIO_MIME)) {
    throw new Error(
      `Unsupported audio extension '${suffix}'. Expected one of ${Object.keys(
        AUDIO_MIME,
      ).join(", ")}.`,
    );
  }

  const bytes = await readFile(localPath);
  return {
    uri: pathToFileURL(localPath).href,
    mime: AUDIO_MIME[suffix],
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function mimeForExtension(ext: string): string | undefined {
  return AUDIO_MIME[ext.toLowerCase()];
}

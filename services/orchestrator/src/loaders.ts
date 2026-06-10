import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssetRef, AudioNode, ImageNode, RenderTiming } from "@volta/core";

// Default still-frame timing shared with the renderers (IO_MODULES Hackathon
// Defaults). Audio is uploaded as-is; timing only annotates the stimulus event.
const DEFAULT_AUDIO_TIMING: RenderTiming = {
  durationSec: 0.5,
  fps: 10,
};

const DEFAULT_IMAGE_TIMING: RenderTiming = {
  durationSec: 0.5,
  fps: 10,
};

const AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type LoadAssetOptions = {
  timing?: RenderTiming;
};

// Resolve a local path or http(s) URL into an AudioNode. Local files are hashed
// (sha256) so identical inputs share a stable AssetRef; remote URLs are passed
// through untouched (the http oracle fetches them at encode time).
export async function loadAudioNode(
  source: string,
  options: LoadAssetOptions = {},
): Promise<AudioNode> {
  const ref = await resolveAsset(source, AUDIO_MIME, "audio");
  return {
    type: "audio",
    payload: {
      type: "audio",
      source: ref,
      timing: options.timing ?? DEFAULT_AUDIO_TIMING,
    },
  };
}

// Resolve a local path or http(s) URL into an ImageNode. Same node the loop
// uses for any image target — it renders to a still video for TRIBE.
export async function loadImageNode(
  source: string,
  options: LoadAssetOptions = {},
): Promise<ImageNode> {
  const ref = await resolveAsset(source, IMAGE_MIME, "image");
  return {
    type: "image",
    payload: {
      type: "image",
      source: ref,
      timing: options.timing ?? DEFAULT_IMAGE_TIMING,
    },
  };
}

async function resolveAsset(
  source: string,
  mimeByExt: Record<string, string>,
  label: string,
): Promise<AssetRef> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return {
      uri: source,
      mime: mimeByExt[extname(new URL(source).pathname).toLowerCase()],
    };
  }

  const localPath = source.startsWith("file://")
    ? fileURLToPath(source)
    : isAbsolute(source)
      ? source
      : resolve(process.cwd(), source);

  const suffix = extname(localPath).toLowerCase();
  if (!(suffix in mimeByExt)) {
    throw new Error(
      `Unsupported ${label} extension '${suffix}'. Expected one of ${Object.keys(
        mimeByExt,
      ).join(", ")}.`,
    );
  }

  const bytes = await readFile(localPath);
  return {
    uri: pathToFileURL(localPath).href,
    mime: mimeByExt[suffix],
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActivationTrace, EncoderStimulusKind } from "@volta/core";
import { loadConfig } from "./config.ts";
import { loadAudioNode, loadImageNode } from "./loaders.ts";
import { createOracle } from "./oracle.ts";
import { renderNode, renderPayload } from "./render.ts";

// Build the modality anchor file: encode a small DIVERSE corpus per encoder
// modality through the real oracle, pool each activation over time, and store
// the per-modality mean. scoreActivations subtracts these to remove the
// modality common mode. Per-stimulus encodes cache under .agent so reruns and
// corpus tweaks only pay for what's new.
//
// Usage: VOLTA_ORACLE=http bun services/orchestrator/src/build-anchors.ts

const repoRoot = resolve(import.meta.dir, "../../..");
const assets = join(repoRoot, ".agent/experiments/matrix/assets");
const cacheDir = join(repoRoot, ".agent/experiments/anchors-cache");
const outPath = join(repoRoot, "services/orchestrator/anchors/anchors.json");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(join(repoRoot, "services/orchestrator/anchors"), {
  recursive: true,
});

// Registers chosen to span content/affect so the mean is "reading English,"
// not any particular vibe.
const anchorTexts: Record<string, string> = {
  news: "The city council approved the transit budget on Tuesday after a two-hour session, allocating funds for new bus routes and station repairs scheduled to begin next spring.",
  recipe:
    "Dice the onion finely and sweat it in butter over low heat until translucent. Add the rice, stir to coat, then ladle in warm stock one cup at a time, stirring until absorbed.",
  manual:
    "To reset the device, hold the power button for ten seconds until the indicator blinks twice. Release, wait for the chime, then re-enter your network credentials in the settings panel.",
  chat: "haha yeah honestly the meeting could've been an email. anyway are we still on for thursday? i can grab the tickets tonight if you're in, just let me know by nine.",
  sports:
    "Down two runs in the ninth, the visitors loaded the bases on consecutive walks. A sharp single up the middle tied it, and a sacrifice fly won it moments later.",
  legal:
    "The parties agree that any dispute arising under this agreement shall be resolved through binding arbitration, with each party bearing its own costs except as otherwise provided herein.",
  poem: "Cold orchard, late light. The ladder leans where we left it, rungs wet, the last apples freckled and heavy, holding their sweetness against the first hard frost.",
  dread:
    "The hallway was longer than the house allowed. Each door she passed clicked softly shut behind her, and the wallpaper's pattern, when she finally looked, was made of small turned faces.",
};

const anchorAudio = [
  join(repoRoot, "services/orchestrator/fixtures/tone.wav"),
  join(assets, "clair-75s.mp3"),
  join(assets, "moonlight-75s.mp3"),
  join(assets, "dvorak-75s.mp3"),
  join(assets, "anchor-clair-mid.mp3"),
  join(assets, "anchor-moon-mid.mp3"),
  join(assets, "anchor-dvorak-mid.mp3"),
  join(assets, "anchor-pinknoise.wav"),
  join(assets, "anchor-pulse.wav"),
];

const anchorImages = [
  join(repoRoot, "services/orchestrator/fixtures/swatch.png"),
  join(assets, "starry-night.jpg"),
  join(assets, "pearl-earring.jpg"),
  join(assets, "mondrian.jpg"),
  join(repoRoot, "katherine-johnson.jpg"),
  join(repoRoot, "doublebass.jpg"),
  join(repoRoot, "album.jpeg"),
];

const config = { ...loadConfig(), oracleMode: "http" as const };
const oracle = createOracle(config);

const pooledByKind: Record<EncoderStimulusKind, number[][]> = {
  text: [],
  audio: [],
  video: [],
};

async function encodeCached(
  key: string,
  encode: () => Promise<ActivationTrace>,
): Promise<ActivationTrace | undefined> {
  const cachePath = join(cacheDir, `${key}.json`);
  if (existsSync(cachePath)) {
    console.error(`[anchors] ${key}: cached`);
    return JSON.parse(readFileSync(cachePath, "utf8")) as ActivationTrace;
  }
  try {
    const trace = await encode();
    writeFileSync(cachePath, JSON.stringify(trace));
    console.error(`[anchors] ${key}: encoded (${trace.shape.join("x")})`);
    return trace;
  } catch (error) {
    console.error(`[anchors] ${key}: FAILED ${error}`);
    return undefined;
  }
}

for (const [name, text] of Object.entries(anchorTexts)) {
  const trace = await encodeCached(`text-${name}`, async () => {
    const rendered = await renderPayload({ type: "text", text });
    return oracle.encode(rendered.encoderInput);
  });
  if (trace?.values) {
    pooledByKind.text.push(pool(trace));
  }
}

for (const path of anchorAudio) {
  const key = `audio-${path.split("/").at(-1)}`;
  const trace = await encodeCached(key, async () => {
    const node = await loadAudioNode(path);
    const rendered = await renderNode(node);
    return oracle.encode(rendered.encoderInput);
  });
  if (trace?.values) {
    pooledByKind.audio.push(pool(trace));
  }
}

for (const path of anchorImages) {
  const key = `video-${path.split("/").at(-1)}`;
  const trace = await encodeCached(key, async () => {
    const node = await loadImageNode(path);
    const rendered = await renderNode(node);
    return oracle.encode(rendered.encoderInput);
  });
  if (trace?.values) {
    pooledByKind.video.push(pool(trace));
  }
}

const anchors: Partial<Record<EncoderStimulusKind, number[]>> = {};
for (const kind of ["text", "audio", "video"] as const) {
  const pools = pooledByKind[kind];
  if (pools.length < 3) {
    console.error(
      `[anchors] ${kind}: only ${pools.length} usable encodes — skipping (need >= 3 for a usable mean)`,
    );
    continue;
  }
  anchors[kind] = meanVectors(pools);
  console.error(`[anchors] ${kind}: mean over ${pools.length} stimuli`);
}

writeFileSync(outPath, JSON.stringify(anchors));
console.log(
  JSON.stringify({
    ok: true,
    outPath,
    counts: Object.fromEntries(
      Object.entries(pooledByKind).map(([k, v]) => [k, v.length]),
    ),
  }),
);
if (typeof oracle.shutdown === "function") {
  await oracle.shutdown();
}
process.exit(0);

function pool(trace: ActivationTrace): number[] {
  const frames = trace.values ?? [];
  const width = frames[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < width; i += 1) {
      out[i] += frame[i] ?? 0;
    }
  }
  if (frames.length) {
    for (let i = 0; i < width; i += 1) {
      out[i] /= frames.length;
    }
  }
  return out;
}

function meanVectors(vectors: number[][]): number[] {
  const width = vectors[0]?.length ?? 0;
  const out = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) {
      out[i] += vector[i] ?? 0;
    }
  }
  for (let i = 0; i < width; i += 1) {
    out[i] /= vectors.length;
  }
  return out;
}

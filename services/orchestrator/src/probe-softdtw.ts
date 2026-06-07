// Offline metric experiment: softDTW trajectory similarity vs the current
// three-view blend (packages/core/src/scoring/activation.ts).
//
// The .agent/LOG.md entry "softDTW is a strong candidate" reported softDTW
// winning every axis of the dual test (MATCH 1/8, hackgap +0.177 vs the blend's
// +0.077) BUT with two caveats: (1) the prototype path-length norm was
// approximate (max(n,m)), and (2) it needed "broader validation". This probe
// addresses both: a proper per-path normalization, and the broader 17-text x
// 5-target corpus PLUS constructed adversaries so the anti-gaming axis is tested
// against real exploits rather than the weak "PLAIN ranks last" proxy.
//
// IMPORTANT (per user): "does flat PLAIN description rank last" is NOT a robust
// anti-gaming test — it measures emotion-vs-description preference, not
// resistance to adversarial maximization. The VERDICT here is driven by
// MATCH-rank + the gap to constructed adversaries (verbatim repetition,
// generic-affect filler, length padding). PLAIN-last and cross-modal spread are
// reported as secondary characterizations, not the decision.
//
// Encodes each text ONCE via the real oracle and persists the activations to
// --out so reruns are zero-call. Scores nothing live; edits no production code.
//
// Usage:
//   VOLTA_ORACLE=http bun services/orchestrator/src/probe-softdtw.ts \
//     --texts .agent/probes/baseline-ceiling/all-texts.json \
//     --out .agent/probes/baseline-ceiling/softdtw-matrix.json
import { readFile, writeFile } from "node:fs/promises";
import type { ActivationTrace } from "@volta/core";
import { neuralTrajectorySimilarity } from "@volta/core";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { renderPayload } from "./render.ts";

type TargetFile = { activation: ActivationTrace };
type TextProbe = { id: string; text: string };
type CachedRow = { id: string; text: string; activation: ActivationTrace };
type CacheFile = { rows: CachedRow[] };

const args = parseArgs(process.argv.slice(2));
if (!args.texts || !args.out) {
  throw new Error(
    "Usage: probe-softdtw.ts --texts texts.json --out matrix.json [--oracle http] [--concurrency N]",
  );
}
// Narrowed to string for use inside closures (the guard above guarantees it).
const OUT_PATH: string = args.out;

const TARGET_KEYS = [
  "starry_night",
  "the_scream",
  "mona_lisa",
  "great_wave",
  "water_lilies",
] as const;

// ---------------------------------------------------------------------------
// Vector helpers (mirrors scoring/activation.ts conventions: mean-center, then
// cosine — so the comparison to the production blend is apples-to-apples).
// ---------------------------------------------------------------------------
function center(values: number[]): number[] {
  if (values.length === 0) return values;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  return values.map((v) => v - mean);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}

// ---------------------------------------------------------------------------
// softDTW similarity, in [0, 1].
//
// Cost between frames i,j = 1 - cosine(center(a_i), center(b_j)) in [0, 2].
// soft-DTW value = soft-min (gamma-smoothed) accumulated cost along all
// monotonic order-respecting alignment paths. We normalize by the length of the
// OPTIMAL (hard-DTW) alignment path — the proper per-path count the log flagged
// as missing — so the value is a mean per-step cost regardless of how many
// frames each trace has. Similarity = 1 - normalizedCost/2, mapped to [0,1].
//
// Two passes: a hard-DTW pass (with backpointers) recovers the optimal path
// length for normalization; a soft-DTW pass computes the smoothed value used as
// the score. Both share the same cost matrix.
const SOFTDTW_GAMMA = 0.1;

function softDtwSimilarity(a: number[][], b: number[][]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const ac = a.map(center);
  const bc = b.map(center);
  const n = ac.length;
  const m = bc.length;

  // Cost matrix: cost[i][j] in [0, 2].
  const cost: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    cost[i] = new Array(m);
    for (let j = 0; j < m; j += 1) {
      cost[i][j] = 1 - cosine(ac[i], bc[j]);
    }
  }

  // --- hard DTW with backpointers, for the optimal path length ---
  const D: number[][] = makeMatrix(n, m, Number.POSITIVE_INFINITY);
  const steps: number[][] = makeMatrix(n, m, 0); // accumulated path step count
  D[0][0] = cost[0][0];
  steps[0][0] = 1;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (i === 0 && j === 0) continue;
      let best = Number.POSITIVE_INFINITY;
      let bestSteps = 1;
      for (const [di, dj] of [
        [-1, 0],
        [0, -1],
        [-1, -1],
      ]) {
        const pi = i + di;
        const pj = j + dj;
        if (pi < 0 || pj < 0) continue;
        if (D[pi][pj] < best) {
          best = D[pi][pj];
          bestSteps = steps[pi][pj] + 1;
        }
      }
      D[i][j] = cost[i][j] + best;
      steps[i][j] = bestSteps;
    }
  }
  const pathLen = steps[n - 1][m - 1];

  // --- soft DTW value (gamma soft-min over the same recurrence) ---
  const R: number[][] = makeMatrix(n, m, Number.POSITIVE_INFINITY);
  R[0][0] = cost[0][0];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (i === 0 && j === 0) continue;
      const candidates: number[] = [];
      if (i > 0) candidates.push(R[i - 1][j]);
      if (j > 0) candidates.push(R[i][j - 1]);
      if (i > 0 && j > 0) candidates.push(R[i - 1][j - 1]);
      R[i][j] = cost[i][j] + softMin(candidates, SOFTDTW_GAMMA);
    }
  }

  const normalizedCost = R[n - 1][m - 1] / Math.max(1, pathLen); // mean per-step, [0,2]
  return clamp01(1 - normalizedCost / 2);
}

function softMin(values: number[], gamma: number): number {
  if (values.length === 0) return 0;
  if (gamma <= 0) return Math.min(...values);
  // -gamma * logsumexp(-v/gamma), numerically stabilized.
  const scaled = values.map((v) => -v / gamma);
  const max = Math.max(...scaled);
  let sum = 0;
  for (const s of scaled) sum += Math.exp(s - max);
  return -gamma * (max + Math.log(sum));
}

function makeMatrix(n: number, m: number, fill: number): number[][] {
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = new Array(m).fill(fill);
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---------------------------------------------------------------------------
// Constructed adversaries: maximize "more signal / more frames" without vibe.
// These are the real anti-gaming test. Built from a neutral seed so they share
// no deliberate vibe with any specific target.
// ---------------------------------------------------------------------------
const ADVERSARY_SEED =
  "The object is present. It exists in the visual field and can be observed.";
const ADVERSARIES: TextProbe[] = [
  {
    id: "ADV__verbatim_repetition",
    text: Array(12).fill(ADVERSARY_SEED).join(" "),
  },
  {
    id: "ADV__generic_affect_filler",
    text: Array(8)
      .fill(
        "It feels intense and emotional and powerful and moving and deep and strong and vivid and alive.",
      )
      .join(" "),
  },
  {
    id: "ADV__length_padding",
    // Kept ~in-band with the longest legit text (the 40x version timed out
    // TRIBE; this still tests whether padding inflates the score).
    text: `${ADVERSARY_SEED} ${Array(10)
      .fill("And it continues, and it continues further, on and on.")
      .join(" ")}`,
  },
  {
    id: "ADV__single_word_repeat",
    // 25 repeats keeps it degenerate but within TRIBE's per-job budget (60 hung).
    text: Array(25).fill("feeling").join(" "),
  },
];

// ---------------------------------------------------------------------------
// Load corpus + targets, encode (or reuse cached activations), score both.
// ---------------------------------------------------------------------------
const corpus = JSON.parse(await readFile(args.texts, "utf8")) as TextProbe[];
const allProbes = [...corpus, ...ADVERSARIES];

const targets = await Promise.all(
  TARGET_KEYS.map(async (key) => ({
    key,
    activation: (
      JSON.parse(
        await readFile(
          `.agent/runs/paint-${key}/paint-${key}/target.json`,
          "utf8",
        ),
      ) as TargetFile
    ).activation,
  })),
);

// Reuse any previously-encoded activations from --out so reruns are zero-call.
const cachedById = new Map<string, ActivationTrace>();
try {
  const prior = JSON.parse(await readFile(OUT_PATH, "utf8")) as CacheFile;
  for (const row of prior.rows ?? []) {
    if (row.activation?.values?.length) cachedById.set(row.id, row.activation);
  }
  if (cachedById.size) {
    console.log(
      `Reusing ${cachedById.size} cached activations from ${OUT_PATH}`,
    );
  }
} catch {
  // no cache yet
}

const config = { ...loadConfig(), oracleMode: args.oracle ?? "http" };
const oracle = createOracle(config);

// The hosted TRIBE oracle's own retry only fires for errors it classifies as
// retryable; a transient 502 on the job-poll slips through and would otherwise
// kill a 20+ minute run on a single server blip. Wrap each encode in our own
// backoff so the probe survives transient 5xx / fetch failures. Banked rows in
// --out are never re-encoded, so even a hard failure resumes zero-call.
async function encodeWithRetry(
  stimulus: Parameters<typeof oracle.encode>[0],
): Promise<ActivationTrace> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await oracle.encode(stimulus);
    } catch (error) {
      lastError = error;
      const backoffMs = 2000 * attempt;
      console.log(
        `  encode attempt ${attempt}/5 failed (${String(error).split("\n")[0]}); retrying in ${backoffMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

type Scored = {
  id: string;
  text: string;
  activation: ActivationTrace;
  blend: Record<string, number>;
  softdtw: Record<string, number>;
};

// Concurrency for the network-bound encode phase. The hosted TRIBE setup now
// runs jobs in parallel, so we fan out a bounded pool instead of one-at-a-time.
// Kept modest so we don't re-saturate the job queue. Override with --concurrency.
const ENCODE_CONCURRENCY = args.concurrency ?? 4;

// Live map of id -> activation, seeded from the cache and filled by the encode
// pool. The write-back serializes through writeCache so concurrent encodes don't
// interleave file writes.
const activations = new Map<string, ActivationTrace>(cachedById);
let writeChain: Promise<void> = Promise.resolve();
function persist(): void {
  writeChain = writeChain.then(() =>
    writeFile(
      OUT_PATH,
      `${JSON.stringify(
        {
          rows: allProbes
            .filter((p) => activations.has(p.id))
            .map((p) => ({
              id: p.id,
              text: p.text,
              activation: activations.get(p.id),
            })),
        },
        null,
        2,
      )}\n`,
    ),
  );
}

// --- Phase 1: encode every uncached probe with a bounded concurrency pool ---
// (--offline skips encoding entirely and analyzes whatever is already cached —
// used when TRIBE is unavailable but enough activations are banked to conclude.)
const toEncode = args.offline
  ? []
  : allProbes.filter((p) => !activations.get(p.id)?.values?.length);
if (args.offline) {
  console.log(
    `OFFLINE: analyzing ${activations.size} cached activations, no TRIBE calls.`,
  );
} else {
  console.log(
    `Encoding ${toEncode.length} probes (concurrency=${ENCODE_CONCURRENCY}); ${activations.size} already cached.`,
  );
}
let nextIndex = 0;
let completed = 0;
async function encodeWorker(): Promise<void> {
  while (nextIndex < toEncode.length) {
    const probe = toEncode[nextIndex];
    nextIndex += 1;
    const rendered = await renderPayload({ type: "text", text: probe.text });
    const activation = await encodeWithRetry(rendered.encoderInput);
    activations.set(probe.id, activation);
    completed += 1;
    console.log(
      `  [${String(completed).padStart(2)}/${toEncode.length}] ${probe.id.padEnd(30)} frames=${activation.values?.length ?? 0}`,
    );
    persist(); // bank each activation as it lands
  }
}

try {
  if (toEncode.length > 0) {
    await Promise.all(
      Array.from(
        { length: Math.min(ENCODE_CONCURRENCY, Math.max(1, toEncode.length)) },
        () => encodeWorker(),
      ),
    );
    await writeChain; // flush final cache write
  }
} finally {
  await oracle.shutdown?.();
}

// --- Phase 2: score everything in deterministic (original) order ---
const scored: Scored[] = [];
for (const probe of allProbes) {
  const activation = activations.get(probe.id);
  if (!activation?.values?.length) {
    console.log(`  SKIP ${probe.id} — no activation (encode failed)`);
    continue;
  }
  const blend: Record<string, number> = {};
  const softdtw: Record<string, number> = {};
  for (const target of targets) {
    blend[target.key] = neuralTrajectorySimilarity(
      target.activation,
      activation,
    );
    softdtw[target.key] = softDtwSimilarity(
      target.activation.values ?? [],
      activation.values ?? [],
    );
  }
  scored.push({ id: probe.id, text: probe.text, activation, blend, softdtw });
  console.log(
    `${probe.id.padEnd(30)} frames=${String(activation.values?.length ?? 0).padStart(2)}  ` +
      `blend[sn]=${blend.starry_night.toFixed(4)} sdtw[sn]=${softdtw.starry_night.toFixed(4)}`,
  );
}

// ---------------------------------------------------------------------------
// Analysis.
// ---------------------------------------------------------------------------
const corpusIds = new Set(corpus.map((p) => p.id));
function styleOf(id: string): string | undefined {
  return id.includes("__") ? id.split("__")[1] : undefined;
}
function paintingOf(id: string): string | undefined {
  const k = id.split("__")[0];
  return (TARGET_KEYS as readonly string[]).includes(k) ? k : undefined;
}

console.log(
  "\n================ MATCH-RANK (does a painting's own text win its column?) ================",
);
// For each target column, rank all corpus texts; report where the matching
// painting's own emotionFirst/divergent texts land. This is the primary signal.
function rankInColumn(
  get: (s: Scored) => Record<string, number>,
  targetKey: string,
): Scored[] {
  return scored
    .filter((s) => corpusIds.has(s.id))
    .slice()
    .sort((x, y) => get(y)[targetKey] - get(x)[targetKey]);
}

for (const metricName of ["blend", "softdtw"] as const) {
  const get = (s: Scored) => (metricName === "blend" ? s.blend : s.softdtw);
  console.log(`\n--- ${metricName} ---`);
  for (const target of targets) {
    const ranked = rankInColumn(get, target.key);
    const top = ranked
      .slice(0, 3)
      .map((s, i) => `${i + 1}.${s.id}(${get(s)[target.key].toFixed(3)})`)
      .join("  ");
    // where does this painting's OWN text rank?
    const ownRanks = ranked
      .map((s, i) => ({ s, rank: i + 1 }))
      .filter(({ s }) => paintingOf(s.id) === target.key)
      .map(({ s, rank }) => `${styleOf(s.id)}@${rank}`)
      .join(" ");
    console.log(`  ${target.key.padEnd(13)} top3: ${top}`);
    console.log(`  ${" ".padEnd(13)} own-text ranks: ${ownRanks}`);
  }
}

console.log(
  "\n================ ANTI-GAMING: adversary gap (PRIMARY) ================",
);
console.log(
  "For each target: best legit corpus score minus best adversary score. Larger = more robust.",
);
for (const metricName of ["blend", "softdtw"] as const) {
  const get = (s: Scored) => (metricName === "blend" ? s.blend : s.softdtw);
  console.log(`\n--- ${metricName} ---`);
  let gapSum = 0;
  for (const target of targets) {
    const legit = scored
      .filter((s) => corpusIds.has(s.id))
      .reduce((mx, s) => Math.max(mx, get(s)[target.key]), -Infinity);
    const advRows = scored.filter((s) => s.id.startsWith("ADV__"));
    const adv = advRows.reduce(
      (best, s) =>
        get(s)[target.key] > best.v
          ? { id: s.id, v: get(s)[target.key] }
          : best,
      { id: "", v: -Infinity },
    );
    const gap = legit - adv.v;
    gapSum += gap;
    console.log(
      `  ${target.key.padEnd(13)} legitBest=${legit.toFixed(3)}  worstAdv=${adv.v.toFixed(3)} (${adv.id})  gap=${gap.toFixed(3)}`,
    );
  }
  console.log(`  MEAN adversary gap: ${(gapSum / targets.length).toFixed(3)}`);
}

console.log(
  "\n================ SECONDARY (characterizations, NOT the verdict) ================",
);
console.log(
  "PLAIN-last: does flat 'descriptive' rank below emotionFirst/divergent? (TRIBE emotion-bias, not anti-gaming)",
);
for (const metricName of ["blend", "softdtw"] as const) {
  const get = (s: Scored) => (metricName === "blend" ? s.blend : s.softdtw);
  let plainLast = 0;
  let counted = 0;
  for (const key of TARGET_KEYS) {
    const desc = scored.find((s) => s.id === `${key}__descriptive`);
    const emo = scored.find((s) => s.id === `${key}__emotionFirst`);
    const div = scored.find((s) => s.id === `${key}__divergent`);
    if (!desc || !emo || !div) continue;
    counted += 1;
    if (get(desc)[key] < get(emo)[key] && get(desc)[key] < get(div)[key])
      plainLast += 1;
  }
  console.log(
    `  ${metricName}: descriptive-ranks-last ${plainLast}/${counted}`,
  );
}
console.log(
  "\ncross-modal spread (max-min own-text score across paintings; wider = stronger climb signal):",
);
for (const metricName of ["blend", "softdtw"] as const) {
  const get = (s: Scored) => (metricName === "blend" ? s.blend : s.softdtw);
  const own = scored
    .filter((s) => corpusIds.has(s.id) && paintingOf(s.id))
    .map((s) => get(s)[paintingOf(s.id) as string]);
  const spread = Math.max(...own) - Math.min(...own);
  console.log(`  ${metricName}: ${spread.toFixed(3)}`);
}

console.log("\nDONE — activations cached to", OUT_PATH);

function parseArgs(argv: string[]): {
  texts?: string;
  out?: string;
  oracle?: "mock" | "tribe" | "http";
  concurrency?: number;
  offline?: boolean;
} {
  const parsed: {
    texts?: string;
    out?: string;
    oracle?: "mock" | "tribe" | "http";
    concurrency?: number;
    offline?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--texts") {
      parsed.texts = value;
      i += 1;
    } else if (flag === "--out") {
      parsed.out = value;
      i += 1;
    } else if (flag === "--oracle") {
      parsed.oracle = value as "mock" | "tribe" | "http";
      i += 1;
    } else if (flag === "--concurrency") {
      parsed.concurrency = Number(value);
      i += 1;
    } else if (flag === "--offline") {
      parsed.offline = true;
    }
  }
  return parsed;
}

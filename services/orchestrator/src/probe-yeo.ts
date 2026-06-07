import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";

type TextProbe = {
  id?: string;
  text: string;
};

type TribeJob = {
  job_id: string;
};

type TribeJobStatus = {
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
};

type Yeo7Means = Record<string, number>;

type YeoProbeResult = {
  id: string;
  text: string;
  yeo7Means: Yeo7Means;
  yeo7DeltaFromTarget?: Yeo7Means;
  targetGapSummary?: {
    underTarget: string[];
    overTarget: string[];
  };
};

const NETWORK_ORDER = [
  "Visual",
  "Somatomotor",
  "Dorsal Attention",
  "Ventral Attention",
  "Limbic",
  "Frontoparietal",
  "Default Mode",
];
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 30_000;

const args = parseArgs(process.argv.slice(2));
if (!args.texts) {
  throw new Error(
    "Usage: bun services/orchestrator/src/probe-yeo.ts --texts texts.json [--out results.json] [--target-result target-result.json] [--target-job job_id]",
  );
}

const config = loadConfig();
const baseUrl = (args.baseUrl ?? config.tribeUrl).replace(/\/+$/, "");
const probes = normalizeTextProbes(
  JSON.parse(await readFile(args.texts, "utf8")) as unknown,
);
const createdAt = new Date().toISOString();
const targetYeo = await loadTargetYeo();

try {
  await writeReport([], { status: "submitting" });
  const job = await submitBatch(probes.map((probe) => probe.text));
  await writeReport([], { status: "running", jobId: job.job_id });
  await waitForJob(job.job_id);
  const rawResult = await fetchJobResult(job.job_id);
  const yeoItems = extractYeoItems(rawResult, probes.length);
  const results = probes.map((probe, index) =>
    buildProbeResult({
      probe,
      index,
      yeo7Means: yeoItems[index],
      targetYeo,
    }),
  );
  const report = await writeReport(results, {
    status: "completed",
    jobId: job.job_id,
    rawResultShape: describeResultShape(rawResult),
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeReport([], {
    status: "failed",
    error: String(error),
  });
  throw error;
}

async function submitBatch(texts: string[]): Promise<TribeJob> {
  const response = await fetchWithTimeout(
    `${baseUrl}/predict/text/batch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: texts.map((text) => text.slice(0, 5000)) }),
    },
    "POST /predict/text/batch",
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `POST /predict/text/batch failed: ${response.status} ${detail}`.trim(),
    );
  }
  const job = (await response.json()) as TribeJob;
  if (!job.job_id) {
    throw new Error("POST /predict/text/batch returned no job_id.");
  }
  return job;
}

async function waitForJob(jobId: string): Promise<void> {
  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(
      `${baseUrl}/jobs/${jobId}`,
      undefined,
      `GET /jobs/${jobId}`,
    );
    if (!response.ok) {
      throw new Error(`GET /jobs/${jobId} failed: ${response.status}`);
    }
    const status = (await response.json()) as TribeJobStatus;
    if (status.status === "completed") {
      return;
    }
    if (status.status === "failed") {
      throw new Error(`TRIBE job ${jobId} failed: ${status.error ?? ""}`);
    }
    await delay(args.pollMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(`TRIBE job ${jobId} did not complete before timeout.`);
}

async function fetchJobResult(jobId: string): Promise<unknown> {
  const response = await fetchWithTimeout(
    `${baseUrl}/jobs/${jobId}/result.json`,
    undefined,
    `GET /jobs/${jobId}/result.json`,
  );
  if (!response.ok) {
    throw new Error(
      `GET /jobs/${jobId}/result.json failed: ${response.status}`,
    );
  }
  return response.json();
}

async function loadTargetYeo(): Promise<Yeo7Means | undefined> {
  if (args.targetJob) {
    return extractSingleYeo(await fetchJobResult(args.targetJob));
  }
  if (args.targetResult) {
    return extractSingleYeo(
      JSON.parse(await readFile(args.targetResult, "utf8")) as unknown,
    );
  }
  return undefined;
}

function buildProbeResult(args: {
  probe: TextProbe;
  index: number;
  yeo7Means: Yeo7Means;
  targetYeo?: Yeo7Means;
}): YeoProbeResult {
  const id =
    args.probe.id ?? `probe-${String(args.index + 1).padStart(2, "0")}`;
  const delta = args.targetYeo
    ? subtractYeo(args.yeo7Means, args.targetYeo)
    : undefined;
  return {
    id,
    text: args.probe.text,
    yeo7Means: orderYeo(args.yeo7Means),
    yeo7DeltaFromTarget: delta,
    targetGapSummary: delta ? summarizeTargetGap(delta) : undefined,
  };
}

function extractSingleYeo(value: unknown): Yeo7Means {
  const items = extractYeoItems(value, 1);
  return items[0];
}

function extractYeoItems(value: unknown, expectedCount: number): Yeo7Means[] {
  if (hasYeo(value)) {
    return [orderYeo(value.yeo7_means)];
  }
  if (isObject(value) && Array.isArray(value.items)) {
    return extractYeoArray(value.items, expectedCount, "items");
  }
  if (isObject(value) && Array.isArray(value.results)) {
    return extractYeoArray(value.results, expectedCount, "results");
  }
  if (isObject(value) && Array.isArray(value.yeo7_means)) {
    return extractYeoArray(value.yeo7_means, expectedCount, "yeo7_means");
  }
  if (Array.isArray(value)) {
    return extractYeoArray(value, expectedCount, "root array");
  }
  throw new Error(
    `Could not find Yeo-7 means in result shape ${JSON.stringify(
      describeResultShape(value),
    )}.`,
  );
}

function extractYeoArray(
  value: unknown[],
  expectedCount: number,
  source: string,
): Yeo7Means[] {
  const items = value.map((item) => (hasYeo(item) ? item.yeo7_means : item));
  const yeoItems = items.map((item, index) => {
    if (!isYeoMeans(item)) {
      throw new Error(`${source}[${index}] is not a Yeo-7 means object.`);
    }
    return orderYeo(item);
  });
  if (yeoItems.length !== expectedCount) {
    throw new Error(
      `${source} returned ${yeoItems.length} Yeo items for ${expectedCount} probes.`,
    );
  }
  return yeoItems;
}

function subtractYeo(candidate: Yeo7Means, target: Yeo7Means): Yeo7Means {
  return Object.fromEntries(
    NETWORK_ORDER.map((network) => [
      network,
      (candidate[network] ?? 0) - (target[network] ?? 0),
    ]),
  );
}

function summarizeTargetGap(deltaFromTarget: Yeo7Means): {
  underTarget: string[];
  overTarget: string[];
} {
  const sorted = Object.entries(deltaFromTarget).sort(
    (left, right) => Math.abs(right[1]) - Math.abs(left[1]),
  );
  return {
    underTarget: sorted
      .filter(([, delta]) => delta < 0)
      .slice(0, 3)
      .map(([network, delta]) => `${network} ${delta.toFixed(6)}`),
    overTarget: sorted
      .filter(([, delta]) => delta > 0)
      .slice(0, 3)
      .map(([network, delta]) => `${network} +${delta.toFixed(6)}`),
  };
}

function orderYeo(value: Yeo7Means): Yeo7Means {
  return Object.fromEntries(
    NETWORK_ORDER.map((network) => [network, value[network] ?? 0]),
  );
}

function hasYeo(value: unknown): value is { yeo7_means: Yeo7Means } {
  return isObject(value) && isYeoMeans(value.yeo7_means);
}

function isYeoMeans(value: unknown): value is Yeo7Means {
  return (
    isObject(value) &&
    NETWORK_ORDER.every((network) => typeof value[network] === "number")
  );
}

async function writeReport(
  results: YeoProbeResult[],
  options: {
    status: "submitting" | "running" | "completed" | "failed";
    jobId?: string;
    error?: string;
    rawResultShape?: unknown;
  },
) {
  const report = {
    target: targetYeo ? { yeo7Means: targetYeo } : undefined,
    texts: args.texts,
    baseUrl,
    createdAt,
    updatedAt: new Date().toISOString(),
    status: options.status,
    jobId: options.jobId,
    error: options.error,
    rawResultShape: options.rawResultShape,
    results,
  };

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function describeResultShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: describeResultShape(value[0]),
    };
  }
  if (!isObject(value)) {
    return { type: typeof value };
  }
  return {
    type: "object",
    keys: Object.keys(value),
    items: Array.isArray(value.items)
      ? {
          length: value.items.length,
          first: describeResultShape(value.items[0]),
        }
      : undefined,
    results: Array.isArray(value.results)
      ? {
          length: value.results.length,
          first: describeResultShape(value.results[0]),
        }
      : undefined,
  };
}

function normalizeTextProbes(value: unknown): TextProbe[] {
  if (!Array.isArray(value)) {
    throw new Error("Text probes must be a JSON array.");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { text: item };
    }
    if (isObject(item) && "text" in item && typeof item.text === "string") {
      return item as TextProbe;
    }
    throw new Error(`Invalid text probe at index ${index}.`);
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: Timer | undefined;
  try {
    const request = fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const deadline = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArgs(argv: string[]): {
  texts?: string;
  out?: string;
  targetResult?: string;
  targetJob?: string;
  baseUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (flag === "--texts") {
      parsed.texts = value;
      index += 1;
    } else if (flag === "--out") {
      parsed.out = value;
      index += 1;
    } else if (flag === "--target-result") {
      parsed.targetResult = value;
      index += 1;
    } else if (flag === "--target-job") {
      parsed.targetJob = value;
      index += 1;
    } else if (flag === "--base-url") {
      parsed.baseUrl = value;
      index += 1;
    } else if (flag === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(value, "--timeout-ms");
      index += 1;
    } else if (flag === "--poll-ms") {
      parsed.pollMs = positiveInteger(value, "--poll-ms");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

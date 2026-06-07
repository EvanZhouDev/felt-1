import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ActivationTrace,
  EncoderStimulus,
  NeuralOracle,
} from "@volta/core";
import type { OrchestratorConfig } from "./config.ts";

export function createOracle(config: OrchestratorConfig): NeuralOracle {
  if (config.oracleMode === "tribe") {
    return new TribeOracle(config);
  }
  if (config.oracleMode === "http") {
    return new HttpTribeOracle(config);
  }
  return new MockOracle();
}

class MockOracle implements NeuralOracle {
  async encode(stimulus: EncoderStimulus): Promise<ActivationTrace> {
    const text = `${stimulus.text ?? ""} ${stimulus.events
      .map((event) => event.text ?? event.filepath ?? event.type)
      .join(" ")}`;
    const values = deterministicVector(text, 32);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length;
    const norm = Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0),
    );

    return {
      model: "mock-neural-oracle",
      shape: [1, values.length],
      values: [values],
      summary: {
        mean,
        std: Math.sqrt(variance),
        norm,
      },
    };
  }
}

// Hosted TRIBE v2 brain encoder (https://tribe.bryanhu.com): an async job API.
// Submit a stimulus, poll the job, then download `result.json`, which carries
// the FULL per-timestep prediction matrix (shape [timesteps, 20484] over the
// fsaverage5 mesh) plus a per-Yeo-network breakdown. We keep every timestep —
// the scorer compares the activation trajectory, so we must not collapse time.
const TRIBE_VERTEX_COUNT = 20484;
const TRIBE_POLL_INTERVAL_MS = 1500;
const TRIBE_REQUEST_TIMEOUT_MS = 30_000;

type TribeJob = {
  job_id: string;
};

type TribeJobStatus = {
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
};

// Shape of GET /jobs/:id/result.json under the current hosted TRIBE API.
type TribeResult = {
  timesteps: number;
  vertices: number;
  // [timesteps][vertices] — the full activation, one frame per ~1s segment.
  predictions: number[][];
  // Per-Yeo-network: each value is [timesteps][verticesInNetwork].
  predictions_by_network?: Record<string, number[][]>;
  yeo7_means?: Record<string, number>;
};

class HttpTribeOracle implements NeuralOracle {
  private readonly baseUrl: string;
  private readonly timeoutMs = Number(
    process.env.VOLTA_ORACLE_TIMEOUT_MS ?? 600_000,
  );

  constructor(config: OrchestratorConfig) {
    this.baseUrl = config.tribeUrl.replace(/\/+$/, "");
  }

  async encode(stimulus: EncoderStimulus): Promise<ActivationTrace> {
    let lastError: unknown;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.encodeOnce(stimulus);
      } catch (error) {
        lastError = error;
        if (!isRetryableTribeError(error) || attempt === maxAttempts) {
          throw error;
        }
        // Exponential backoff: the hosted TRIBE is a slow async job API that
        // restarts and returns transient 5xx/Cloudflare 502s mid-run.
        await delay(TRIBE_POLL_INTERVAL_MS * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  private async encodeOnce(
    stimulus: EncoderStimulus,
  ): Promise<ActivationTrace> {
    const job = await this.submit(stimulus);
    await this.waitForJob(job.job_id);
    const result = await this.fetchResult(job.job_id);

    // Keep every timestep: values[t] is the R^vertices frame at segment t.
    const values = result.predictions;
    const timesteps = values.length;
    const vertices = values[0]?.length ?? 0;

    // Summary stats over the whole flattened matrix (kept for archive/index
    // display and the sparse-trace fallback; scoring uses the full `values`).
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (const frame of values) {
      for (const v of frame) {
        sum += v;
        sumSq += v * v;
        count += 1;
      }
    }
    const mean = count ? sum / count : 0;
    const variance = count ? sumSq / count - mean * mean : 0;
    const norm = Math.sqrt(sumSq);

    const diagnostics = buildDiagnostics(result);

    return {
      model: "tribev2-http",
      shape: [timesteps, vertices],
      values,
      ...(diagnostics ? { diagnostics } : {}),
      summary: { mean, std: Math.sqrt(Math.max(variance, 0)), norm },
    };
  }

  private async submit(stimulus: EncoderStimulus): Promise<TribeJob> {
    if (stimulus.kind === "text") {
      const text = stimulus.text ?? "";
      const response = await fetchWithTimeout(
        `${this.baseUrl}/predict/text`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: text.slice(0, 5000) }),
        },
        "POST /predict/text",
      );
      return this.asJob(response, "POST /predict/text");
    }

    // A still image renders with kind "video" (it becomes a still-hold clip for
    // TRIBE) but carries an "Image" stimulus event and no pre-built mp4. The
    // hosted /predict/image route ingests a raw image directly (verified live
    // 2026-06-07), so route those there; only genuine pre-rendered video/code
    // clips go to /predict/video.
    const endpoint = endpointForStimulus(stimulus);
    const file = await this.readArtifact(stimulus);
    const form = new FormData();
    form.append("file", file.blob, file.name);
    const response = await fetchWithTimeout(
      `${this.baseUrl}/predict/${endpoint}`,
      {
        method: "POST",
        body: form,
      },
      `POST /predict/${endpoint}`,
    );
    return this.asJob(response, `POST /predict/${endpoint}`);
  }

  private async readArtifact(
    stimulus: EncoderStimulus,
  ): Promise<{ blob: Blob; name: string }> {
    const path = stimulus.artifactPath;
    if (!path) {
      throw new Error(
        `HttpTribeOracle: ${stimulus.kind} stimulus has no artifactPath to upload.`,
      );
    }
    if (path.startsWith("http://") || path.startsWith("https://")) {
      const response = await fetchWithTimeout(path, undefined, "GET artifact");
      if (!response.ok) {
        throw new Error(`Failed to fetch artifact ${path}: ${response.status}`);
      }
      return { blob: await response.blob(), name: basename(path) };
    }
    const local = path.startsWith("file://")
      ? path.slice("file://".length)
      : path;
    if (local.includes("://")) {
      throw new Error(
        `HttpTribeOracle: unsupported artifact URI scheme: ${path}. Provide a local file path or http(s) URL.`,
      );
    }
    const bytes = await readFile(local);
    return { blob: new Blob([bytes]), name: basename(local) };
  }

  private async asJob(response: Response, label: string): Promise<TribeJob> {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${label} failed: ${response.status} ${detail}`.trim());
    }
    const job = (await response.json()) as TribeJob;
    if (!job.job_id) {
      throw new Error(`${label} returned no job_id.`);
    }
    return job;
  }

  private async waitForJob(jobId: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/jobs/${jobId}`,
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
      await delay(TRIBE_POLL_INTERVAL_MS);
    }
    throw new Error(
      `TRIBE job ${jobId} did not complete within ${this.timeoutMs}ms.`,
    );
  }

  private async fetchResult(jobId: string): Promise<TribeResult> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/jobs/${jobId}/result.json`,
      undefined,
      `GET /jobs/${jobId}/result.json`,
    );
    if (!response.ok) {
      throw new Error(
        `GET /jobs/${jobId}/result.json failed: ${response.status}`,
      );
    }
    const result = (await response.json()) as TribeResult;
    if (!Array.isArray(result.predictions) || result.predictions.length === 0) {
      throw new Error(`TRIBE result ${jobId} has no predictions array.`);
    }
    const vertices = result.predictions[0]?.length ?? 0;
    if (vertices !== TRIBE_VERTEX_COUNT) {
      throw new Error(
        `TRIBE result ${jobId} has ${vertices} vertices; expected ${TRIBE_VERTEX_COUNT}.`,
      );
    }
    return result;
  }
}

// Build the optional diagnostics block from a hosted-TRIBE result. The new API
// returns the full per-network activation (`predictions_by_network`) instead of
// the old scalar `yeo7_means`. We summarize each network to ONE scalar — its
// mean activation magnitude over the run — so the judge keeps its compact,
// promptable per-network mutation hints. We deliberately do NOT store the full
// per-network vectors on the trace: they are ~143k floats and would flood the
// Codex prompts that serialize `activation.diagnostics`.
function buildDiagnostics(
  result: TribeResult,
): ActivationTrace["diagnostics"] | undefined {
  if (result.yeo7_means) {
    return { yeo7Means: result.yeo7_means };
  }
  if (result.predictions_by_network) {
    const yeo7Means: Record<string, number> = {};
    for (const [network, frames] of Object.entries(
      result.predictions_by_network,
    )) {
      yeo7Means[network] = meanMagnitude(frames);
    }
    return { yeo7Means };
  }
  return undefined;
}

// Mean absolute activation across every value of a [timesteps][n] matrix — a
// single scalar standing for how strongly a Yeo network engaged over the run.
function meanMagnitude(frames: number[][]): number {
  let sum = 0;
  let count = 0;
  for (const frame of frames) {
    for (const value of frame) {
      sum += Math.abs(value);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

const IMAGE_ARTIFACT_EXT = /\.(png|jpe?g|webp)$/i;

// Pick the hosted predict endpoint for a non-text stimulus. Audio is explicit.
// A still image renders with kind "video" but carries an "Image" event (and an
// image-extension artifact) and no pre-built mp4 — those go to /predict/image.
// Anything else with kind "video" is a real rendered clip → /predict/video.
function endpointForStimulus(
  stimulus: EncoderStimulus,
): "audio" | "image" | "video" {
  if (stimulus.kind === "audio") {
    return "audio";
  }
  const isStillImage =
    stimulus.events.some((event) => event.type === "Image") ||
    (stimulus.artifactPath
      ? IMAGE_ARTIFACT_EXT.test(stimulus.artifactPath)
      : false);
  return isStillImage ? "image" : "video";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableTribeError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("Server restarted while job was in flight") ||
    message.includes("resubmitted as new job") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    // Match 5xx by status digits anywhere, not " 502 " with surrounding spaces:
    // the thrown errors read "...failed: 502" (no trailing space), so the old
    // whitespace match let transient bad-gateways kill a whole run.
    /\b50[234]\b/.test(message) ||
    message.includes("Bad Gateway")
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = `${label} timed out after ${TRIBE_REQUEST_TIMEOUT_MS}ms.`;
  let timeout: Timer | undefined;
  try {
    const request = fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const deadline = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(timeoutError));
      }, TRIBE_REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(timeoutError);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class TribeOracle implements NeuralOracle {
  private worker: PythonOracleWorker | undefined;

  constructor(private readonly config: OrchestratorConfig) {}

  async encode(stimulus: EncoderStimulus): Promise<ActivationTrace> {
    return this.getWorker().encode({
      stimulus,
      cacheFolder: join(this.config.repoRoot, "vendor/tribev2/cache"),
      textFeatureModel: "unsloth/Llama-3.2-3B-bnb-4bit",
    });
  }

  async shutdown(): Promise<void> {
    await this.worker?.shutdown();
    this.worker = undefined;
  }

  private getWorker(): PythonOracleWorker {
    if (!this.worker) {
      this.worker = new PythonOracleWorker(this.config);
    }
    return this.worker;
  }
}

function deterministicVector(seed: string, length: number): number[] {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const values: number[] = [];
  let state = hash >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    values.push((state / 0xffffffff) * 2 - 1);
  }
  return values;
}

type WorkerRequest = {
  stimulus: EncoderStimulus;
  cacheFolder: string;
  textFeatureModel: string;
};

type WorkerResponse =
  | {
      id: string;
      ok: true;
      trace: ActivationTrace;
    }
  | {
      id: string;
      ok: false;
      error: string;
      traceback?: string;
    };

type PendingRequest = {
  resolve: (trace: ActivationTrace) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class PythonOracleWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs = Number(
    process.env.VOLTA_ORACLE_TIMEOUT_MS ?? 600_000,
  );

  constructor(private readonly config: OrchestratorConfig) {}

  encode(request: WorkerRequest): Promise<ActivationTrace> {
    const child = this.ensureChild();
    const id = randomUUID();
    const payload = JSON.stringify({
      id,
      ...request,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `TRIBE oracle request timed out after ${this.requestTimeoutMs}ms.`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });

      child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          this.clearPending(id);
          reject(error);
        }
      });
    });
  }

  shutdown(): Promise<void> {
    if (!this.child) {
      return Promise.resolve();
    }

    const child = this.child;
    this.child = null;

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill();
      }, 1000);
      killTimer.unref?.();

      child.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });

      child.stdin.end();
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    const script = join(
      this.config.repoRoot,
      "services/orchestrator/python/tribe_oracle_worker.py",
    );
    const tribeRoot = join(this.config.repoRoot, "vendor/tribev2");
    const child = spawn(this.config.pythonPath, [script], {
      cwd: tribeRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HUB_ENABLE_HF_TRANSFER: "1",
        HF_HUB_DISABLE_XET: "1",
        PYTHONPATH: process.env.PYTHONPATH
          ? `${tribeRoot}:${process.env.PYTHONPATH}`
          : tribeRoot,
      },
    }) as ChildProcessWithoutNullStreams;
    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString();
      this.drainStdout();
    });

    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000);
    });

    child.on("error", (error) => {
      this.rejectAll(error);
    });

    child.on("close", (code) => {
      const detail = this.stderrTail ? `: ${this.stderrTail.trim()}` : "";
      this.child = null;
      this.rejectAll(
        new Error(`TRIBE oracle exited with code ${code}${detail}`),
      );
    });

    this.child = child;
    return child;
  }

  private drainStdout(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000);
      return;
    }

    const pending = this.clearPending(response.id);
    if (!pending) {
      return;
    }

    if (response.ok) {
      pending.resolve(response.trace);
      return;
    }

    pending.reject(
      new Error(
        response.traceback
          ? `${response.error}\n${response.traceback}`
          : response.error,
      ),
    );
  }

  private clearPending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    return pending;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

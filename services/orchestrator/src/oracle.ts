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
// Submit a stimulus, poll the job, then download the raw float16 prediction
// vector (shape [timesteps, 20484] over the fsaverage5 mesh) and mean-pool over
// time into one R^20484 vector that `scoreActivations` can compare with cosine.
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.encodeOnce(stimulus);
      } catch (error) {
        lastError = error;
        if (!isRetryableTribeError(error) || attempt === 3) {
          throw error;
        }
        await delay(TRIBE_POLL_INTERVAL_MS * attempt);
      }
    }

    throw lastError;
  }

  private async encodeOnce(
    stimulus: EncoderStimulus,
  ): Promise<ActivationTrace> {
    const job = await this.submit(stimulus);
    await this.waitForJob(job.job_id);
    const values = await this.fetchPooledValues(job.job_id);

    const flat = values[0];
    const mean = flat.reduce((sum, value) => sum + value, 0) / flat.length;
    const variance =
      flat.reduce((sum, value) => sum + (value - mean) ** 2, 0) / flat.length;
    const norm = Math.sqrt(flat.reduce((sum, value) => sum + value * value, 0));

    return {
      model: "tribev2-http",
      shape: [1, flat.length],
      values,
      summary: { mean, std: Math.sqrt(variance), norm },
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

    // image targets are fed as a short still-hold mp4 via /predict/video
    // (the multipart /predict/image route is broken server-side).
    const endpoint = stimulus.kind === "audio" ? "audio" : "video";
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

  private async fetchPooledValues(jobId: string): Promise<number[][]> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/jobs/${jobId}/preds.norm.f16.bin`,
      undefined,
      `GET /jobs/${jobId}/preds.norm.f16.bin`,
    );
    if (!response.ok) {
      throw new Error(
        `GET /jobs/${jobId}/preds.norm.f16.bin failed: ${response.status}`,
      );
    }
    const buffer = await response.arrayBuffer();
    const raw = decodeFloat16(new Uint8Array(buffer));
    if (raw.length === 0 || raw.length % TRIBE_VERTEX_COUNT !== 0) {
      throw new Error(
        `Unexpected prediction length ${raw.length}; expected a multiple of ${TRIBE_VERTEX_COUNT}.`,
      );
    }
    const timesteps = raw.length / TRIBE_VERTEX_COUNT;
    const pooled = new Array<number>(TRIBE_VERTEX_COUNT).fill(0);
    for (let t = 0; t < timesteps; t += 1) {
      const offset = t * TRIBE_VERTEX_COUNT;
      for (let v = 0; v < TRIBE_VERTEX_COUNT; v += 1) {
        pooled[v] += raw[offset + v];
      }
    }
    for (let v = 0; v < TRIBE_VERTEX_COUNT; v += 1) {
      pooled[v] /= timesteps;
    }
    return [pooled];
  }
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
    message.includes(" 502 ") ||
    message.includes(" 503 ") ||
    message.includes(" 504 ")
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TRIBE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `${label} timed out after ${TRIBE_REQUEST_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Decode a little-endian IEEE 754 half-precision (float16) byte array.
function decodeFloat16(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = halfToFloat(view.getUint16(i * 2, true));
  }
  return out;
}

function halfToFloat(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return (sign ? -1 : 1) * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction ? Number.NaN : (sign ? -1 : 1) * Number.POSITIVE_INFINITY;
  }
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
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

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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

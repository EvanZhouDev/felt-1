import {
  type AgentBackend,
  type AgentInvocation,
  type AgentResult,
  ClaudeCliBackend,
  CodexCliBackend,
  DeepSeekBackend,
} from "@volta/agent-sdk";
import type { AgentBackendConfig } from "./config.ts";

// One factory for every entrypoint (server, smokes, experiments).
// VOLTA_AGENT_BACKEND accepts a priority list ("codex,claude"): when the
// primary fails on a usage/rate cap, the invocation retries on the next
// backend instead of killing the run — a Codex cap halted a whole night of
// experiments before this existed.
export function createAgentBackend(config: AgentBackendConfig): AgentBackend {
  const chain = config.chain.map(buildOne);
  if (chain.length === 1) {
    return chain[0];
  }
  return new FailoverBackend(chain);
}

function buildOne(config: AgentBackendConfig["chain"][number]): AgentBackend {
  if (config.mode === "deepseek") {
    return new DeepSeekBackend({
      model: config.model,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });
  }
  if (config.mode === "claude") {
    return new ClaudeCliBackend({
      command: config.command,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }
  return new CodexCliBackend({
    command: config.command,
    model: config.model,
    profile: config.profile,
    timeoutMs: config.timeoutMs,
  });
}

class FailoverBackend implements AgentBackend {
  constructor(private readonly chain: AgentBackend[]) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    let lastError: unknown;
    for (const backend of this.chain) {
      try {
        return await backend.run(invocation);
      } catch (error) {
        lastError = error;
        if (!isUsageCapError(error) && !isOpaqueCrash(error)) {
          throw error;
        }
        console.error(
          `[backend] backend failed (${String(error).slice(0, 120)}); failing over to next backend`,
        );
      }
    }
    throw lastError;
  }
}

// A CLI backend dying with a nonzero exit and NO diagnostic output (observed:
// "Claude exited with 1. Stderr:" killing all three audio-clean-v3 runs in
// seconds while the CLI worked standalone). With nothing to classify, the
// only wrong move is letting it kill the run when another backend is ready.
function isOpaqueCrash(error: unknown): boolean {
  return /exited with \d+\.?\s*Stderr:\s*$/i.test(String(error).trim());
}

function isUsageCapError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("usage limit") ||
    message.includes("rate limit") ||
    message.includes("usage_limit") ||
    message.includes("quota") ||
    message.includes("purchase more credits") ||
    // DeepSeek insufficient-balance / throttling
    message.includes("Insufficient Balance") ||
    /\b402\b/.test(message) ||
    /\b429\b/.test(message)
  );
}

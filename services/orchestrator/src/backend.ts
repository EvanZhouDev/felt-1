import {
  type AgentBackend,
  type AgentInvocation,
  type AgentResult,
  ClaudeCliBackend,
  CodexCliBackend,
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
        if (!isUsageCapError(error)) {
          throw error;
        }
        console.error(
          `[backend] usage cap hit (${String(error).slice(0, 120)}); failing over to next backend`,
        );
      }
    }
    throw lastError;
  }
}

function isUsageCapError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("usage limit") ||
    message.includes("rate limit") ||
    message.includes("usage_limit") ||
    message.includes("quota") ||
    message.includes("purchase more credits")
  );
}

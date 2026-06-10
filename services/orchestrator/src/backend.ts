import {
  type AgentBackend,
  ClaudeCliBackend,
  CodexCliBackend,
} from "@volta/agent-sdk";
import type { AgentBackendConfig } from "./config.ts";

// One factory for every entrypoint (server, smokes, experiments), so
// VOLTA_AGENT_BACKEND switches the whole system between agent CLIs.
export function createAgentBackend(config: AgentBackendConfig): AgentBackend {
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

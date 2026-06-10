import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputNode } from "@volta/core";
import { buildCandidatePrompt, buildJudgePrompt } from "../prompts.ts";
import type {
  AgentBackend,
  AgentInvocation,
  AgentResult,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "../types.ts";
import {
  candidateSchema,
  imageAttachmentPaths,
  judgeSchema,
  normalizeOutputNode,
  pruneNulls,
} from "./codex.ts";

// Claude Code CLI backend: same invocation contract and prompts as the Codex
// backend, executed as `claude -p --output-format json --json-schema <schema>`.
// The CLI's structured output is schema-validated server-side, so responses
// arrive as ready objects in `.structured_output`. Exists so a Codex usage cap
// (which has halted real experiment runs twice now) doesn't halt the system —
// switch with VOLTA_AGENT_BACKEND=claude.

export type ClaudeCliBackendOptions = {
  command?: string;
  model?: string;
  timeoutMs?: number;
};

type ClaudeEnvelope = {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
};

type CandidateResponse = {
  outputNode: OutputNode;
  notes: string | null;
};

type JudgeResponse = {
  selectedAgentId: string;
  reasoning: string;
  seedAdherence?: Array<{ agentId: string; score: number }> | null;
};

const MAX_TURNS = 8;

export class ClaudeCliBackend implements AgentBackend {
  private readonly command: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCliBackendOptions = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "sonnet";
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    if (invocation.role === "candidate") {
      return {
        role: "candidate",
        output: await this.runCandidate(invocation),
      };
    }
    return {
      role: "judge",
      decision: await this.runJudge(invocation),
    };
  }

  private async runCandidate(invocation: CandidateAgentInvocation) {
    const response = await this.runClaude<CandidateResponse>({
      invocation,
      prompt: buildCandidatePrompt(invocation),
      schema: candidateSchema(invocation.output.outputType),
      schemaName: "candidate-output.schema.json",
    });
    const outputNode = normalizeOutputNode(
      pruneNulls(response.outputNode),
      invocation.output.outputType,
    );
    const output = {
      agentId: invocation.spec.id,
      outputNode,
    };
    await writeJson(join(invocation.workspace.outputPath, "candidate.json"), {
      ...output,
      claudeNotes: response.notes,
    });
    return output;
  }

  private async runJudge(invocation: JudgeAgentInvocation) {
    const response = await this.runClaude<JudgeResponse>({
      invocation,
      prompt: buildJudgePrompt(invocation),
      schema: judgeSchema(invocation),
      schemaName: "judge-output.schema.json",
    });
    const selected =
      invocation.rankedOutputs.find(
        (output) => output.agentId === response.selectedAgentId,
      ) ?? invocation.rankedOutputs[0];
    if (!selected) {
      throw new Error("Judge received no ranked outputs.");
    }
    const decision = {
      selectedAgentId: selected.agentId,
      selectedNode: selected.outputNode,
      reasoning: response.reasoning,
      ...(response.seedAdherence
        ? { seedAdherence: response.seedAdherence }
        : {}),
    };
    await writeJson(join(invocation.workspace.outputPath, "judge.json"), {
      ...decision,
      requestedSelectedAgentId: response.selectedAgentId,
    });
    return decision;
  }

  private async runClaude<T>(args: {
    invocation: AgentInvocation;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName: string;
  }): Promise<T> {
    const logsPath = args.invocation.workspace.logsPath;
    const imagePaths = imageAttachmentPaths(args.invocation);
    // The Claude CLI has no --image flag; the Read tool views images instead.
    // Reference them in the prompt and allow their directories.
    const prompt = imagePaths.length
      ? `${args.prompt}\n\nVisual context: use the Read tool to view these image files before answering:\n${imagePaths
          .map((path) => `- ${path}`)
          .join("\n")}`
      : args.prompt;

    await Promise.all([
      writeJson(join(logsPath, args.schemaName), args.schema),
      writeFile(join(logsPath, "prompt.md"), prompt, "utf8"),
      writeJson(join(logsPath, "image-attachments.json"), imagePaths),
    ]);

    const cliArgs = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(args.schema),
      "--model",
      args.invocation.spec.model ?? this.model,
      "--max-turns",
      String(MAX_TURNS),
      "--strict-mcp-config",
    ];
    if (imagePaths.length) {
      cliArgs.push("--allowedTools", "Read");
      const dirs = [...new Set(imagePaths.map((path) => dirname(path)))];
      cliArgs.push("--add-dir", ...dirs);
    }

    const result = await spawnClaude({
      command: this.command,
      args: cliArgs,
      cwd: args.invocation.workspace.cwd,
      prompt,
      timeoutMs: this.timeoutMs,
    });
    await Promise.all([
      writeFile(join(logsPath, "claude.stdout"), result.stdout, "utf8"),
      writeFile(join(logsPath, "claude.stderr"), result.stderr, "utf8"),
    ]);

    // Trust the envelope over the exit code: the CLI has been observed to
    // exit 1 while emitting a fully valid success envelope (empty final text
    // alongside present structured_output). Only fall back to the exit code
    // when stdout has no usable envelope.
    let envelope: ClaudeEnvelope | undefined;
    try {
      envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
    } catch {
      envelope = undefined;
    }
    if (envelope && !envelope.is_error && envelope.structured_output != null) {
      return envelope.structured_output as T;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Claude exited with ${result.exitCode}. Stderr: ${result.stderr.slice(-1000)}`,
      );
    }
    if (envelope?.is_error) {
      throw new Error(`Claude returned an error: ${envelope.result}`);
    }
    throw new Error(
      `Claude returned no structured output. Result: ${(envelope?.result ?? "").slice(0, 500)}`,
    );
  }
}

async function spawnClaude(args: {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: args.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude timed out after ${args.timeoutMs}ms.`));
    }, args.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(args.prompt);
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

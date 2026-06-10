import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  judgeSchema,
  normalizeOutputNode,
  parseJsonOutput,
  pruneNulls,
} from "./codex.ts";

// DeepSeek backend: the worst-case fallback. Unlike the Codex/Claude CLI
// backends this is a direct OpenAI-compatible HTTP call — no CLI install, no
// subscription cap, just DEEPSEEK_API_KEY — so the failover chain
// ("codex,claude,deepseek") still generates when both CLIs are down.
// Constraints accepted for that robustness: no tool use, so image
// attachments cannot be viewed (the prompt says so; describer captions still
// carry audio context), and JSON-mode output is schema-checked client-side
// with one retry instead of validated server-side.

export type DeepSeekBackendOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

const MAX_ATTEMPTS = 2;

export class DeepSeekBackend implements AgentBackend {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekBackendOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? "deepseek-chat";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!this.apiKey) {
      throw new Error("DeepSeekBackend requires DEEPSEEK_API_KEY.");
    }
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
    const schema = candidateSchema(invocation.output.outputType);
    const response = await this.complete<{
      outputNode: OutputNode;
      notes: string | null;
    }>({
      invocation,
      prompt: buildCandidatePrompt(invocation),
      schema,
      validate: (value) => {
        normalizeOutputNode(
          pruneNulls((value as { outputNode: unknown }).outputNode),
          invocation.output.outputType,
        );
      },
    });
    const outputNode = normalizeOutputNode(
      pruneNulls(response.outputNode),
      invocation.output.outputType,
    );
    const output = { agentId: invocation.spec.id, outputNode };
    await writeJson(join(invocation.workspace.outputPath, "candidate.json"), {
      ...output,
      deepseekNotes: response.notes,
    });
    return output;
  }

  private async runJudge(invocation: JudgeAgentInvocation) {
    const response = await this.complete<{
      selectedAgentId: string;
      reasoning: string;
      seedAdherence?: Array<{ agentId: string; score: number }> | null;
    }>({
      invocation,
      prompt: buildJudgePrompt(invocation),
      schema: judgeSchema(invocation),
      validate: (value) => {
        const v = value as { selectedAgentId?: unknown; reasoning?: unknown };
        if (
          typeof v.selectedAgentId !== "string" ||
          typeof v.reasoning !== "string"
        ) {
          throw new Error("judge response missing selectedAgentId/reasoning");
        }
      },
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

  private async complete<T>(args: {
    invocation: AgentInvocation;
    prompt: string;
    schema: Record<string, unknown>;
    validate: (value: unknown) => void;
  }): Promise<T> {
    const logsPath = args.invocation.workspace.logsPath;
    const basePrompt = [
      args.prompt,
      "You cannot open files or view attached images in this environment; rely on the descriptions provided above.",
      `Respond with ONLY a single json object (no markdown fences, no commentary) that validates against this JSON Schema:\n${JSON.stringify(args.schema)}`,
    ].join("\n\n");
    await writeFile(join(logsPath, "prompt.md"), basePrompt, "utf8");

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\nYour previous response was invalid: ${String(lastError).slice(0, 300)}. Return ONLY the corrected json object.`;
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: args.invocation.spec.model ?? this.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const bodyText = await response.text();
      await writeFile(
        join(logsPath, `deepseek.response.${attempt}.json`),
        bodyText,
        "utf8",
      );
      if (!response.ok) {
        throw new Error(
          `DeepSeek request failed: ${response.status} ${bodyText.slice(0, 500)}`,
        );
      }
      const parsed = JSON.parse(bodyText) as ChatResponse;
      const content = parsed.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(
          `DeepSeek returned no content: ${bodyText.slice(0, 300)}`,
        );
      }
      try {
        const value = parseJsonOutput(content);
        args.validate(value);
        return value as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `DeepSeek returned invalid structured output after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    );
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

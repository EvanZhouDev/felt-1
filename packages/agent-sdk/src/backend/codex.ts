import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetRef, Node, OutputNode } from "@volta/core";
import { buildCandidatePrompt, buildJudgePrompt } from "../prompts.ts";
import type {
  AgentBackend,
  AgentInvocation,
  AgentResult,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "../types.ts";

export type CodexCliBackendOptions = {
  command?: string;
  model?: string;
  profile?: string;
  timeoutMs?: number;
};

type JsonSchema = Record<string, unknown>;

type CandidateCodexResponse = {
  outputNode: OutputNode;
  notes: string | null;
};

type JudgeCodexResponse = {
  selectedAgentId: string;
  reasoning: string;
};

export class CodexCliBackend implements AgentBackend {
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexCliBackendOptions = {}) {
    this.command = options.command ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 900_000;
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
    const response = await this.runCodex<CandidateCodexResponse>({
      invocation,
      prompt: buildCandidatePrompt(invocation),
      schema: candidateSchema(invocation.output.outputType),
      schemaName: "candidate-output.schema.json",
      outputName: "candidate-codex-output.json",
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
      codexNotes: response.notes,
    });
    return output;
  }

  private async runJudge(invocation: JudgeAgentInvocation) {
    const response = await this.runCodex<JudgeCodexResponse>({
      invocation,
      prompt: buildJudgePrompt(invocation),
      schema: judgeSchema(invocation),
      schemaName: "judge-output.schema.json",
      outputName: "judge-codex-output.json",
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
    };

    await writeJson(join(invocation.workspace.outputPath, "judge.json"), {
      ...decision,
      requestedSelectedAgentId: response.selectedAgentId,
    });
    return decision;
  }

  private async runCodex<T>(args: {
    invocation: AgentInvocation;
    prompt: string;
    schema: JsonSchema;
    schemaName: string;
    outputName: string;
  }): Promise<T> {
    const schemaPath = join(
      args.invocation.workspace.logsPath,
      args.schemaName,
    );
    const promptPath = join(args.invocation.workspace.logsPath, "prompt.md");
    const outputPath = join(
      args.invocation.workspace.outputPath,
      args.outputName,
    );
    const stdoutPath = join(args.invocation.workspace.logsPath, "codex.stdout");
    const stderrPath = join(args.invocation.workspace.logsPath, "codex.stderr");
    const imagePaths = imageAttachmentPaths(args.invocation);

    await Promise.all([
      writeJson(schemaPath, args.schema),
      writeFile(promptPath, args.prompt, "utf8"),
      writeJson(
        join(args.invocation.workspace.logsPath, "image-attachments.json"),
        imagePaths,
      ),
    ]);

    const cliArgs = [
      "exec",
      ...imagePaths.flatMap((path) => ["--image", path]),
      "--cd",
      args.invocation.workspace.cwd,
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ];

    if (this.options.profile) {
      cliArgs.splice(1, 0, "--profile", this.options.profile);
    }
    if (this.options.model ?? args.invocation.spec.model) {
      cliArgs.splice(
        1,
        0,
        "--model",
        this.options.model ?? (args.invocation.spec.model as string),
      );
    }

    const result = await spawnCodex({
      command: this.command,
      args: cliArgs,
      prompt: args.prompt,
      timeoutMs: this.timeoutMs,
    });
    await Promise.all([
      writeFile(stdoutPath, result.stdout, "utf8"),
      writeFile(stderrPath, result.stderr, "utf8"),
    ]);

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex exited with ${result.exitCode}. Stderr: ${result.stderr.slice(
          -1000,
        )}`,
      );
    }

    const rawOutput = await readFile(outputPath, "utf8");
    return parseJsonOutput(rawOutput) as T;
  }
}

async function spawnCodex(args: {
  command: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex timed out after ${args.timeoutMs}ms.`));
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
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
    child.stdin.end(args.prompt);
  });
}

export function candidateSchema(outputType: OutputNode["type"]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["outputNode", "notes"],
    properties: {
      outputNode: outputNodeSchema(outputType),
      notes: {
        type: ["string", "null"],
      },
    },
  };
}

export function judgeSchema(invocation: JudgeAgentInvocation): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["selectedAgentId", "reasoning"],
    properties: {
      selectedAgentId: {
        type: "string",
        enum: invocation.rankedOutputs.map((output) => output.agentId),
      },
      reasoning: {
        type: "string",
      },
    },
  };
}

function outputNodeSchema(outputType: OutputNode["type"]): JsonSchema {
  if (outputType === "text") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["type", "payload"],
      properties: {
        type: {
          type: "string",
          enum: ["text"],
        },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["type", "text"],
          properties: {
            type: {
              type: "string",
              enum: ["text"],
            },
            text: {
              type: "string",
            },
          },
        },
      },
    };
  }

  if (outputType === "image") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["type", "payload"],
      properties: {
        type: {
          type: "string",
          enum: ["image"],
        },
        payload: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "source",
            "timing",
            "fit",
            "background",
            "cachedVideo",
          ],
          properties: {
            type: {
              type: "string",
              enum: ["image"],
            },
            source: assetRefSchema(),
            timing: nullableSchema(timingSchema()),
            fit: {
              type: ["string", "null"],
              enum: ["contain", "cover", null],
            },
            background: {
              type: ["string", "null"],
            },
            cachedVideo: nullableSchema(assetRefSchema()),
          },
        },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "payload"],
    properties: {
      type: {
        type: "string",
        enum: ["code"],
      },
      payload: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "files",
          "entrypoint",
          "framework",
          "viewport",
          "timing",
          "screenshots",
          "stitchedScreenshot",
          "cachedVideo",
        ],
        properties: {
          type: {
            type: "string",
            enum: ["code"],
          },
          // OpenAI strict structured output rejects a free-form
          // additionalProperties map, so the agent returns files as an array of
          // { path, contents }; normalizeOutputNode folds it back into the
          // Record<string, string> the CodePayload type expects.
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "contents"],
              properties: {
                path: { type: "string" },
                contents: { type: "string" },
              },
            },
          },
          entrypoint: {
            type: "string",
          },
          framework: {
            type: "string",
            enum: ["html", "react"],
          },
          viewport: {
            type: "object",
            additionalProperties: false,
            required: ["width", "height", "deviceScaleFactor"],
            properties: {
              width: {
                type: "number",
              },
              height: {
                type: "number",
              },
              deviceScaleFactor: {
                type: ["number", "null"],
              },
            },
          },
          timing: nullableSchema(timingSchema()),
          screenshots: {
            type: ["array", "null"],
            items: assetRefSchema(),
          },
          stitchedScreenshot: nullableSchema(assetRefSchema()),
          cachedVideo: nullableSchema(assetRefSchema()),
        },
      },
    },
  };
}

function assetRefSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["uri", "mime", "sha256"],
    properties: {
      uri: {
        type: "string",
      },
      mime: {
        type: ["string", "null"],
      },
      sha256: {
        type: ["string", "null"],
      },
    },
  };
}

function timingSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["durationSec", "fps", "startSec", "endSec"],
    properties: {
      durationSec: {
        type: ["number", "null"],
      },
      fps: {
        type: ["number", "null"],
      },
      startSec: {
        type: ["number", "null"],
      },
      endSec: {
        type: ["number", "null"],
      },
    },
  };
}

function nullableSchema(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    type:
      typeof schema.type === "string"
        ? [schema.type, "null"]
        : (schema.type ?? ["object", "null"]),
  };
}

export function imageAttachmentPaths(invocation: AgentInvocation): string[] {
  const refs = assetRefsForImageAttachments(invocation.input.inputNode);

  if (invocation.role === "judge") {
    for (const output of invocation.rankedOutputs) {
      refs.push(...assetRefsForImageAttachments(output.outputNode));
    }
  }

  return Array.from(
    new Set(
      refs
        .map((ref) => localPathFromAssetRef(ref))
        .filter((path): path is string => Boolean(path)),
    ),
  );
}

function assetRefsForImageAttachments(node: Node): AssetRef[] {
  if (node.type === "image") {
    return [node.payload.source, node.payload.cachedVideo].filter(
      (ref): ref is AssetRef => Boolean(ref),
    );
  }

  if (node.type === "code") {
    return [
      node.payload.stitchedScreenshot,
      ...(node.payload.screenshots ?? []),
      node.payload.cachedVideo,
    ].filter((ref): ref is AssetRef => Boolean(ref));
  }

  return [];
}

function localPathFromAssetRef(ref: AssetRef): string | undefined {
  const path = localPathFromUri(ref.uri);
  if (!path || !existsSync(path)) {
    return undefined;
  }
  return path;
}

function localPathFromUri(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  if (isAbsolute(uri)) {
    return uri;
  }
  if (uri.startsWith("./") || uri.startsWith("../")) {
    return resolve(uri);
  }
  return undefined;
}

export function normalizeOutputNode(
  value: unknown,
  outputType: OutputNode["type"],
): OutputNode {
  if (
    !isRecord(value) ||
    value.type !== outputType ||
    !isRecord(value.payload)
  ) {
    throw new Error(`Codex returned an invalid ${outputType} output node.`);
  }
  // The code schema returns files as an array of { path, contents } (strict
  // structured output can't express a free-form map); fold it back into the
  // Record<string, string> the CodePayload type uses.
  if (outputType === "code" && Array.isArray(value.payload.files)) {
    value.payload.files = filesArrayToRecord(value.payload.files);
  }
  return value as OutputNode;
}

function filesArrayToRecord(files: unknown[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const file of files) {
    if (isRecord(file) && typeof file.path === "string") {
      record[file.path] =
        typeof file.contents === "string" ? file.contents : "";
    }
  }
  return record;
}

export function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fencedMatch?.[1]) {
      return JSON.parse(fencedMatch[1]);
    }
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }
    throw new Error(`Codex returned non-JSON output: ${trimmed.slice(0, 500)}`);
  }
}

export function pruneNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneNulls);
  }
  if (!isRecord(value)) {
    return value;
  }

  const pruned: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue !== null) {
      pruned[key] = pruneNulls(nestedValue);
    }
  }
  return pruned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

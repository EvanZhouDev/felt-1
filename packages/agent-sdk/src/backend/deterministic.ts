import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentInvocation,
  AgentResult,
  CandidateAgentInvocation,
  JudgeAgentInvocation,
} from "../types.ts";

export class DeterministicAgentBackend implements AgentBackend {
  async run(invocation: AgentInvocation): Promise<AgentResult> {
    if (invocation.role === "candidate") {
      return {
        role: "candidate",
        output: await runDeterministicCandidate(invocation),
      };
    }

    return {
      role: "judge",
      decision: await runDeterministicJudge(invocation),
    };
  }
}

async function runDeterministicCandidate(invocation: CandidateAgentInvocation) {
  const seedText = invocation.input.seed?.prompt ?? "unseeded";
  const previousText =
    invocation.previous?.type === "selected-output-with-reasoning"
      ? invocation.previous.reasoning
      : (invocation.previous?.type ?? "first-pass");
  const entropy = invocation.entropy ?? invocation.spec.id;
  const text =
    `Candidate ${invocation.spec.id} for ${invocation.output.outputType}. ` +
    `Seed: ${seedText}. Previous: ${previousText}. Entropy: ${entropy}.`;

  const outputNode = buildOutputNode(invocation.output.outputType, text);
  const output = {
    agentId: invocation.spec.id,
    outputNode,
    entropy,
  };

  await writeJson(
    join(invocation.workspace.outputPath, "candidate.json"),
    output,
  );
  return output;
}

async function runDeterministicJudge(invocation: JudgeAgentInvocation) {
  const [selected] = invocation.rankedOutputs;
  if (!selected) {
    throw new Error("Judge received no ranked outputs.");
  }

  const decision = {
    selectedAgentId: selected.agentId,
    selectedNode: selected.outputNode,
    reasoning:
      `Selected ${selected.agentId} with total score ` +
      `${selected.score.total.toFixed(4)} and neural similarity ` +
      `${selected.score.neuralSimilarity.toFixed(4)}.`,
  };

  await writeJson(
    join(invocation.workspace.outputPath, "judge.json"),
    decision,
  );
  return decision;
}

function buildOutputNode(outputType: "text" | "image" | "code", text: string) {
  if (outputType === "image") {
    return {
      type: "image",
      payload: {
        type: "image",
        source: {
          uri: `asset://deterministic/${encodeURIComponent(text)}.png`,
          mime: "image/png",
        },
        timing: {
          durationSec: 0.5,
        },
      },
    } as const;
  }

  if (outputType === "code") {
    return {
      type: "code",
      payload: {
        type: "code",
        files: {
          "index.html": `<main>${escapeHtml(text)}</main>`,
        },
        entrypoint: "index.html",
        framework: "html",
        viewport: {
          width: 1024,
          height: 768,
        },
        timing: {
          durationSec: 0.5,
        },
      },
    } as const;
  }

  return {
    type: "text",
    payload: {
      type: "text",
      text,
    },
  } as const;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

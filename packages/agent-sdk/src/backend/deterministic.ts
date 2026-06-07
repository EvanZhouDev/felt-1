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
  const entropy = invocation.entropy ?? invocation.spec.id;
  const text = buildDeterministicText(invocation, entropy);

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
          uri: `asset://deterministic/${slugify(text)}.png`,
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

function buildDeterministicText(
  invocation: CandidateAgentInvocation,
  entropy: string,
): string {
  const topic = extractSeedTopic(invocation.input.seed?.prompt);
  const targetCue = targetCuePhrase(invocation);
  const operatorCue = operatorCuePhrase(entropy, invocation.spec.id);
  const previousCue = previousCuePhrase(invocation);

  if (topic) {
    return [
      `${articleFor(topic)} ${topic} moves through ${targetCue}`,
      operatorCue,
      previousCue,
    ]
      .filter(Boolean)
      .join(", ")
      .replace(/^./, (char) => char.toUpperCase());
  }

  return [targetCue, operatorCue, previousCue]
    .filter(Boolean)
    .join(", ")
    .replace(/^./, (char) => char.toUpperCase());
}

function extractSeedTopic(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  const patterns = [
    /\babout\s+(?:a|an|the)?\s*([a-z][a-z0-9 -]{1,48}?)(?:\s+while|\s+with|\s+that|[.,;]|$)/i,
    /\btopic(?:\s+is|:)\s+(?:a|an|the)?\s*([a-z][a-z0-9 -]{1,48}?)(?:[.,;]|$)/i,
    /\bsubject(?:\s+is|:)\s+(?:a|an|the)?\s*([a-z][a-z0-9 -]{1,48}?)(?:[.,;]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const topic = match?.[1]?.trim().replace(/\s+/g, " ");
    if (topic) {
      return topic;
    }
  }
  return undefined;
}

function targetCuePhrase(invocation: CandidateAgentInvocation): string {
  const node = invocation.input.inputNode;
  if (node.type === "text") {
    return compactCueText(node.payload.text);
  }
  if (node.type === "image") {
    return "quiet visual attention, close space, muted atmosphere";
  }
  if (node.type === "audio") {
    return "rhythmic pressure, auditory texture, timed energy";
  }
  return "structured visual hierarchy, interface rhythm, focused density";
}

function compactCueText(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
  const unique = [...new Set(words)].slice(0, 7);
  return unique.length > 0 ? unique.join(" ") : "steady perceptual pressure";
}

function operatorCuePhrase(entropy: string, agentId: string): string {
  const lower =
    entropy
      .match(/strategy=([^|]+)/)?.[1]
      ?.trim()
      .toLowerCase() ?? entropy.toLowerCase();
  if (lower.includes("broad")) {
    return "with broad steady attention";
  }
  if (lower.includes("affect")) {
    return "with tight emotional temperature";
  }
  if (lower.includes("sensory")) {
    return "with sparse sensory texture";
  }
  if (lower.includes("spatial")) {
    return "with close spatial focus";
  }
  if (lower.includes("crossover")) {
    return "with combined parent structure";
  }
  if (lower.includes("novelty")) {
    return "with controlled novelty";
  }
  if (lower.includes("ablation")) {
    return "with stripped minimal detail";
  }
  if (lower.includes("representation")) {
    return "with reset syntax and fresh surface";
  }
  return `with ${agentId.replaceAll("-", " ")} steady variation`;
}

function previousCuePhrase(invocation: CandidateAgentInvocation): string {
  const previous = invocation.previous;
  if (!previous || previous.type === "fresh") {
    return "";
  }
  if (
    previous.type === "selected-output" ||
    previous.type === "selected-output-with-reasoning"
  ) {
    const node = previous.node;
    if (node.type === "text") {
      return `after ${compactCueText(node.payload.text)}`;
    }
  }
  return "";
}

function articleFor(topic: string): "a" | "an" {
  return /^[aeiou]/i.test(topic) ? "an" : "a";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 96);
  return slug || "candidate";
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "that",
  "their",
  "there",
  "these",
  "those",
  "through",
  "while",
  "with",
]);

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

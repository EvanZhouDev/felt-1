import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentSpec,
  createAgentWorkspace,
  DeterministicAgentBackend,
  runCandidateAgent,
  runJudgeAgent,
} from "@volta/agent-sdk";
import {
  type EvaluatedOutput,
  type InputObj,
  type NeuralOracle,
  type NextIterationSeed,
  type OutputObj,
  scoreActivations,
} from "@volta/core";
import { renderNode } from "./render.ts";
import type { RunStore } from "./storage.ts";

export type ExecuteRunArgs = {
  id: string;
  input: InputObj;
  output: OutputObj;
  store: RunStore;
  oracle: NeuralOracle;
  runsRoot: string;
  backend?: AgentBackend;
};

const candidateSpecs: Extract<AgentSpec, { role: "candidate" }>[] = [
  {
    role: "candidate",
    id: "candidate-a",
  },
  {
    role: "candidate",
    id: "candidate-b",
  },
];

const judgeSpec: Extract<AgentSpec, { role: "judge" }> = {
  role: "judge",
  id: "judge",
};

export async function executeRun(args: ExecuteRunArgs): Promise<void> {
  const backend = args.backend ?? new DeterministicAgentBackend();

  try {
    const iterationPath = join(args.runsRoot, args.id, "iterations", "001");
    await mkdir(iterationPath, { recursive: true });

    args.store.updateStatus(args.id, "building_events");
    const targetRendered = await renderNode(args.input.inputNode);

    args.store.updateStatus(args.id, "extracting_features");
    const targetActivation = await args.oracle.encode(
      targetRendered.encoderInput,
    );
    await writeJson(join(iterationPath, "target.json"), {
      rendered: targetRendered,
      activation: targetActivation,
    });

    const previous: NextIterationSeed = {
      type: "fresh",
    };
    const candidateOutputs = await Promise.all(
      candidateSpecs.map(async (spec, index) => {
        const workspace = await createAgentWorkspace({
          runsRoot: args.runsRoot,
          runId: args.id,
          iteration: 1,
          agentId: spec.id,
        });

        return runCandidateAgent(backend, {
          role: "candidate",
          runId: args.id,
          iteration: 1,
          spec,
          input: args.input,
          output: args.output,
          previous,
          entropy: `entropy-${index + 1}`,
          workspace,
        });
      }),
    );
    await writeJson(join(iterationPath, "candidates.json"), candidateOutputs);

    args.store.updateStatus(args.id, "scoring");
    const evaluatedOutputs = await Promise.all(
      candidateOutputs.map(async (candidate): Promise<EvaluatedOutput> => {
        const rendered = await renderNode(candidate.outputNode);
        const activation = await args.oracle.encode(rendered.encoderInput);
        const score = scoreActivations({
          target: targetActivation,
          candidate: activation,
          diversity: candidate.entropy ? 0.75 : 0.5,
        });

        return {
          ...candidate,
          rendered,
          activation,
          score,
        };
      }),
    );
    evaluatedOutputs.sort(
      (left, right) => right.score.total - left.score.total,
    );
    await writeJson(join(iterationPath, "scores.json"), evaluatedOutputs);

    args.store.updateStatus(args.id, "judging");
    const judgeWorkspace = await createAgentWorkspace({
      runsRoot: args.runsRoot,
      runId: args.id,
      iteration: 1,
      agentId: judgeSpec.id,
    });
    const decision = await runJudgeAgent(backend, {
      role: "judge",
      runId: args.id,
      iteration: 1,
      spec: judgeSpec,
      input: args.input,
      output: args.output,
      rankedOutputs: evaluatedOutputs,
      workspace: judgeWorkspace,
    });
    const nextIterationSeed = {
      type: "selected-output-with-reasoning",
      node: decision.selectedNode,
      reasoning: decision.reasoning,
    } satisfies NextIterationSeed;
    await writeJson(join(iterationPath, "judge.json"), decision);
    await writeJson(join(iterationPath, "next-seed.json"), nextIterationSeed);

    args.store.complete(
      args.id,
      {
        runId: args.id,
        target: {
          rendered: targetRendered,
          activation: targetActivation,
        },
        candidates: evaluatedOutputs,
        judge: decision,
        nextIterationSeed,
        workspaces: {
          runsRoot: args.runsRoot,
        },
      },
      {
        selectedAgentId: decision.selectedAgentId,
        bestScore: evaluatedOutputs[0]?.score.total,
      },
    );
  } catch (error) {
    args.store.fail(args.id, error);
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

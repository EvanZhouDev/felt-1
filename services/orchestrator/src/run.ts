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
  type ActivationTrace,
  type EvaluatedOutput,
  type InputObj,
  type JudgeDecision,
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
  candidateCount?: number;
  maxIterations?: number;
  candidateModel?: string;
  judgeModel?: string;
};

function buildCandidateSpecs(
  count: number,
  model?: string,
): Extract<AgentSpec, { role: "candidate" }>[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "candidate",
    id: `candidate-${String.fromCharCode(97 + index)}`,
    model,
  }));
}

const judgeSpec: Extract<AgentSpec, { role: "judge" }> = {
  role: "judge",
  id: "judge",
};

export async function executeRun(args: ExecuteRunArgs): Promise<void> {
  const backend = args.backend ?? new DeterministicAgentBackend();
  const candidateSpecs = buildCandidateSpecs(
    args.candidateCount ?? 1,
    args.candidateModel,
  );
  const maxIterations = Math.max(1, args.maxIterations ?? 1);

  try {
    args.store.updateStatus(args.id, "building_events");
    const targetRendered = await renderNode(args.input.inputNode);

    args.store.updateStatus(args.id, "extracting_features");
    const targetActivation = await args.oracle.encode(
      targetRendered.encoderInput,
    );
    await writeJson(join(args.runsRoot, args.id, "target.json"), {
      rendered: targetRendered,
      activation: targetActivation,
    });

    let seed: NextIterationSeed = { type: "fresh" };
    let best: IterationResult | undefined;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const result = await runIteration({
        args,
        backend,
        candidateSpecs,
        targetActivation,
        iteration,
        seed,
      });

      if (!best || (result.bestScore ?? -1) > (best.bestScore ?? -1)) {
        best = result;
      }
      seed = result.nextIterationSeed;
    }

    if (!best) {
      throw new Error("Run produced no iterations.");
    }

    args.store.complete(
      args.id,
      {
        runId: args.id,
        target: {
          rendered: targetRendered,
          activation: targetActivation,
        },
        candidates: best.evaluatedOutputs,
        judge: best.decision,
        nextIterationSeed: best.nextIterationSeed,
        iterations: maxIterations,
        workspaces: {
          runsRoot: args.runsRoot,
        },
      },
      {
        selectedAgentId: best.decision.selectedAgentId,
        bestScore: best.bestScore,
      },
    );
  } catch (error) {
    args.store.fail(args.id, error);
    throw error;
  }
}

type RunIterationArgs = {
  args: ExecuteRunArgs;
  backend: AgentBackend;
  candidateSpecs: Extract<AgentSpec, { role: "candidate" }>[];
  targetActivation: ActivationTrace;
  iteration: number;
  seed: NextIterationSeed;
};

type IterationResult = {
  evaluatedOutputs: EvaluatedOutput[];
  decision: JudgeDecision;
  nextIterationSeed: NextIterationSeed;
  bestScore?: number;
};

async function runIteration({
  args,
  backend,
  candidateSpecs,
  targetActivation,
  iteration,
  seed,
}: RunIterationArgs): Promise<IterationResult> {
  const iterationPath = join(
    args.runsRoot,
    args.id,
    "iterations",
    String(iteration).padStart(3, "0"),
  );
  await mkdir(iterationPath, { recursive: true });

  const candidateOutputs = await Promise.all(
    candidateSpecs.map(async (spec, index) => {
      const workspace = await createAgentWorkspace({
        runsRoot: args.runsRoot,
        runId: args.id,
        iteration,
        agentId: spec.id,
      });

      return runCandidateAgent(backend, {
        role: "candidate",
        runId: args.id,
        iteration,
        spec,
        input: args.input,
        output: args.output,
        previous: seed,
        entropy: `entropy-${iteration}-${index + 1}`,
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
  evaluatedOutputs.sort((left, right) => right.score.total - left.score.total);
  await writeJson(join(iterationPath, "scores.json"), evaluatedOutputs);

  args.store.updateStatus(args.id, "judging");
  const judgeWorkspace = await createAgentWorkspace({
    runsRoot: args.runsRoot,
    runId: args.id,
    iteration,
    agentId: judgeSpec.id,
  });
  const decision = await runJudgeAgent(backend, {
    role: "judge",
    runId: args.id,
    iteration,
    spec: { ...judgeSpec, model: args.judgeModel },
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

  return {
    evaluatedOutputs,
    decision,
    nextIterationSeed,
    bestScore: evaluatedOutputs[0]?.score.total,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

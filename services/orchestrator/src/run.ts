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
  type RenderedStimulus,
  scoreActivations,
} from "@volta/core";
import { type LoopConfig, normalizeLoopConfig } from "./config.ts";
import {
  activationSummary,
  candidateSummary,
  createEvolutionJournal,
  type EvolutionJournal,
  evaluatedOutputSummary,
  iterationSummary,
  renderedSummary,
  runSummary,
  scoreSummary,
  targetSummary,
} from "./observability.ts";
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
  loop?: Partial<LoopConfig>;
  journal?: EvolutionJournal;
  candidateModel?: string;
  judgeModel?: string;
};

export type ResumeRunArgs = Omit<ExecuteRunArgs, "input" | "output">;

const judgeSpec: Extract<AgentSpec, { role: "judge" }> = {
  role: "judge",
  id: "judge",
};

export async function executeRun(args: ExecuteRunArgs): Promise<void> {
  const backend = args.backend ?? new DeterministicAgentBackend();
  const loop = normalizeLoopConfig(args.loop);
  const journal =
    args.journal ??
    createEvolutionJournal({
      enabled: false,
      capturePayloads: false,
    });
  const runPath = join(args.runsRoot, args.id);

  try {
    await journal.trace({
      name: "volta.run",
      input: runSummary({
        runId: args.id,
        input: args.input,
        output: args.output,
        loop,
      }),
      attributes: {
        runId: args.id,
        inputNodeType: args.input.inputNode.type,
        outputType: args.output.outputType,
      },
      run: () =>
        executeRunLoop({
          ...args,
          backend,
          journal,
          loop,
          runPath,
        }),
      output: (result) => ({
        runId: result.runId,
        stopReason: result.stopReason,
        iterationCount: result.iterations.length,
        bestScore: result.bestScore,
        bestNeuralSimilarity: result.bestNeuralSimilarity,
        selectedAgentId: result.judge.selectedAgentId,
        weave: result.weave,
      }),
    });
  } catch (error) {
    args.store.fail(args.id, error);
    throw error;
  }
}

export async function resumeRun(args: ResumeRunArgs): Promise<void> {
  const backend = args.backend ?? new DeterministicAgentBackend();
  const loop = normalizeLoopConfig(args.loop);
  const journal =
    args.journal ??
    createEvolutionJournal({
      enabled: false,
      capturePayloads: false,
    });
  const existing = loadResumeState(args);
  const runPath = existing.runPath;

  try {
    await journal.trace({
      name: "volta.resume",
      input: {
        ...runSummary({
          runId: args.id,
          input: existing.input,
          output: existing.output,
          loop,
        }),
        startIteration: existing.startIteration,
        existingIterationCount: existing.existingIterations.length,
      },
      attributes: {
        runId: args.id,
        inputNodeType: existing.input.inputNode.type,
        outputType: existing.output.outputType,
        startIteration: existing.startIteration,
      },
      run: () =>
        executeRunLoop(
          {
            ...args,
            input: existing.input,
            output: existing.output,
            backend,
            journal,
            loop,
            runPath,
          },
          existing,
        ),
      output: (result) => ({
        runId: result.runId,
        stopReason: result.stopReason,
        iterationCount: result.iterations.length,
        bestScore: result.bestScore,
        bestNeuralSimilarity: result.bestNeuralSimilarity,
        selectedAgentId: result.judge.selectedAgentId,
        weave: result.weave,
      }),
    });
  } catch (error) {
    args.store.fail(args.id, error);
    throw error;
  }
}

type RunLoopArgs = ExecuteRunArgs & {
  backend: AgentBackend;
  journal: EvolutionJournal;
  loop: LoopConfig;
  runPath: string;
};

type IterationResult = {
  iteration: number;
  previous: NextIterationSeed;
  candidateOutputs: Awaited<ReturnType<typeof runCandidateAgent>>[];
  rankedOutputs: EvaluatedOutput[];
  judge: Awaited<ReturnType<typeof runJudgeAgent>>;
  nextIterationSeed: NextIterationSeed;
  stopReason?: StopReason;
};

type StopReason = "threshold" | "max_iterations";

type RunLoopResult = {
  runId: string;
  stopReason: StopReason;
  target: {
    rendered: RenderedStimulus;
    activation: Awaited<ReturnType<NeuralOracle["encode"]>>;
  };
  iterations: IterationResult[];
  candidates: EvaluatedOutput[];
  judge: Awaited<ReturnType<typeof runJudgeAgent>>;
  nextIterationSeed: NextIterationSeed;
  bestScore: number | undefined;
  bestNeuralSimilarity: number | undefined;
  workspaces: {
    runsRoot: string;
  };
  weave?: {
    dashboardUrl?: string;
  };
};

type ResumeState = {
  input: InputObj;
  output: OutputObj;
  runPath: string;
  target: RunLoopResult["target"];
  previous: NextIterationSeed;
  existingIterations: IterationResult[];
  startIteration: number;
};

async function executeRunLoop(
  args: RunLoopArgs,
  resume?: ResumeState,
): Promise<RunLoopResult> {
  const target = resume?.target ?? (await buildTarget(args));

  let previous: NextIterationSeed = resume?.previous ?? {
    type: "fresh",
  };
  const iterations: IterationResult[] = [...(resume?.existingIterations ?? [])];
  const candidateSpecs = buildCandidateSpecs(
    args.loop.candidateCount,
    args.candidateModel,
  );
  const startIteration = resume?.startIteration ?? 1;

  for (let completed = 0; completed < args.loop.maxIterations; completed += 1) {
    const iteration = startIteration + completed;
    const iterationResult = await executeIteration({
      ...args,
      iteration,
      candidateSpecs,
      previous,
      target,
    });
    const best = iterationResult.rankedOutputs[0];
    const stopReason = getStopReason({
      bestNeuralSimilarity: best?.score.neuralSimilarity,
      iterationsCompleted: completed + 1,
      loop: args.loop,
    });
    iterationResult.stopReason = stopReason;
    await writeJson(
      join(
        args.runPath,
        "iterations",
        iterationId(iteration),
        "iteration.json",
      ),
      iterationSummary({
        iteration,
        previous,
        rankedOutputs: iterationResult.rankedOutputs,
        judge: iterationResult.judge,
        nextSeed: iterationResult.nextIterationSeed,
        stopReason,
      }),
    );

    iterations.push(iterationResult);
    previous = iterationResult.nextIterationSeed;

    if (stopReason) {
      break;
    }
  }

  const finalIteration = iterations.at(-1);
  if (!finalIteration) {
    throw new Error("Run loop produced no iterations.");
  }

  const bestOverall = bestOverallOutput(iterations);
  const result: RunLoopResult = {
    runId: args.id,
    stopReason: finalIteration.stopReason ?? "max_iterations",
    target,
    iterations,
    candidates: finalIteration.rankedOutputs,
    judge: finalIteration.judge,
    nextIterationSeed: finalIteration.nextIterationSeed,
    bestScore: bestOverall?.score.total,
    bestNeuralSimilarity: bestOverall?.score.neuralSimilarity,
    workspaces: {
      runsRoot: args.runsRoot,
    },
    weave: args.journal.dashboardUrl
      ? {
          dashboardUrl: args.journal.dashboardUrl,
        }
      : undefined,
  };

  await writeJson(join(args.runPath, "evolution-journal.json"), {
    runId: args.id,
    target: targetSummary(target),
    loop: args.loop,
    stopReason: result.stopReason,
    bestScore: result.bestScore,
    bestNeuralSimilarity: result.bestNeuralSimilarity,
    iterations: iterations.map((iteration) =>
      iterationSummary({
        iteration: iteration.iteration,
        previous: iteration.previous,
        rankedOutputs: iteration.rankedOutputs,
        judge: iteration.judge,
        nextSeed: iteration.nextIterationSeed,
        stopReason: iteration.stopReason,
      }),
    ),
  });

  args.store.complete(args.id, result, {
    selectedAgentId: finalIteration.judge.selectedAgentId,
    bestScore: result.bestScore,
  });

  return result;
}

async function buildTarget(
  args: RunLoopArgs,
): Promise<RunLoopResult["target"]> {
  args.store.updateStatus(args.id, "building_events");
  const targetRendered = await args.journal.trace({
    name: "target.render",
    input: {
      runId: args.id,
      inputNodeType: args.input.inputNode.type,
    },
    run: () => renderNode(args.input.inputNode),
    output: renderedSummary,
  });

  args.store.updateStatus(args.id, "extracting_features");
  const targetActivation = await args.journal.trace({
    name: "target.encode",
    input: {
      runId: args.id,
      rendered: renderedSummary(targetRendered),
    },
    run: () => args.oracle.encode(targetRendered.encoderInput),
    output: activationSummary,
  });
  const target = {
    rendered: targetRendered,
    activation: targetActivation,
  };
  await writeJson(join(args.runPath, "target.json"), target);
  return target;
}

async function executeIteration(
  args: RunLoopArgs & {
    iteration: number;
    candidateSpecs: Extract<AgentSpec, { role: "candidate" }>[];
    previous: NextIterationSeed;
    target: RunLoopResult["target"];
  },
): Promise<IterationResult> {
  const iterationPath = join(
    args.runPath,
    "iterations",
    iterationId(args.iteration),
  );
  await mkdir(iterationPath, { recursive: true });
  await writeJson(join(iterationPath, "target.json"), args.target);

  args.store.updateStatus(args.id, "predicting");
  const candidateOutputs = await Promise.all(
    args.candidateSpecs.map(async (spec, index) => {
      const workspace = await createAgentWorkspace({
        runsRoot: args.runsRoot,
        runId: args.id,
        iteration: args.iteration,
        agentId: spec.id,
      });

      return args.journal.trace({
        name: "candidate.generate",
        input: {
          runId: args.id,
          iteration: args.iteration,
          agentId: spec.id,
          previousType: args.previous.type,
          outputType: args.output.outputType,
          entropy: `entropy-${args.iteration}-${index + 1}`,
        },
        attributes: {
          runId: args.id,
          iteration: args.iteration,
          agentId: spec.id,
        },
        run: () =>
          runCandidateAgent(args.backend, {
            role: "candidate",
            runId: args.id,
            iteration: args.iteration,
            spec,
            input: args.input,
            output: args.output,
            previous: args.previous,
            entropy: `entropy-${args.iteration}-${index + 1}`,
            workspace,
          }),
        output: candidateSummary,
      });
    }),
  );
  await writeJson(join(iterationPath, "candidates.json"), candidateOutputs);

  args.store.updateStatus(args.id, "scoring");
  const evaluatedOutputs = await Promise.all(
    candidateOutputs.map((candidate) =>
      evaluateCandidate({
        ...args,
        candidate,
        targetActivation: args.target.activation,
      }),
    ),
  );
  evaluatedOutputs.sort((left, right) => right.score.total - left.score.total);
  await writeJson(join(iterationPath, "scores.json"), evaluatedOutputs);

  args.store.updateStatus(args.id, "judging");
  const judgeWorkspace = await createAgentWorkspace({
    runsRoot: args.runsRoot,
    runId: args.id,
    iteration: args.iteration,
    agentId: judgeSpec.id,
  });
  const judge = await args.journal.trace({
    name: "judge.select",
    input: {
      runId: args.id,
      iteration: args.iteration,
      rankings: evaluatedOutputs.map(evaluatedOutputSummary),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: judgeSpec.id,
    },
    run: () =>
      runJudgeAgent(args.backend, {
        role: "judge",
        runId: args.id,
        iteration: args.iteration,
        spec: { ...judgeSpec, model: args.judgeModel },
        input: args.input,
        output: args.output,
        rankedOutputs: evaluatedOutputs,
        workspace: judgeWorkspace,
      }),
    output: (decision) => decision,
  });
  const nextIterationSeed = {
    type: "selected-output-with-reasoning",
    node: judge.selectedNode,
    reasoning: judge.reasoning,
  } satisfies NextIterationSeed;
  await writeJson(join(iterationPath, "judge.json"), judge);
  await writeJson(join(iterationPath, "next-seed.json"), nextIterationSeed);

  return {
    iteration: args.iteration,
    previous: args.previous,
    candidateOutputs,
    rankedOutputs: evaluatedOutputs,
    judge,
    nextIterationSeed,
  };
}

async function evaluateCandidate(
  args: RunLoopArgs & {
    iteration: number;
    candidate: Awaited<ReturnType<typeof runCandidateAgent>>;
    targetActivation: RunLoopResult["target"]["activation"];
  },
): Promise<EvaluatedOutput> {
  const rendered = await args.journal.trace({
    name: "candidate.render",
    input: {
      runId: args.id,
      iteration: args.iteration,
      candidate: candidateSummary(args.candidate),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
    },
    run: () => renderNode(args.candidate.outputNode),
    output: renderedSummary,
  });
  const activation = await args.journal.trace({
    name: "candidate.encode",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
      rendered: renderedSummary(rendered),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
    },
    run: () => args.oracle.encode(rendered.encoderInput),
    output: activationSummary,
  });
  const score = await args.journal.trace({
    name: "candidate.score",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
      targetActivation: activationSummary(args.targetActivation),
      candidateActivation: activationSummary(activation),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
    },
    run: async () =>
      scoreActivations({
        target: args.targetActivation,
        candidate: activation,
        diversity: args.candidate.entropy ? 0.75 : 0.5,
      }),
    output: scoreSummary,
  });

  return {
    ...args.candidate,
    rendered,
    activation,
    score,
  };
}

function buildCandidateSpecs(
  count: number,
  model?: string,
): Extract<AgentSpec, { role: "candidate" }>[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "candidate",
    id: `candidate-${candidateSuffix(index)}`,
    model,
  }));
}

function candidateSuffix(index: number): string {
  const code = "a".charCodeAt(0) + index;
  if (code <= "z".charCodeAt(0)) {
    return String.fromCharCode(code);
  }
  return String(index + 1);
}

function getStopReason(args: {
  bestNeuralSimilarity: number | undefined;
  iterationsCompleted: number;
  loop: LoopConfig;
}): StopReason | undefined {
  if (
    typeof args.bestNeuralSimilarity === "number" &&
    args.bestNeuralSimilarity >= args.loop.similarityThreshold
  ) {
    return "threshold";
  }
  if (args.iterationsCompleted >= args.loop.maxIterations) {
    return "max_iterations";
  }
  return undefined;
}

function loadResumeState(args: ResumeRunArgs): ResumeState {
  const record = args.store.get(args.id);
  if (!record) {
    throw new Error(`Run ${args.id} does not exist.`);
  }
  const artifact = args.store.getArtifact(args.id);
  if (!artifact?.result) {
    throw new Error(`Run ${args.id} has no completed result to resume from.`);
  }
  const result = artifact.result as Partial<RunLoopResult>;
  if (!result.target || !Array.isArray(result.iterations)) {
    throw new Error(
      `Run ${args.id} was not produced by the resumable run loop.`,
    );
  }

  const existingIterations = result.iterations as IterationResult[];
  const lastIteration = existingIterations.at(-1);
  const previous = result.nextIterationSeed ?? lastIteration?.nextIterationSeed;
  if (!lastIteration || !previous) {
    throw new Error(`Run ${args.id} has no next iteration seed.`);
  }

  return {
    input: artifact.input,
    output: artifact.output,
    runPath: record.runPath || join(args.runsRoot, args.id),
    target: result.target,
    previous,
    existingIterations,
    startIteration:
      Math.max(...existingIterations.map((iteration) => iteration.iteration)) +
      1,
  };
}

function bestOverallOutput(
  iterations: IterationResult[],
): EvaluatedOutput | undefined {
  return iterations
    .flatMap((iteration) => iteration.rankedOutputs)
    .sort((left, right) => right.score.total - left.score.total)[0];
}

function iterationId(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

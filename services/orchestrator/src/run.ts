import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  appendCandidateArchive,
  appendTargetCandidateArchive,
  archivePromptContext,
  type CandidateArchive,
  loadCandidateArchive,
  loadTargetCandidateArchive,
  mergeCandidateArchives,
  operatorStats,
} from "./archive.ts";
import { loadCalibrationActivations } from "./calibration.ts";
import { type LoopConfig, normalizeLoopConfig } from "./config.ts";
import { materializeGeneratedImageCandidate } from "./generated-images.ts";
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
  fluxUrl?: string;
};

export type ResumeRunArgs = Omit<ExecuteRunArgs, "input" | "output">;

const judgeSpec: Extract<AgentSpec, { role: "judge" }> = {
  role: "judge",
  id: "judge",
};
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
        bestAdjustedSimilarity: result.bestAdjustedSimilarity,
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
        bestAdjustedSimilarity: result.bestAdjustedSimilarity,
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
  candidateOutputs: CandidateOutput[];
  rankedOutputs: EvaluatedOutput[];
  judge: Awaited<ReturnType<typeof runJudgeAgent>>;
  nextIterationSeed: NextIterationSeed;
  stopReason?: StopReason;
};

type CandidateOutput = Awaited<ReturnType<typeof runCandidateAgent>>;

type StopReason = "threshold" | "max_iterations";

const DEFAULT_IMAGE_TEXT_MICRO_MUTATIONS = 4;

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
  bestAdjustedSimilarity: number | undefined;
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
    const iterationPath = join(
      args.runPath,
      "iterations",
      iterationId(iteration),
    );
    const iterationResult = await executeIteration({
      ...args,
      iteration,
      candidateSpecs,
      previous,
      target,
    });
    const bestBefore = bestOverallOutput(iterations);
    const best = iterationResult.rankedOutputs[0];
    const bestAfter = bestOutput(bestBefore, best);
    if (shouldPreserveElite(bestBefore, best)) {
      iterationResult.nextIterationSeed = seedFromElite({
        elite: bestBefore,
        currentBest: best,
      });
      await writeJson(
        join(iterationPath, "next-seed.json"),
        iterationResult.nextIterationSeed,
      );
    }
    const stopReason = getStopReason({
      bestAdjustedSimilarity: bestAfter
        ? outputSelectionSimilarity(bestAfter)
        : undefined,
      iterationsCompleted: completed + 1,
      loop: args.loop,
    });
    iterationResult.stopReason = stopReason;
    await writeJson(
      join(iterationPath, "iteration.json"),
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

  const bestIteration = bestOverallIteration(iterations);
  const bestOverall = bestIteration?.rankedOutputs[0];
  const finalJudge = bestOverall
    ? judgeFromGlobalBest({
        best: bestOverall,
        bestIteration: bestIteration.iteration,
        finalJudge: finalIteration.judge,
      })
    : finalIteration.judge;
  const result: RunLoopResult = {
    runId: args.id,
    stopReason: finalIteration.stopReason ?? "max_iterations",
    target,
    iterations,
    candidates: bestIteration?.rankedOutputs ?? finalIteration.rankedOutputs,
    judge: finalJudge,
    nextIterationSeed: finalIteration.nextIterationSeed,
    bestScore: bestOverall?.score.total,
    bestNeuralSimilarity: bestOverall?.score.neuralSimilarity,
    bestAdjustedSimilarity: bestOverall?.score.adjustedSimilarity,
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
    effectiveLoop: {
      textMicroMutations: effectiveTextMicroMutationCount({
        configured: args.loop.textMicroMutations,
        inputType: args.input.inputNode.type,
        outputType: args.output.outputType,
      }),
    },
    stopReason: result.stopReason,
    bestScore: result.bestScore,
    bestNeuralSimilarity: result.bestNeuralSimilarity,
    bestAdjustedSimilarity: result.bestAdjustedSimilarity,
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
    selectedAgentId: finalJudge.selectedAgentId,
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
  const cachedTarget = await loadCachedTarget(args, targetRendered);
  if (cachedTarget) {
    await writeJson(join(args.runPath, "target.json"), cachedTarget);
    return cachedTarget;
  }

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
  await writeCachedTarget(args, target);
  return target;
}

async function loadCachedTarget(
  args: RunLoopArgs,
  rendered: RenderedStimulus,
): Promise<RunLoopResult["target"] | undefined> {
  const cached = readOptionalJson<RunLoopResult["target"]>(
    targetCachePath(args, rendered),
  );
  if (!cached?.activation) {
    return undefined;
  }
  if (args.oracle.model && cached.activation.model !== args.oracle.model) {
    return undefined;
  }
  return {
    rendered,
    activation: cached.activation,
  };
}

async function writeCachedTarget(
  args: RunLoopArgs,
  target: RunLoopResult["target"],
): Promise<void> {
  const path = targetCachePath(args, target.rendered);
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, target);
}

function targetCachePath(
  args: RunLoopArgs,
  rendered: RenderedStimulus,
): string {
  return join(
    args.runsRoot,
    "..",
    "target-cache",
    `${oracleCacheKey(args.oracle)}-${rendered.sha256}.json`,
  );
}

function oracleCacheKey(oracle: NeuralOracle): string {
  return (oracle.model ?? "unknown-oracle").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
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
  const probeElites = await seedTextProbeArchive({
    ...args,
    target: args.target,
  });
  const archive = mergeCandidateArchives(
    ...(args.loop.reuseTargetArchive
      ? [loadTargetCandidateArchive(args.runsRoot, args.target.rendered.sha256)]
      : []),
    loadCandidateArchive(args.runPath),
  );
  const archiveContext = archivePromptContext(archive);

  args.store.updateStatus(args.id, "predicting");
  const agentCandidateOutputs = await Promise.all(
    args.candidateSpecs.map(async (spec, index) => {
      const entropy = mutationStrategy({
        iteration: args.iteration,
        index,
        candidateCount: args.loop.candidateCount,
        inputType: args.input.inputNode.type,
        outputType: args.output.outputType,
        archive,
      });
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
          entropy,
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
            entropy,
            archive: archiveContext,
            workspace,
          }),
        output: candidateSummary,
      });
    }),
  );
  const generatedCandidateOutputs = [
    ...eliteReplayCandidateOutputs({
      previous: args.previous,
      iteration: args.iteration,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
    ...agentCandidateOutputs,
  ];
  await writeJson(
    join(iterationPath, "generated-candidates.json"),
    generatedCandidateOutputs,
  );

  args.store.updateStatus(args.id, "scoring");
  await mkdir(join(iterationPath, "scores"), { recursive: true });
  const scoreCandidateOutputs = async (
    candidates: CandidateOutput[],
  ): Promise<EvaluatedOutput[]> => {
    const evaluated = await mapWithConcurrency(
      candidates,
      args.loop.scoringConcurrency,
      async (candidate): Promise<EvaluatedOutput | undefined> => {
        try {
          const evaluated = await evaluateCandidate({
            ...args,
            candidate,
            target: args.target,
          });
          await writeJson(
            join(iterationPath, "scores", `${candidate.agentId}.json`),
            evaluated,
          );
          return evaluated;
        } catch (error) {
          await writeJson(
            join(iterationPath, "scores", `${candidate.agentId}.error.json`),
            {
              agentId: candidate.agentId,
              entropy: candidate.entropy,
              outputNode: candidate.outputNode,
              error: serializeError(error),
            },
          );
          return undefined;
        }
      },
    );
    return evaluated.filter(
      (output): output is EvaluatedOutput => output !== undefined,
    );
  };
  const evaluatedBaseOutputs = await scoreCandidateOutputs(
    generatedCandidateOutputs,
  );
  const microParentCandidates = selectMicroMutationParents({
    evaluatedOutputs: evaluatedBaseOutputs,
    candidateOutputs: generatedCandidateOutputs,
    inputType: args.input.inputNode.type,
    outputType: args.output.outputType,
    imageSeedMutations: effectiveImageSeedMutationCount({
      configured: args.loop.imageSeedMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
    imageLocalMutations: effectiveImageLocalMutationCount({
      configured: args.loop.imageLocalMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
    textMicroMutations: effectiveTextMicroMutationCount({
      configured: args.loop.textMicroMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
  });
  const microCandidateOutputs = microMutationCandidateOutputs({
    candidates: microParentCandidates,
    inputType: args.input.inputNode.type,
    outputType: args.output.outputType,
    imageSeedMutations: effectiveImageSeedMutationCount({
      configured: args.loop.imageSeedMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
    imageLocalMutations: effectiveImageLocalMutationCount({
      configured: args.loop.imageLocalMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
    textMicroMutations: effectiveTextMicroMutationCount({
      configured: args.loop.textMicroMutations,
      inputType: args.input.inputNode.type,
      outputType: args.output.outputType,
    }),
  });
  const candidateOutputs = [
    ...generatedCandidateOutputs,
    ...microCandidateOutputs,
  ];
  await writeJson(join(iterationPath, "candidates.json"), candidateOutputs);
  const evaluatedMicroOutputs = await scoreCandidateOutputs(
    microCandidateOutputs,
  );
  const evaluatedCandidateOutputs = [
    ...evaluatedBaseOutputs,
    ...evaluatedMicroOutputs,
  ];
  const evaluatedOutputs = [...probeElites, ...evaluatedCandidateOutputs];
  if (evaluatedOutputs.length === 0) {
    throw new Error(
      `Iteration ${args.iteration} has no successfully evaluated candidates.`,
    );
  }
  evaluatedOutputs.sort((left, right) => right.score.total - left.score.total);
  await writeJson(join(iterationPath, "scores.json"), evaluatedOutputs);
  await appendCandidateArchive({
    runPath: args.runPath,
    iteration: args.iteration,
    rankedOutputs: evaluatedOutputs,
    runId: args.id,
  });
  await appendTargetCandidateArchive({
    runsRoot: args.runsRoot,
    targetSha: args.target.rendered.sha256,
    iteration: args.iteration,
    rankedOutputs: evaluatedOutputs,
    runId: args.id,
  });

  args.store.updateStatus(args.id, "judging");
  const judgeWorkspace = await createAgentWorkspace({
    runsRoot: args.runsRoot,
    runId: args.id,
    iteration: args.iteration,
    agentId: judgeSpec.id,
  });
  const proposedJudge = await args.journal.trace({
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
  const judge = enforceRankedJudgeDecision({
    judge: proposedJudge,
    rankedOutputs: evaluatedOutputs,
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
    candidate: CandidateOutput;
    target: RunLoopResult["target"];
  },
): Promise<EvaluatedOutput> {
  const candidate = await materializeGeneratedImageCandidate({
    candidate: args.candidate,
    runPath: args.runPath,
    fluxUrl: args.fluxUrl,
    targetRendered: args.target.rendered,
    inheritTargetStyle:
      args.input.inputNode.type === "image" &&
      args.output.outputType === "image",
  });
  const rendered = await args.journal.trace({
    name: "candidate.render",
    input: {
      runId: args.id,
      iteration: args.iteration,
      candidate: candidateSummary(candidate),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
    },
    run: () => renderNode(candidate.outputNode),
    output: renderedSummary,
  });
  const activation = await args.journal.trace({
    name: "candidate.encode",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
      rendered: renderedSummary(rendered),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
    },
    run: () => args.oracle.encode(rendered.encoderInput),
    output: activationSummary,
  });
  const activationWithDiagnostics = attachActivationDiagnostics({
    candidate: activation,
    target: args.target.activation,
  });
  const scoringPriors = candidateScoringPriors({
    candidate,
    inputType: args.input.inputNode.type,
    outputType: args.output.outputType,
  });
  const score = await args.journal.trace({
    name: "candidate.score",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
      targetActivation: activationSummary(args.target.activation),
      candidateActivation: activationSummary(activationWithDiagnostics),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
    },
    run: async () =>
      scoreActivations({
        target: args.target.activation,
        candidate: activationWithDiagnostics,
        contrastTargets: loadContrastTargets(args),
        coherence: scoringPriors.coherence,
        diversity:
          scoringPriors.diversity ?? (args.candidate.entropy ? 0.75 : 0.5),
        penalty: scoringPriors.penalty,
        useResidualAdjustedSimilarity:
          args.input.inputNode.type === args.output.outputType,
        useRawAdjustedSimilarity:
          args.input.inputNode.type !== args.output.outputType,
      }),
    output: scoreSummary,
  });

  return {
    ...candidate,
    rendered,
    activation: activationWithDiagnostics,
    score,
  };
}

async function seedTextProbeArchive(
  args: RunLoopArgs & {
    iteration: number;
    target: RunLoopResult["target"];
  },
): Promise<EvaluatedOutput[]> {
  if (
    args.iteration !== 1 ||
    args.output.outputType !== "text" ||
    args.loop.textProbeCount <= 0
  ) {
    return [];
  }

  const existingArchive = loadCandidateArchive(args.runPath);
  if (
    existingArchive.entries.some((entry) =>
      entry.entropy?.includes("strategy=text-probe-calibration"),
    )
  ) {
    return [];
  }

  const probes = TEXT_PROBE_LIBRARY.slice(0, args.loop.textProbeCount);
  if (probes.length === 0) {
    return [];
  }

  const probePath = join(args.runPath, "text-probes");
  await mkdir(probePath, { recursive: true });
  const baseProbes = await scoreTextProbeCandidates({
    ...args,
    probePath,
    probes,
    idPrefix: "probe",
    strategy: "text-probe-calibration",
  });
  baseProbes.sort(
    (left, right) => outputSelectionScore(right) - outputSelectionScore(left),
  );
  const localMutationProbes = await scoreTextProbeCandidates({
    ...args,
    probePath,
    probes: textProbeLocalMutations(
      baseProbes,
      args.loop.textProbeLocalMutations,
    ),
    idPrefix: "probe-l",
    strategy: "text-probe-local-mutation",
  });
  const recombinationProbes = await scoreTextProbeCandidates({
    ...args,
    probePath,
    probes: textProbeRecombinations(
      [...baseProbes, ...localMutationProbes].sort(
        (left, right) =>
          outputSelectionScore(right) - outputSelectionScore(left),
      ),
      args.loop.textProbeRecombinations,
    ),
    idPrefix: "probe-r",
    strategy: "text-probe-recombination",
  });
  const evaluatedProbes = [
    ...baseProbes,
    ...localMutationProbes,
    ...recombinationProbes,
  ];
  evaluatedProbes.sort(
    (left, right) => outputSelectionScore(right) - outputSelectionScore(left),
  );
  await writeJson(
    join(args.runPath, "text-probes.json"),
    evaluatedProbes.map(evaluatedOutputSummary),
  );
  await appendCandidateArchive({
    runPath: args.runPath,
    iteration: 0,
    rankedOutputs: evaluatedProbes,
    runId: args.id,
  });
  return evaluatedProbes.slice(0, probeEliteCount(args.loop));
}

async function scoreTextProbeCandidates(
  args: RunLoopArgs & {
    target: RunLoopResult["target"];
    probePath: string;
    probes: string[];
    idPrefix: string;
    strategy: string;
  },
): Promise<EvaluatedOutput[]> {
  return mapWithConcurrency(
    args.probes,
    args.loop.scoringConcurrency,
    async (text, index) => {
      const candidate: CandidateOutput = {
        agentId: `${args.idPrefix}-${String(index + 1).padStart(2, "0")}`,
        entropy:
          `iteration=0 | strategy=${args.strategy} | outputType=text | ` +
          "Score a text probe against the target to build a fresh per-run activation basis.",
        outputNode: {
          type: "text",
          payload: {
            type: "text",
            text,
          },
        },
      };
      const evaluated = await evaluateCandidate({
        ...args,
        iteration: 0,
        candidate,
        target: args.target,
      });
      await writeJson(
        join(args.probePath, `${candidate.agentId}.json`),
        evaluatedOutputSummary(evaluated),
      );
      return evaluated;
    },
  );
}

function enforceRankedJudgeDecision(args: {
  judge: Awaited<ReturnType<typeof runJudgeAgent>>;
  rankedOutputs: EvaluatedOutput[];
}): Awaited<ReturnType<typeof runJudgeAgent>> {
  const top = args.rankedOutputs[0];
  if (!top || args.judge.selectedAgentId === top.agentId) {
    return args.judge;
  }

  return {
    selectedAgentId: top.agentId,
    selectedNode: top.outputNode,
    reasoning: [
      args.judge.reasoning,
      `Objective guard: selected ${top.agentId} because it is ranked first by score.total=${top.score.total} and adjustedSimilarity=${top.score.adjustedSimilarity}.`,
    ].join("\n\n"),
  };
}

function loadContrastTargets(
  args: RunLoopArgs & {
    target: RunLoopResult["target"];
  },
): RunLoopResult["target"]["activation"][] {
  return loadCalibrationActivations({
    repoRoot: REPO_ROOT,
    runsRoot: args.runsRoot,
    targetActivation: args.target.activation,
    targetSha: args.target.rendered.sha256,
    targetKind: args.target.rendered.kind,
    additionalRenderedKinds:
      args.output.outputType === "text" &&
      args.input.inputNode.type !== args.output.outputType
        ? ["text"]
        : [],
    explicitTargetRoots: args.loop.contrastTargetRoots,
    maxActivations: 96,
    includeScoreActivations:
      args.input.inputNode.type === args.output.outputType,
  });
}

function candidateScoringPriors(args: {
  candidate: CandidateOutput;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): {
  coherence?: number;
  diversity?: number;
  penalty?: number;
} {
  if (args.candidate.outputNode.type !== "text") {
    return {};
  }

  const text = args.candidate.outputNode.payload.text;
  if (args.inputType === "image" && args.outputType === "text") {
    return naturalCaptionScoringPriors(text);
  }

  const wordCount = textWords(text).length;
  const slotCount = textSlots(text).length;
  const wordPenalty = wordCount < 6 ? (6 - wordCount) * 0.05 : 0;
  const slotPenalty = slotCount < 3 ? (3 - slotCount) * 0.1 : 0;
  const penalty = Math.min(0.3, wordPenalty + slotPenalty);

  return {
    coherence: textStructureScore({ wordCount, slotCount }),
    penalty,
  };
}

function naturalCaptionScoringPriors(text: string): {
  coherence: number;
  penalty?: number;
} {
  const wordCount = textWords(text).length;
  const sentenceCount = captionSentenceCount(text);
  const commaCount = (text.match(/,/g) ?? []).length;
  const wordPenalty =
    wordCount < 6
      ? (6 - wordCount) * 0.04
      : wordCount > 24
        ? (wordCount - 24) * 0.03
        : 0;
  const sentencePenalty =
    sentenceCount === 0 ? 0.04 : sentenceCount > 2 ? 0.06 : 0;
  const inventoryPenalty =
    commaCount >= 4 ? Math.min(0.12, commaCount * 0.02) : 0;
  const verbPenalty = hasCaptionVerb(text) ? 0 : 0.08;
  const grammarPenalty = hasMalformedCaptionEnding(text) ? 0.15 : 0;
  const penalty = Math.min(
    0.25,
    wordPenalty +
      sentencePenalty +
      inventoryPenalty +
      verbPenalty +
      grammarPenalty,
  );

  return {
    coherence:
      rangeScore(wordCount, {
        floor: 4,
        targetMin: 8,
        targetMax: 20,
        ceiling: 30,
      }) *
        0.75 +
      rangeScore(sentenceCount, {
        floor: 0,
        targetMin: 1,
        targetMax: 1,
        ceiling: 3,
      }) *
        0.25,
    penalty: penalty > 0 ? penalty : undefined,
  };
}

function captionSentenceCount(text: string): number {
  const terminalCount = (text.match(/[.!?]+/g) ?? []).length;
  return terminalCount > 0 ? terminalCount : text.trim().length > 0 ? 1 : 0;
}

function hasMalformedCaptionEnding(text: string): boolean {
  return /\b(in|with|at|on|toward|towards|of|for|to)\s*[.!?]?$/i.test(
    text.trim(),
  );
}

function hasCaptionVerb(text: string): boolean {
  return /\b(sits?|stands?|lies?|looks?|faces?|opens?|shines?|rests?|holds?|wears?|shows?|fills?|hangs?|leans?|gazes?|smiles?|is|are)\b/i.test(
    text,
  );
}

function textStructureScore(args: {
  wordCount: number;
  slotCount: number;
}): number {
  return (
    rangeScore(args.wordCount, {
      floor: 4,
      targetMin: 8,
      targetMax: 18,
      ceiling: 28,
    }) *
      0.55 +
    rangeScore(args.slotCount, {
      floor: 2,
      targetMin: 4,
      targetMax: 8,
      ceiling: 10,
    }) *
      0.45
  );
}

function rangeScore(
  value: number,
  bounds: {
    floor: number;
    targetMin: number;
    targetMax: number;
    ceiling: number;
  },
): number {
  if (value >= bounds.targetMin && value <= bounds.targetMax) {
    return 1;
  }
  if (value < bounds.targetMin) {
    return Math.max(
      0,
      (value - bounds.floor) / (bounds.targetMin - bounds.floor),
    );
  }
  return Math.max(
    0,
    (bounds.ceiling - value) / (bounds.ceiling - bounds.targetMax),
  );
}

function probeEliteCount(loop: LoopConfig): number {
  if (loop.textProbeCount <= 0) {
    return 0;
  }
  return Math.min(2, Math.max(1, Math.floor(loop.candidateCount / 2)));
}

function textProbeRecombinations(
  evaluatedProbes: EvaluatedOutput[],
  maxCount: number,
): string[] {
  if (maxCount <= 0 || evaluatedProbes.length < 2) {
    return [];
  }

  const rankedProbeSlots = evaluatedProbes
    .slice(0, 3)
    .flatMap((probe) =>
      probe.outputNode.type === "text"
        ? textSlots(probe.outputNode.payload.text)
        : [],
    );
  const orderedSlots = uniqueSlots(rankedProbeSlots).sort(
    (left, right) => slotPriority(left) - slotPriority(right),
  );
  const variants: TextMicroVariant[] = [
    {
      name: "probe-priority-blend",
      text: orderedSlots.slice(0, 4).join(", "),
    },
    {
      name: "probe-attention-affect-blend",
      text: selectProbeSlots(orderedSlots, [0, 1, 6, 7, 5]).join(", "),
    },
    {
      name: "probe-surface-space-blend",
      text: selectProbeSlots(orderedSlots, [0, 2, 5, 6, 7]).join(", "),
    },
    {
      name: "probe-wide-blend",
      text: orderedSlots.slice(0, 6).join(", "),
    },
  ].filter((variant) => variant.text.length > 0);

  const originals = evaluatedProbes
    .flatMap((probe) =>
      probe.outputNode.type === "text" ? [probe.outputNode.payload.text] : [],
    )
    .join("\n");
  return uniqueTextVariants(variants, originals)
    .map((variant) => variant.text)
    .slice(0, maxCount);
}

function textProbeLocalMutations(
  evaluatedProbes: EvaluatedOutput[],
  maxCount: number,
): string[] {
  if (maxCount <= 0 || evaluatedProbes.length === 0) {
    return [];
  }
  const topProbe = evaluatedProbes[0];
  if (topProbe?.outputNode.type !== "text") {
    return [];
  }
  const slots = textSlots(topProbe.outputNode.payload.text);
  if (slots.length === 0) {
    return [];
  }

  const variants: TextMicroVariant[] = [
    ...slotAblationVariants(slots),
    ...slotPairDropVariants(slots),
    adjacentSlotCompressionVariant(slots),
    wordOrderFlipVariant(slots),
  ].filter((variant): variant is TextMicroVariant => Boolean(variant));
  return uniqueTextVariants(variants, topProbe.outputNode.payload.text)
    .map((variant) => variant.text)
    .slice(0, maxCount);
}

function slotAblationVariants(slots: string[]): TextMicroVariant[] {
  if (slots.length <= 2) {
    return [];
  }
  return slots.map((_, index) => ({
    name: `probe-slot-ablation-${index + 1}`,
    text: slots.filter((__, slotIndex) => slotIndex !== index).join(", "),
  }));
}

function slotPairDropVariants(slots: string[]): TextMicroVariant[] {
  if (slots.length <= 3) {
    return [];
  }

  const variants: TextMicroVariant[] = [];
  for (let left = 0; left < slots.length - 1; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      variants.push({
        name: `probe-slot-pair-drop-${left + 1}-${right + 1}`,
        text: slots
          .filter((_, slotIndex) => slotIndex !== left && slotIndex !== right)
          .join(", "),
      });
    }
  }
  return variants;
}

function adjacentSlotCompressionVariant(
  slots: string[],
): TextMicroVariant | undefined {
  if (slots.length < 2) {
    return undefined;
  }
  const [first, second, ...rest] = slots;
  return {
    name: "probe-adjacent-compression",
    text: [`${first} ${second}`, ...rest].join(", "),
  };
}

function wordOrderFlipVariant(slots: string[]): TextMicroVariant | undefined {
  const flipped = slots.map((slot) => {
    const words = slot.split(/\s+/).filter(Boolean);
    if (words.length !== 2) {
      return slot;
    }
    return `${words[1]} ${words[0]}`;
  });
  if (flipped.every((slot, index) => slot === slots[index])) {
    return undefined;
  }
  return {
    name: "probe-word-order-flip",
    text: flipped.join(", "),
  };
}

function uniqueSlots(slots: string[]): string[] {
  const seen = new Set<string>();
  return slots.filter((slot) => {
    const key = normalizeTextVariant(slot);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectProbeSlots(slots: string[], priorities: number[]): string[] {
  const selected: string[] = [];
  for (const priority of priorities) {
    const slot = slots.find(
      (candidate) =>
        slotPriority(candidate) === priority && !selected.includes(candidate),
    );
    if (slot) {
      selected.push(slot);
    }
  }
  return selected;
}

const TEXT_PROBE_LIBRARY = [
  "stillness held, attention suspended, near quiet, soft ambiguity",
  "gaze quieted, warm shadow, dense air, calm uncertain",
  "slow pressure, muted warmth, intimate distance, heavy calm",
  "edges feathered, low contrast, softened haze, centered weight",
  "distance receding, central presence, veiled light, restrained motion",
  "dense air, suspended attention, warm stillness, unreadable calm",
  "cool haze, distant intimacy, quiet tension, aged surface",
  "soft rhythm, blurred edge, guarded warmth, folded quiet",
  "urgent rhythm, clipped pressure, cold focus, narrow motion",
  "bright motion, quick lift, open space, playful light",
  "sparse pressure, hard edge, low warmth, focused distance",
  "crowded energy, sharp contrast, active rhythm, tense proximity",
  "round calm, diffuse light, slow openness, gentle weight",
  "dark density, close air, inward attention, withheld meaning",
  "high salience, centered anchor, quiet field, balanced tension",
  "surface muted, texture aged, light lowered, motion stilled",
  "open distance, thin air, pale light, quiet release",
  "near body, heavy foreground, low motion, ambiguous presence",
  "faint warmth, shadow softened, gaze held, still depth",
  "abstract tension, softened structure, muted signal, slow drift",
  "fine texture, shallow depth, dim glow, calm restraint",
  "intimate scale, centered silence, atmospheric veil, uncertain mood",
  "fast brightness, crisp edge, high contrast, outward pull",
  "low contrast, old warmth, feathered boundary, hidden expression",
];

function effectiveTextMicroMutationCount(args: {
  configured: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): number {
  if (args.configured > 0) {
    return args.configured;
  }
  return args.inputType === "image" && args.outputType === "text"
    ? DEFAULT_IMAGE_TEXT_MICRO_MUTATIONS
    : 0;
}

function effectiveImageSeedMutationCount(args: {
  configured: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): number {
  if (args.inputType !== "image" || args.outputType !== "image") {
    return 0;
  }
  return args.configured;
}

function effectiveImageLocalMutationCount(args: {
  configured: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): number {
  if (args.inputType !== "image" || args.outputType !== "image") {
    return 0;
  }
  return args.configured;
}

function selectMicroMutationParents(args: {
  evaluatedOutputs: EvaluatedOutput[];
  candidateOutputs: CandidateOutput[];
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
  imageSeedMutations: number;
  imageLocalMutations: number;
  textMicroMutations: number;
}): CandidateOutput[] {
  if (args.outputType === "text" && args.textMicroMutations <= 0) {
    return [];
  }
  if (
    args.outputType === "image" &&
    args.imageSeedMutations <= 0 &&
    args.imageLocalMutations <= 0
  ) {
    return [];
  }
  if (args.outputType !== "text" && args.outputType !== "image") {
    return [];
  }

  const parentLimit = microMutationParentLimit(args);

  const originalByAgentId = new Map(
    args.candidateOutputs.map((candidate) => [candidate.agentId, candidate]),
  );

  return [...args.evaluatedOutputs]
    .sort(
      (left, right) => outputSelectionScore(right) - outputSelectionScore(left),
    )
    .slice(0, parentLimit)
    .map(
      (output) =>
        originalByAgentId.get(output.agentId) ??
        candidateFromEvaluatedOutput(output),
    );
}

function microMutationParentLimit(args: {
  evaluatedOutputs: EvaluatedOutput[];
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): number {
  if (args.outputType === "image") {
    return Math.min(1, args.evaluatedOutputs.length);
  }
  return args.inputType === "image" && args.outputType === "text"
    ? Math.min(2, args.evaluatedOutputs.length)
    : args.evaluatedOutputs.length;
}

function candidateFromEvaluatedOutput(
  output: EvaluatedOutput,
): CandidateOutput {
  return {
    agentId: output.agentId,
    outputNode: output.outputNode,
    entropy: output.entropy,
  };
}

function eliteReplayCandidateOutputs(args: {
  previous: NextIterationSeed;
  iteration: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): CandidateOutput[] {
  if (
    args.previous.type !== "selected-output-with-reasoning" ||
    args.previous.node.type !== args.outputType
  ) {
    return [];
  }

  return [
    {
      agentId: "elite-replay",
      outputNode: args.previous.node,
      entropy: [
        `iteration=${args.iteration}`,
        "strategy=elite replay",
        `inputType=${args.inputType}`,
        `outputType=${args.outputType}`,
        "Carry the previous selected elite forward unchanged so refinement is truly elitist and local mutation can exploit it.",
      ].join(" | "),
    },
  ];
}

function microMutationCandidateOutputs(args: {
  candidates: CandidateOutput[];
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
  imageSeedMutations: number;
  imageLocalMutations: number;
  textMicroMutations: number;
}): CandidateOutput[] {
  if (args.outputType === "image") {
    return imageMutationCandidateOutputs(args);
  }

  if (args.outputType !== "text" || args.textMicroMutations <= 0) {
    return [];
  }

  const expanded: CandidateOutput[] = [];
  for (const candidate of args.candidates) {
    if (candidate.outputNode.type !== "text") {
      continue;
    }
    const variants =
      args.inputType === "image"
        ? captionMicroVariants(
            candidate.outputNode.payload.text,
            args.textMicroMutations,
          )
        : textMicroVariants(
            candidate.outputNode.payload.text,
            args.textMicroMutations,
          );
    for (const [index, variant] of variants.entries()) {
      expanded.push({
        ...candidate,
        agentId: `${candidate.agentId}-micro-${index + 1}`,
        entropy: [
          candidate.entropy,
          `microMutation=${variant.name}`,
          `parentAgentId=${candidate.agentId}`,
        ]
          .filter(Boolean)
          .join(" | "),
        outputNode: {
          ...candidate.outputNode,
          payload: {
            ...candidate.outputNode.payload,
            text: variant.text,
          },
        },
      });
    }
  }
  return expanded;
}

function imageMutationCandidateOutputs(args: {
  candidates: CandidateOutput[];
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
  imageSeedMutations: number;
  imageLocalMutations: number;
}): CandidateOutput[] {
  if (
    args.inputType !== "image" ||
    args.outputType !== "image" ||
    (args.imageSeedMutations <= 0 && args.imageLocalMutations <= 0)
  ) {
    return [];
  }

  const expanded: CandidateOutput[] = [];
  for (const candidate of args.candidates) {
    if (candidate.outputNode.type !== "image") {
      continue;
    }
    const variants = [
      ...imageLocalStyleVariants(
        candidate.outputNode.payload.source.uri,
        args.imageLocalMutations,
      ),
      ...imageSeedVariants(
        candidate.outputNode.payload.source.uri,
        args.imageSeedMutations,
      ),
    ];
    for (const [index, variant] of variants.entries()) {
      expanded.push({
        ...candidate,
        agentId: `${candidate.agentId}-image-${index + 1}`,
        entropy: [
          candidate.entropy,
          `imageMutation=${variant.name}`,
          `parentAgentId=${candidate.agentId}`,
        ]
          .filter(Boolean)
          .join(" | "),
        outputNode: {
          ...candidate.outputNode,
          payload: {
            ...candidate.outputNode.payload,
            cachedVideo: undefined,
            source: {
              ...candidate.outputNode.payload.source,
              uri: variant.uri,
            },
          },
        },
      });
    }
  }
  return expanded;
}

function imageSeedVariants(
  uri: string,
  maxCount: number,
): Array<{ name: string; uri: string }> {
  const parsed = parseFluxMutationUri(uri);
  if (!parsed) {
    return [];
  }
  return Array.from({ length: maxCount }, (_, index) => {
    const seed = mutatedFluxSeed(parsed.seed, index);
    const url = cloneUrl(parsed.url);
    url.searchParams.set("seed", String(seed));
    return {
      name: `flux-seed-${seed}`,
      uri: url.toString(),
    };
  });
}

function imageLocalStyleVariants(
  uri: string,
  maxCount: number,
): Array<{ name: string; uri: string }> {
  const parsed = parseFluxMutationUri(uri);
  if (maxCount <= 0) {
    return [];
  }

  if (parsed) {
    const currentStyle = parsed.url.searchParams.get("voltaStyle") ?? "";
    return IMAGE_LOCAL_STYLE_VARIANTS.filter(
      (variant) => variant !== currentStyle,
    )
      .slice(0, maxCount)
      .map((variant) => {
        const url = cloneUrl(parsed.url);
        url.searchParams.set("voltaStyle", variant);
        return {
          name: `local-style-${variant}`,
          uri: url.toString(),
        };
      });
  }

  const localStyle = parseLocalImageStyleMutationUri(uri);
  const sourceUri = localStyle?.src ?? localStyleBaseSourceUri(uri);
  if (!isLocalImageSourceUri(sourceUri)) {
    return [];
  }
  const currentStyle = localStyle?.style ?? "";
  return IMAGE_LOCAL_STYLE_VARIANTS.filter(
    (variant) => variant !== currentStyle,
  )
    .slice(0, maxCount)
    .map((variant) => {
      const url = new URL("volta-style://image");
      url.searchParams.set("src", sourceUri);
      url.searchParams.set("style", variant);
      return {
        name: `local-style-${variant}`,
        uri: url.toString(),
      };
    });
}

function parseLocalImageStyleMutationUri(
  uri: string,
): { src: string; style: string } | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "volta-style:" || url.hostname !== "image") {
    return undefined;
  }
  const src = url.searchParams.get("src");
  const style = url.searchParams.get("style");
  if (!src || !style) {
    return undefined;
  }
  return { src, style };
}

function isLocalImageSourceUri(uri: string): boolean {
  return uri.startsWith("/") || uri.startsWith("file://");
}

function localStyleBaseSourceUri(uri: string): string {
  const localPath = uri.startsWith("file://")
    ? uri.slice("file://".length)
    : uri;
  if (!localPath.startsWith("/")) {
    return uri;
  }
  const targetStylePath = localPath.replace(
    /-target(?:-fidelity|-style-only|-soft-muted-strong|-flat-warm|-flat-cool|-crisp-neutral)?\.png$/,
    "-target-style.png",
  );
  if (targetStylePath !== localPath && existsSync(targetStylePath)) {
    return uri.startsWith("file://")
      ? `file://${targetStylePath}`
      : targetStylePath;
  }
  return uri;
}

function parseFluxMutationUri(
  uri: string,
): { url: URL; seed: number } | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "flux:" || url.hostname !== "generate") {
    return undefined;
  }
  const seed =
    Number.parseInt(url.searchParams.get("seed") ?? "", 10) ||
    seedFromString(uri);
  return { url, seed };
}

function cloneUrl(url: URL): URL {
  return new URL(url.toString());
}

const IMAGE_LOCAL_STYLE_VARIANTS = [
  "crisp-neutral",
  "flat-warm",
  "style-only",
  "flat-cool",
  "soft-muted-strong",
] as const;

function mutatedFluxSeed(seed: number, index: number): number {
  return (seed + 7_919 * (index + 1)) % 1_000_000;
}

function seedFromString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 1_000_000;
}

type TextMicroVariant = {
  name: string;
  text: string;
};

function textMicroVariants(text: string, maxCount: number): TextMicroVariant[] {
  const slots = textSlots(text);
  if (slots.length === 0) {
    return [];
  }

  return uniqueTextVariants(
    [
      syntaxInversionVariant(slots),
      axisReplacementVariant(slots),
      slotOrderVariant(slots),
      densityCompressionVariant(slots),
    ].filter((variant): variant is TextMicroVariant => Boolean(variant)),
    text,
  ).slice(0, maxCount);
}

type TextTransform = {
  name: string;
  apply: (text: string) => string;
};

const captionTransforms: TextTransform[] = [
  {
    name: "caption-visible-anchor-normalization",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bcream[- ]colored\b/gi, "white")
          .replace(/\bcream\b/gi, "white")
          .replace(/\blight[- ]colored\b/gi, "white")
          .replace(/\bgolden retriever puppy\b/gi, "puppy")
          .replace(/\bcentered\s+/gi, "")
          .replace(/\bcentrally\s+/gi, "")
          .replace(/\bsoft green grass\b/gi, "green grass")
          .replace(/\bsoft grass\b/gi, "green grass")
          .replace(/\bin a close view\b/gi, "")
          .replace(/\bin a close frame\b/gi, "")
          .replace(/\bin close framing\b/gi, "")
          .replace(/\bin close[- ]?up\b/gi, "")
          .replace(/\bclose[- ]up view\b/gi, "")
          .replace(/\bclose[- ]?up\b/gi, "")
          .replace(/\bclose view\b/gi, "")
          .replace(/\bclose frame\b/gi, "")
          .replace(/\bclose framing\b/gi, "")
          .replace(
            /\blooking\s+(?:gently\s+)?toward the camera\b/gi,
            "looking at the camera",
          )
          .replace(
            /\band looks\s+(?:gently\s+)?toward the camera\b/gi,
            ", looking at the camera",
          )
          .replace(
            /\band looks at the camera in a close frame\b/gi,
            ", looking at the camera",
          )
          .replace(/\band looks at the camera\b/gi, ", looking at the camera")
          .replace(/\bis sitting\b/gi, "sits")
          .replace(/\b(gently|calmly|quietly|softly)\s+/gi, ""),
      ),
  },
  {
    name: "caption-subject-setting-compression",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(
            /\s+and looks?\s+(?:at|toward) the camera(?:\s+in\s+a\s+close\s+frame)?/gi,
            "",
          )
          .replace(
            /,\s*looking\s+(?:at|toward) the camera(?:\s+in\s+a\s+close\s+frame)?/gi,
            "",
          )
          .replace(/\s+facing the camera\b/gi, "")
          .replace(/,\s*framed close(?:\s+with\s+[^.]+)?/gi, "")
          .replace(/\s+in a close frame\b/gi, "")
          .replace(/\b(?:on|upon) green grass\b/gi, "in green grass")
          .replace(/\b(?:on|upon) grass\b/gi, "in grass")
          .replace(
            /\b(?:small|little|tiny|fluffy|cream-colored|cream|white|light-colored|pale-colored)\s+(puppy|dog)\b/gi,
            "$1",
          ),
      ),
  },
  {
    name: "caption-direct-scene-normalization",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(
            /^A (?:wide|front|close) view shows empty yellow carpeted rooms under fluorescent lights(?: with no one inside)?\.?$/i,
            "Fluorescent lights shine over empty yellow carpeted rooms.",
          )
          .replace(/^A front view shows an?\s+/i, "A ")
          .replace(/^A wide view shows an?\s+/i, "A ")
          .replace(/^A close view shows an?\s+/i, "A ")
          .replace(/^The image shows an?\s+/i, "A ")
          .replace(/\b(room|hallway) opening to\b/gi, "$1 opens to")
          .replace(/\b(rooms|hallways) opening to\b/gi, "$1 open to")
          .replace(/\bpale yellow\b/gi, "yellow")
          .replace(/\byellow empty (hallway|room)\b/gi, "empty yellow $1")
          .replace(/\bwith carpet\b/gi, "with beige carpet")
          .replace(/^A empty\b/i, "An empty"),
      ),
  },
  {
    name: "caption-portrait-expression-grounding",
    apply: (text) => cleanCaptionText(portraitExpressionGrounding(text)),
  },
  {
    name: "caption-size-synonym",
    apply: (text) => cleanCaptionText(text.replace(/\bsmall\b/gi, "little")),
  },
  {
    name: "caption-interior-layout-focus",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(
            /^An empty ([a-z-]+) hallway opens into a carpeted room(?:\s+(?:with|under|before|within)\s+[^.]+)?\.?$/i,
            "A $1 hallway opens into an empty carpeted room.",
          )
          .replace(
            /^An empty ([a-z-]+) hallway opens into a ([a-z-]+) room(?:\s+(?:with|under|before|within)\s+[^.]+)?\.?$/i,
            "A $1 hallway opens into an empty $2 room.",
          )
          .replace(
            /^An empty ([a-z-]+) room is viewed through a doorway,?\s*(?:with\s+[^.]+)?\.?$/i,
            "A $1 hallway opens into an empty carpeted room.",
          ),
      ),
  },
  {
    name: "caption-interior-opening-simplification",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(
            /^An empty yellow room with beige carpet opens into a fluorescent-lit space with patterned wallpaper\.?$/i,
            "A yellow carpeted room opens into another empty room under fluorescent lights.",
          )
          .replace(
            /^An empty yellow room with beige carpet extends past patterned walls under fluorescent lights\.?$/i,
            "A yellow carpeted room opens into another empty room under fluorescent lights.",
          )
          .replace(
            /^An empty ([a-z-]+ )?room opens into (?:a|another) fluorescent-lit space with patterned wallpaper\.?$/i,
            "An empty room opens into another room under fluorescent lights.",
          )
          .replace(
            /^An empty ([a-z-]+ )?room opens into beige carpeted corridors with pale patterned wallpaper\.?$/i,
            "An empty room opens into another carpeted room under fluorescent lights.",
          ),
      ),
  },
  {
    name: "caption-size-ablation",
    apply: (text) =>
      cleanCaptionText(text.replace(/\b(small|little|tiny)\s+/gi, "")),
  },
  {
    name: "caption-camera-at",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(
            /\blooking\s+(?:gently\s+)?toward the camera\b/gi,
            "looking at the camera",
          )
          .replace(/\bfacing toward the camera\b/gi, "facing the camera")
          .replace(
            /\band looks\s+(?:gently\s+)?toward the camera\b/gi,
            ", looking at the camera",
          )
          .replace(/\band looks at the camera\b/gi, ", looking at the camera"),
      ),
  },
  {
    name: "caption-camera-facing",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/,\s*looking at the camera\b/gi, " facing the camera")
          .replace(/,\s*looking toward the camera\b/gi, " facing the camera")
          .replace(/\blooking at the camera\b/gi, "facing the camera")
          .replace(/\blooking toward the camera\b/gi, "facing the camera"),
      ),
  },
  {
    name: "caption-framing-detail-ablation",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bin a close view\b/gi, "")
          .replace(/\bin a close frame\b/gi, "")
          .replace(/\bin close framing\b/gi, "")
          .replace(/\bin close[- ]?up\b/gi, "")
          .replace(/\bcentered\s+/gi, "")
          .replace(/\bcentrally\s+/gi, "")
          .replace(/\bclose[- ]up view\b/gi, "")
          .replace(/\bclose[- ]?up\b/gi, "")
          .replace(/\bclose view\b/gi, "")
          .replace(/\bclose frame\b/gi, "")
          .replace(/\bclose framing\b/gi, "")
          .replace(
            /\s+with\s+[^,]+?\s+(?=(sits|stands|lies|looks|faces|is|are)\b)/gi,
            " ",
          ),
      ),
  },
  {
    name: "caption-weak-adverb-drop",
    apply: (text) =>
      cleanCaptionText(
        text.replace(/\b(gently|calmly|quietly|softly)\s+/gi, ""),
      ),
  },
  {
    name: "caption-common-color",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bcream[- ]colored\b/gi, "white")
          .replace(/\bcream\b/gi, "white")
          .replace(/\blight[- ]colored\b/gi, "white")
          .replace(/\bpale[- ]colored\b/gi, "white"),
      ),
  },
  {
    name: "caption-framing-ablation",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bin a close view\b/gi, "")
          .replace(/\bin a close frame\b/gi, "")
          .replace(/\bin close framing\b/gi, "")
          .replace(/\bin close[- ]?up\b/gi, "")
          .replace(/\bclose[- ]up view\b/gi, "")
          .replace(/\bclose[- ]?up\b/gi, "")
          .replace(/\bclose view\b/gi, "")
          .replace(/\bclose frame\b/gi, "")
          .replace(/\bclose framing\b/gi, ""),
      ),
  },
  {
    name: "caption-setting-color",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bsoft green grass\b/gi, "green grass")
          .replace(/\bsoft grass\b/gi, "green grass"),
      ),
  },
  {
    name: "caption-present-tense",
    apply: (text) =>
      cleanCaptionText(
        text
          .replace(/\bis sitting\b/gi, "sits")
          .replace(/\bis looking\b/gi, "looks")
          .replace(/\bis facing\b/gi, "faces"),
      ),
  },
];

function captionMicroVariants(
  text: string,
  maxCount: number,
): TextMicroVariant[] {
  const variants: TextMicroVariant[] = [];
  for (const transform of captionTransforms) {
    variants.push({
      name: transform.name,
      text: transform.apply(text),
    });
  }

  for (let left = 0; left < captionTransforms.length; left += 1) {
    for (let right = left + 1; right < captionTransforms.length; right += 1) {
      const leftTransform = captionTransforms[left];
      const rightTransform = captionTransforms[right];
      variants.push({
        name: `${leftTransform.name}+${rightTransform.name}`,
        text: rightTransform.apply(leftTransform.apply(text)),
      });
    }
  }

  return uniqueTextVariants(variants, text).slice(0, maxCount);
}

function portraitExpressionGrounding(text: string): string {
  const groundedPortrait =
    "A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.";
  if (
    /\bdark-haired woman\b/i.test(text) &&
    /\blandscape\b/i.test(text) &&
    /\b(sits?|gazes?|faces?|facing|portrait|viewer|outward)\b/i.test(text)
  ) {
    return groundedPortrait;
  }
  return text
    .replace(
      /^A dark-haired woman with folded hands faces forward before a hazy green landscape under warm, cracked light\.?$/i,
      groundedPortrait,
    )
    .replace(
      /^A dark-haired woman sits before a hazy landscape, facing the viewer\.?$/i,
      groundedPortrait,
    )
    .replace(
      /^A dark-haired woman sits before a misty landscape, gazing forward in warm, cracked light\.?$/i,
      groundedPortrait,
    );
}

function cleanCaptionText(text: string): string {
  return text
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/,\s*\./g, ".")
    .replace(/\s+(in|with|at|on|toward|towards|of|for|to)\s*([.!?])$/i, "$2")
    .replace(/\s+(in|with|at|on|toward|towards|of|for|to)$/i, "")
    .trim();
}

function textSlots(text: string): string[] {
  return text
    .split(",")
    .map((slot) => slot.trim())
    .filter(Boolean);
}

function textWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function syntaxInversionVariant(slots: string[]): TextMicroVariant | undefined {
  const mutated = slots.map((slot) => {
    const words = slot.split(/\s+/).filter(Boolean);
    if (words.length !== 2) {
      return slot;
    }
    const [modifier, noun] = words;
    const transformedModifier = INVERTED_MODIFIERS[modifier.toLowerCase()];
    if (!transformedModifier) {
      return slot;
    }
    return `${noun} ${transformedModifier}`;
  });
  if (mutated.every((slot, index) => slot === slots[index])) {
    return undefined;
  }
  return {
    name: "syntax-inversion",
    text: mutated.join(", "),
  };
}

function axisReplacementVariant(slots: string[]): TextMicroVariant | undefined {
  const options: {
    slotIndex: number;
    slot: string;
    axis: (typeof TEXT_AXIS_REPLACEMENTS)[number];
  }[] = [];
  for (const [slotIndex, slot] of slots.entries()) {
    for (const axis of TEXT_AXIS_REPLACEMENTS) {
      if (!axis.pattern.test(slot)) {
        continue;
      }
      options.push({
        slotIndex,
        slot,
        axis,
      });
    }
  }
  const selected = options.sort(
    (left, right) =>
      slotPriority(left.slot) - slotPriority(right.slot) ||
      left.slotIndex - right.slotIndex,
  )[0];
  if (!selected) {
    return undefined;
  }

  const replacement =
    selected.axis.replacements[
      selected.slotIndex % selected.axis.replacements.length
    ];
  const mutated = [...slots];
  mutated[selected.slotIndex] = replacement;
  return {
    name: `axis-replacement-${selected.axis.name}`,
    text: mutated.join(", "),
  };
}

function slotOrderVariant(slots: string[]): TextMicroVariant | undefined {
  const ordered = [...slots].sort(
    (left, right) => slotPriority(left) - slotPriority(right),
  );
  if (ordered.every((slot, index) => slot === slots[index])) {
    return undefined;
  }
  return {
    name: "slot-priority-order",
    text: ordered.join(", "),
  };
}

function densityCompressionVariant(
  slots: string[],
): TextMicroVariant | undefined {
  if (slots.length < 6) {
    return undefined;
  }
  const kept = slots.filter((slot, index) => {
    const priority = slotPriority(slot);
    return priority <= 5 || index < 5;
  });
  const compressed = kept.slice(0, 7);
  if (compressed.length === slots.length) {
    return undefined;
  }
  return {
    name: "density-compression",
    text: compressed.join(", "),
  };
}

function slotPriority(slot: string): number {
  const lower = slot.toLowerCase();
  const priorities = [
    /gaze|attention|salience|focus/,
    /warm|amber|ochre|light|temperature/,
    /edge|soft|feather|surface|texture|contrast/,
    /center|central|figure|anchor|presence/,
    /still|motion|slow|rhythm|poise/,
    /distance|depth|space|near|far|reced/,
    /calm|ambiguous|uncertain|tension|mood/,
    /haze|air|atmosphere|density|veil/,
  ];
  const index = priorities.findIndex((pattern) => pattern.test(lower));
  return index === -1 ? priorities.length : index;
}

function uniqueTextVariants(
  variants: TextMicroVariant[],
  original: string,
): TextMicroVariant[] {
  const seen = new Set([normalizeTextVariant(original)]);
  return variants.filter((variant) => {
    const key = normalizeTextVariant(variant.text);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeTextVariant(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const INVERTED_MODIFIERS: Record<string, string> = {
  aged: "aged",
  ambiguous: "ambiguous",
  calm: "calmed",
  central: "centered",
  dense: "dense",
  direct: "held",
  distant: "distant",
  heavy: "weighted",
  hushed: "hushed",
  intimate: "intimate",
  low: "lowered",
  muted: "muted",
  quiet: "quieted",
  receding: "receding",
  slow: "slowed",
  soft: "softened",
  softened: "softened",
  still: "stilled",
  uncertain: "uncertain",
  veiled: "veiled",
  warm: "warmed",
};

const TEXT_AXIS_REPLACEMENTS: {
  name: string;
  pattern: RegExp;
  replacements: string[];
}[] = [
  {
    name: "attention",
    pattern: /gaze|attention|focus|salience/i,
    replacements: ["gaze quieted", "attention held", "focus suspended"],
  },
  {
    name: "temperature",
    pattern: /warm|amber|ochre|gold|light|temperature/i,
    replacements: ["ochre age-warmth", "muted warmth", "amber age-warmth"],
  },
  {
    name: "surface",
    pattern: /edge|soft|surface|texture|contrast|crack|patina/i,
    replacements: ["edges feathered", "surface muted", "contrast lowered"],
  },
  {
    name: "space",
    pattern: /distance|depth|space|near|far|intimate|reced/i,
    replacements: ["distance receding", "depth softened", "space held near"],
  },
  {
    name: "affect",
    pattern: /calm|ambiguous|uncertain|tension|mood|poise/i,
    replacements: ["calm uncertain", "tension hushed", "poise withheld"],
  },
  {
    name: "atmosphere",
    pattern: /haze|air|atmosphere|dense|veil/i,
    replacements: ["dense air", "haze softened", "veil thinned"],
  },
];

function attachActivationDiagnostics(args: {
  candidate: Awaited<ReturnType<NeuralOracle["encode"]>>;
  target: Awaited<ReturnType<NeuralOracle["encode"]>>;
}): Awaited<ReturnType<NeuralOracle["encode"]>> {
  const candidateYeo = args.candidate.diagnostics?.yeo7Means;
  const targetYeo = args.target.diagnostics?.yeo7Means;
  if (!candidateYeo || !targetYeo) {
    return args.candidate;
  }
  return {
    ...args.candidate,
    diagnostics: {
      ...args.candidate.diagnostics,
      yeo7DeltaFromTarget: subtractYeo(candidateYeo, targetYeo),
    },
  };
}

function subtractYeo(
  candidate: Record<string, number>,
  target: Record<string, number>,
): Record<string, number> {
  const networks = new Set([...Object.keys(candidate), ...Object.keys(target)]);
  return Object.fromEntries(
    [...networks].map((network) => [
      network,
      (candidate[network] ?? 0) - (target[network] ?? 0),
    ]),
  );
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

type MutationStrategy = {
  name: string;
  instruction: string;
};

const coldStartStrategies: MutationStrategy[] = [
  {
    name: "minimal activation code",
    instruction:
      "Create a first-generation compact activation code: 6-8 comma-separated phrase units, 10-18 words total, no full sentence. Encode motion level, attention or salience, atmosphere or density, distance, central presence, and ambiguity.",
  },
  {
    name: "affect-density code",
    instruction:
      "Create a first-generation compact activation code emphasizing affect and density: calm/tense, fast/slow, dense/sparse, intimate/distant, warm/cool, certain/ambiguous. Use phrase fragments, not explanatory prose.",
  },
  {
    name: "sensory-surface code",
    instruction:
      "Create a first-generation compact activation code emphasizing modality-neutral sensory surface: light or tone, contrast, rhythm, edge quality, surface/timbre, softness/sharpness, and one concrete anchor if helpful.",
  },
  {
    name: "structure-proximity code",
    instruction:
      "Create a first-generation compact activation code emphasizing structure and proximity: foreground/background weight, centrality, density, symmetry/asymmetry, scale, repetition, and compositional balance.",
  },
  {
    name: "sparse latent code",
    instruction:
      "Create a compact latent-code candidate rather than an explanatory description. Prefer a small set of high-signal perceptual states over object inventory, plot summary, proper names, or facts.",
  },
  {
    name: "concrete-anchor genotype",
    instruction:
      "Create a first-generation candidate with a few concrete anchors from the input, then bind them to generic perceptual variables such as motion, space, contrast, rhythm, texture, and affect.",
  },
  {
    name: "novelty-seeking genotype",
    instruction:
      "Create a deliberately different first-generation candidate that explores an underrepresented region of the behavior space while preserving the input's likely perceptual feel.",
  },
  {
    name: "contrastive genotype",
    instruction:
      "Create a first-generation candidate organized around contrast pairs visible or inferable from the input: warm/cool, near/far, still/active, dense/open, clear/ambiguous, bright/dark.",
  },
  {
    name: "anti-literal genotype",
    instruction:
      "Avoid labels, proper names, metadata, genre facts, and exhaustive inventory. Search the target's predicted neural vibe through perceptual experience, not literal identification.",
  },
];

const imageTextColdStartStrategies: MutationStrategy[] = [
  {
    name: "grounded natural caption",
    instruction:
      "Create one concise natural sentence that directly describes the visible image. Use ordinary caption grammar, 8-18 words, and simple visible anchors: subject, common color, setting, gaze, and framing. Include a simple verb or relation; do not return a label-only phrase. Avoid vague mood adverbs and comma-separated activation-code fragments.",
  },
  {
    name: "perceptual caption",
    instruction:
      "Create one natural caption sentence, 10-20 words, that names the main visible subject and preserves attention, distance, light, texture, setting, and the clearest spatial relation or opening. Keep it literal and grounded; do not list every detail.",
  },
  {
    name: "spatial relation caption",
    instruction:
      "Create one short caption sentence, 8-18 words, centered on the target's strongest visible spatial relation: opens into, sits against, faces, rests on, stretches across, or recedes through. Include simple color/setting words when visible. Prefer a concrete scene description over abstract mood words.",
  },
  {
    name: "caption with context",
    instruction:
      "Create one short caption sentence, 8-18 words, with a clear subject, setting, and visual relation. Prefer a concrete scene description over abstract mood words.",
  },
  {
    name: "caption detail probe",
    instruction:
      "Create one concise natural caption sentence, 8-20 words, with two specific visual details likely to matter neurally, such as subject, color, gaze, texture, background, or framing. Include a simple verb or relation; avoid exact category labels unless visually obvious.",
  },
  {
    name: "minimal literal caption",
    instruction:
      "Create the simplest accurate natural-language caption for the image as a complete subject-verb sentence. Avoid poetic wording, label-only phrases, metadata, and comma inventories.",
  },
];

const imageImageColdStartStrategies: MutationStrategy[] = [
  {
    name: "image visual reconstruction",
    instruction:
      "Create a Flux prompt that closely preserves the visible target image's subject, composition, camera distance, crop, resolution feel, background, light, color palette, texture, and photographic style. Do not beautify, cinematicize, or add detail that is absent from the target. If the seed asks for a different subject, preserve the target's composition and feel while changing only that subject.",
  },
  {
    name: "image composition lock",
    instruction:
      "Create a Flux prompt that locks onto the target's layout: main subject position, body scale, wall/door/opening geometry, foreground/background balance, depth of field, lighting, dominant colors, and low-level camera quality. Avoid abstract mood-only prompts and avoid polished stock-photo detail.",
  },
  {
    name: "image semantic anchor",
    instruction:
      "Create a Flux prompt centered on the target's most important visual entity and setting, with concrete details for posture, framing, surface texture, and background. Keep the prompt literal and concise.",
  },
  {
    name: "image low-fidelity target style",
    instruction:
      "Create a concise Flux prompt that prioritizes the target's low-level capture style: aspect ratio, apparent resolution, blur, compression or grain, contrast, saturation, color cast, and camera distance. Include only the most important subject/composition anchors; do not over-inventory objects.",
  },
  {
    name: "image absence and sparsity lock",
    instruction:
      "Create a Flux prompt that preserves what is absent as much as what is present. Match the target's object density, empty/filled regions, blank surfaces, uncluttered areas, and simple foreground/background balance while keeping the main subject and lighting grounded.",
  },
];

const textProbeColdStartStrategies: MutationStrategy[] = [
  {
    name: "probe-elite point mutation",
    instruction:
      "Use the top text-probe-calibration archive entry as the elite parent. Preserve its slot count, syntax, and strongest slots exactly, then mutate one weak slot using another high-scoring probe axis. Do not invent a new description from scratch.",
  },
  {
    name: "probe-elite crossover",
    instruction:
      "Use the top two text-probe-calibration archive entries as parents. Keep the best probe's strongest slots, inherit one compatible slot from the runner-up probe, and return one compact comma-separated child. Do not average all probes.",
  },
  {
    name: "probe-elite abstraction shift",
    instruction:
      "Use the top text-probe-calibration archive entry as the elite parent. Preserve its activation feel but shift one slot to a lower-level perceptual axis such as attention, density, distance, surface, warmth, or ambiguity.",
  },
];

const refinementStrategies: MutationStrategy[] = [
  {
    name: "elitist point mutation",
    instruction:
      "Preserve the previous elite's strongest behavior. Mutate exactly one semantic unit or rendering variable, keeping all other high-scoring traits stable.",
  },
  {
    name: "operator-fitness exploit",
    instruction:
      "Use the archive's operatorStats to identify the strongest operator family so far. Generate a child that follows that family more deliberately while preserving the current elite's strongest traits. If no stats exist, fall back to conservative point mutation.",
  },
  {
    name: "syntax-order exploit",
    instruction:
      "Exploit a high-scoring representation pattern by preserving the elite's slot order, fragment count, and word order style. Mutate exactly one content variable inside that syntax while keeping the morphology of the strongest slots stable.",
  },
  {
    name: "slot-library exploit",
    instruction:
      "Treat a text elite as genotype slots. Preserve slot order and mutate exactly one weak slot using the closest generic perceptual axis: temperature/light, motion/stillness, attention/gaze/salience, atmosphere/air/density, proximity/distance/depth, surface/texture, central anchor, or ambiguity/calm/tension. Do not add a sentence.",
  },
  {
    name: "slot-crossover exploit",
    instruction:
      "Treat archive text candidates as compatible slot genotypes. Preserve the current elite's strongest slots, then replace one slot with the best same-axis slot from another high-scoring archive parent. Do not average all parents; make one decisive inheritance.",
  },
  {
    name: "generic focus-axis mutation",
    instruction:
      "Preserve the previous elite except replace one concrete anchor, focus, attention, or central-presence unit with a domain-appropriate alternative supported by the input.",
  },
  {
    name: "generic unit-library mutation",
    instruction:
      "Treat the previous elite as semantic units. Preserve unit order and replace exactly one whole unit with another unit from the same generic axis: motion, attention, distance, contrast, rhythm, texture, affect, structure, or concrete anchor.",
  },
  {
    name: "space-density mutation",
    instruction:
      "Preserve the previous elite except replace one atmosphere, distance, density, scale, rhythm, or context variable with a nearby alternative.",
  },
  {
    name: "sensory-axis mutation",
    instruction:
      "Preserve the previous elite except replace one sensory variable: color/tone, brightness, contrast, edge quality, timbre, rhythm, texture, or surface.",
  },
  {
    name: "elite crossover",
    instruction:
      "Create a crossover child: combine the previous elite's strongest units with one or two high-scoring units from archive parents. Do not average everything; inherit only useful traits.",
  },
  {
    name: "ablation mutation",
    instruction:
      "Remove one likely distracting unit from the previous elite and replace it with a lower-level perceptual variable from the same medium-neutral behavior space.",
  },
  {
    name: "novelty injection",
    instruction:
      "Explore a behavior descriptor that is absent or weak in the archive while preserving at least two proven elite traits. Prefer novelty that can still score, not random drift.",
  },
  {
    name: "diagnostic-axis correction",
    instruction:
      "Use the judge reasoning, archive rankings, and any auxiliary diagnostics as mutation-axis hints. Correct one suspected underrepresented perceptual variable while keeping the elite scaffold.",
  },
  {
    name: "one-variable representation mutation",
    instruction:
      "Change exactly one representation variable: length, syntax, abstraction level, concrete-anchor density, sensory density, or medium-specific layout/rendering. Leave content traits stable.",
  },
  {
    name: "negative-control escape",
    instruction:
      "Deliberately avoid the dominant previous representation pattern and try a different syntax or rendering form while preserving the target's perceptual feel.",
  },
];

const imageTextRefinementStrategies: MutationStrategy[] = [
  {
    name: "caption concrete-detail mutation",
    instruction:
      "Preserve the best caption's natural sentence structure, but replace one weak or vague word with a more literal visible anchor from the image. Keep it one sentence.",
  },
  {
    name: "caption grounding correction",
    instruction:
      "Rewrite the caption as a more literal description of the visible image while preserving any high-scoring subject, setting, gaze, texture, or lighting cues.",
  },
  {
    name: "caption sentence-shape mutation",
    instruction:
      "Keep the same visible content but change the sentence shape: subject-first, setting-first, or action-first. Do not switch back to comma-separated fragments.",
  },
  {
    name: "caption sensory-detail mutation",
    instruction:
      "Preserve the caption's main subject and setting, then mutate one sensory detail such as color, softness, light, depth, or background texture.",
  },
  {
    name: "caption specificity reset",
    instruction:
      "Discard abstract mood language, vague adverbs, and over-specific labels. Write a fresh concise caption grounded in the visible subject and scene. Use one natural sentence.",
  },
];

const imageImageRefinementStrategies: MutationStrategy[] = [
  {
    name: "image operator-fitness exploit",
    instruction:
      "Use the archive scores to identify the strongest image operator family so far. Preserve the current global elite's strongest visible traits, then make one deliberate visual correction toward the attached target image. Do not use text-slot or sentence-shape language.",
  },
  {
    name: "image elite visual correction",
    instruction:
      "Inspect the attached target and previous selected image. Preserve the previous elite's strongest subject, camera distance, crop, color cast, and low-level style, then correct exactly one visible miss against the target. Express the child as one concise Flux prompt.",
  },
  {
    name: "image geometry correction",
    instruction:
      "Use the target image as the geometry authority. Preserve the elite's useful visual feel, but correct one layout variable such as wall plane position, doorway/opening count, foreground/background balance, subject scale, horizon/ceiling placement, or crop.",
  },
  {
    name: "image sparsity correction",
    instruction:
      "Preserve the elite's main scene and style while removing visual clutter that is absent from the target. Emphasize empty space, blank regions, simple surfaces, and the target's level of object/detail density.",
  },
  {
    name: "image surface-light correction",
    instruction:
      "Preserve the elite's composition, but adjust surface texture, blur, contrast, saturation, color temperature, and light direction toward the target. Avoid adding new semantic content.",
  },
  {
    name: "image concise anchor reset",
    instruction:
      "Make a concise visual prompt from the target and elite: name only the core subject, composition, light/color, texture, camera quality, and one absence constraint. Avoid over-constrained inventories and avoid text-style slot language.",
  },
];

const textMoonshotStrategies: MutationStrategy[] = [
  {
    name: "latent-axis reset",
    instruction:
      "Make a basin-jump child. Do not preserve the elite wording. Reconstruct a new compact activation code from latent axes only: energy, attention, density, distance, texture, centrality, ambiguity. Keep at most one elite slot if it is clearly essential.",
  },
  {
    name: "orthogonal-niche jump",
    instruction:
      "Make a MAP-Elites-style niche jump. Choose a behavior niche that is missing or weak in the archive, then generate a compact slot code that preserves the target feel through different perceptual variables instead of local synonym edits.",
  },
  {
    name: "contrastive-projection jump",
    instruction:
      "Build an intentionally contrastive internal sketch on one axis, then project it back toward the target activation. The final output must be a compact comma-separated code, but it should escape the current elite's wording basin.",
  },
  {
    name: "diagnostic-manifold jump",
    instruction:
      "Use judge reasoning, score gaps, and any diagnostics as weak hints to jump to a different manifold of wording. Replace most slots with lower-level perceptual states while preserving only the strongest one or two target-aligned traits.",
  },
];

const textRefinementLeadStrategyNames = [
  "syntax-order exploit",
  "slot-library exploit",
  "operator-fitness exploit",
  "elitist point mutation",
  "slot-crossover exploit",
] as const;

const textRefinementLeadStrategyNameSet = new Set<string>(
  textRefinementLeadStrategyNames,
);

const textRefinementLeadStrategies = textRefinementLeadStrategyNames.map(
  (name) => strategyByName(refinementStrategies, name),
);

const textRefinementTailStrategies = refinementStrategies.filter(
  (strategy) => !textRefinementLeadStrategyNameSet.has(strategy.name),
);

function mutationStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
  archive?: CandidateArchive;
}): string {
  const strategy = selectMutationStrategy(args);
  return [
    `iteration=${args.iteration}`,
    `strategy=${strategy.name}`,
    `inputType=${args.inputType}`,
    `outputType=${args.outputType}`,
    strategy.instruction,
    outputTypeInstruction(args.outputType, args.inputType),
  ].join(" | ");
}

function selectMutationStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
  archive?: CandidateArchive;
}): MutationStrategy {
  if (isImageToText(args)) {
    return selectImageTextStrategy(args);
  }
  if (isImageToImage(args)) {
    return selectImageImageStrategy(args);
  }
  if (
    args.iteration === 1 &&
    args.outputType === "text" &&
    hasTextProbeArchive(args.archive)
  ) {
    return rotatingStrategy(textProbeColdStartStrategies, args.index);
  }
  if (args.iteration === 1) {
    return rotatingStrategy(coldStartStrategies, args.index);
  }
  if (args.outputType === "text") {
    return selectTextRefinementStrategy(args);
  }
  const generationOffset =
    Math.max(0, args.iteration - 2) * Math.max(1, args.candidateCount);
  return rotatingStrategy(refinementStrategies, generationOffset + args.index);
}

function selectImageTextStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  archive?: CandidateArchive;
}): MutationStrategy {
  if (args.iteration === 1) {
    return rotatingStrategy(imageTextColdStartStrategies, args.index);
  }
  const generationOffset =
    Math.max(0, args.iteration - 2) * Math.max(1, args.candidateCount);
  return rotatingStrategy(
    imageTextRefinementStrategies,
    generationOffset + args.index,
  );
}

function selectImageImageStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
}): MutationStrategy {
  if (args.iteration === 1) {
    return rotatingStrategy(imageImageColdStartStrategies, args.index);
  }
  return rotatingStrategy(imageImageRefinementStrategies, args.index);
}

function isImageToText(args: {
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): boolean {
  return args.inputType === "image" && args.outputType === "text";
}

function isImageToImage(args: {
  inputType: InputObj["inputNode"]["type"];
  outputType: OutputObj["outputType"];
}): boolean {
  return args.inputType === "image" && args.outputType === "image";
}

function selectTextRefinementStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  archive?: CandidateArchive;
}): MutationStrategy {
  const moonshotCount = shouldInjectMoonshot(args) ? 1 : 0;
  const exploitCandidateCount = Math.max(
    1,
    args.candidateCount - moonshotCount,
  );
  if (args.index >= exploitCandidateCount) {
    return rotatingStrategy(
      textMoonshotStrategies,
      Math.max(0, args.iteration - 3),
    );
  }

  const leadStrategies = uniqueStrategies([
    ...adaptiveTextLeadStrategies(args.archive),
    ...textRefinementLeadStrategies,
  ]);
  const leadCount = Math.min(exploitCandidateCount, leadStrategies.length);
  if (args.index < leadCount) {
    return leadStrategies[args.index];
  }
  const tailWidth = Math.max(1, exploitCandidateCount - leadCount);
  const generationOffset = Math.max(0, args.iteration - 2) * tailWidth;
  const tailIndex = generationOffset + args.index - leadCount;
  return rotatingStrategy(textRefinementTailStrategies, tailIndex);
}

function adaptiveTextLeadStrategies(
  archive: CandidateArchive | undefined,
): MutationStrategy[] {
  if (!archive || archive.entries.length === 0) {
    return [];
  }
  return operatorStats(archive.entries)
    .map((stat) =>
      refinementStrategies.find((item) => item.name === stat.operator),
    )
    .filter((strategy): strategy is MutationStrategy => Boolean(strategy))
    .slice(0, 2);
}

function shouldInjectMoonshot(args: {
  iteration: number;
  candidateCount: number;
  archive?: CandidateArchive;
}): boolean {
  if (args.iteration < 3 || args.candidateCount < 3 || !args.archive) {
    return false;
  }
  return turnsSinceBest(args.archive) >= 1;
}

function turnsSinceBest(archive: CandidateArchive): number {
  const best = archive.entries.reduce<
    { iteration: number; neuralSimilarity: number } | undefined
  >((current, entry) => {
    if (!current || entry.neuralSimilarity > current.neuralSimilarity) {
      return {
        iteration: entry.iteration,
        neuralSimilarity: entry.neuralSimilarity,
      };
    }
    return current;
  }, undefined);
  if (!best) {
    return 0;
  }
  const latestIteration = archive.entries.reduce(
    (latest, entry) => Math.max(latest, entry.iteration),
    best.iteration,
  );
  return latestIteration - best.iteration;
}

function uniqueStrategies(strategies: MutationStrategy[]): MutationStrategy[] {
  const seen = new Set<string>();
  return strategies.filter((strategy) => {
    if (seen.has(strategy.name)) {
      return false;
    }
    seen.add(strategy.name);
    return true;
  });
}

function rotatingStrategy(
  strategies: MutationStrategy[],
  index: number,
): MutationStrategy {
  if (strategies.length === 0) {
    throw new Error("Mutation strategy pool is empty.");
  }
  return strategies[index % strategies.length];
}

function hasTextProbeArchive(archive: CandidateArchive | undefined): boolean {
  return (
    archive?.entries.some((entry) =>
      entry.entropy?.includes("strategy=text-probe-calibration"),
    ) ?? false
  );
}

function strategyByName(
  strategies: MutationStrategy[],
  name: string,
): MutationStrategy {
  const strategy = strategies.find((candidate) => candidate.name === name);
  if (!strategy) {
    throw new Error(`Missing mutation strategy: ${name}`);
  }
  return strategy;
}

function outputTypeInstruction(
  outputType: OutputObj["outputType"],
  inputType: InputObj["inputNode"]["type"],
): string {
  if (outputType === "text") {
    if (inputType === "image") {
      return "For image-to-text output, prefer one concise natural caption sentence, usually 8-20 words, that directly describes the visible target with simple subject, verb or visible relation, color, setting, gaze, and framing anchors. Keep only the strongest visible anchors. Avoid label-only phrases, vague mood adverbs, over-specific labels, comma-separated phrase fragments, and abstract activation codes.";
    }
    return "For text output, use compact comma-separated semantic units by default: 6-8 phrase fragments, 10-18 words total, no full sentence, no labels, no proper names, no explanatory prose.";
  }
  if (outputType === "image") {
    return "For image output, express the operator through a Flux image prompt encoded in source.uri as flux://generate?prompt=<urlencoded prompt>&model=klein&steps=4&seed=<integer>. The prompt should specify subject anchors, composition, light/color, texture, camera/framing, and atmosphere. Use a different seed for parallel candidates.";
  }
  return "For code output, express the operator through renderable UI/scene structure: layout, motion/static balance, density, typography, color/contrast, texture, and interaction-free visual state.";
}

function getStopReason(args: {
  bestAdjustedSimilarity: number | undefined;
  iterationsCompleted: number;
  loop: LoopConfig;
}): StopReason | undefined {
  if (
    typeof args.bestAdjustedSimilarity === "number" &&
    args.bestAdjustedSimilarity >= args.loop.similarityThreshold
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

  const artifactIterations = result.iterations as IterationResult[];
  const diskIterations = loadCompletedIterationsFromDisk(record.runPath);
  const shouldUseDiskIterations =
    diskIterations.length > artifactIterations.length;
  const existingIterations = shouldUseDiskIterations
    ? diskIterations
    : artifactIterations;
  const lastIteration = existingIterations.at(-1);
  const elite = bestOverallOutput(existingIterations);
  const previous = elite
    ? seedFromElite({
        elite,
      })
    : shouldUseDiskIterations
      ? lastIteration?.nextIterationSeed
      : (result.nextIterationSeed ?? lastIteration?.nextIterationSeed);
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

function loadCompletedIterationsFromDisk(runPath: string): IterationResult[] {
  const iterationsPath = join(runPath, "iterations");
  if (!existsSync(iterationsPath)) {
    return [];
  }

  const iterationNumbers = readdirSync(iterationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);

  const iterations: IterationResult[] = [];
  let previous: NextIterationSeed = { type: "fresh" };
  for (const iteration of iterationNumbers) {
    const iterationPath = join(iterationsPath, iterationId(iteration));
    const summary = readOptionalJson<{ stopReason?: StopReason }>(
      join(iterationPath, "iteration.json"),
    );
    const candidateOutputs = readOptionalJson<CandidateOutput[]>(
      join(iterationPath, "candidates.json"),
    );
    const rankedOutputs = readOptionalJson<EvaluatedOutput[]>(
      join(iterationPath, "scores.json"),
    );
    const judge = readOptionalJson<Awaited<ReturnType<typeof runJudgeAgent>>>(
      join(iterationPath, "judge.json"),
    );
    const nextIterationSeed = readOptionalJson<NextIterationSeed>(
      join(iterationPath, "next-seed.json"),
    );

    if (!summary || !candidateOutputs || !rankedOutputs || !judge) {
      continue;
    }
    if (!nextIterationSeed) {
      continue;
    }

    iterations.push({
      iteration,
      previous,
      candidateOutputs,
      rankedOutputs,
      judge,
      nextIterationSeed,
      stopReason: summary.stopReason,
    });
    previous = nextIterationSeed;
  }

  return iterations;
}

function readOptionalJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function bestOverallOutput(
  iterations: IterationResult[],
): EvaluatedOutput | undefined {
  return bestOverallIteration(iterations)?.rankedOutputs[0];
}

function bestOverallIteration(
  iterations: IterationResult[],
): IterationResult | undefined {
  return [...iterations].sort((left, right) => {
    const leftBest = left.rankedOutputs[0];
    const rightBest = right.rankedOutputs[0];
    if (!leftBest && !rightBest) {
      return 0;
    }
    if (!leftBest) {
      return 1;
    }
    if (!rightBest) {
      return -1;
    }
    return outputSelectionScore(rightBest) - outputSelectionScore(leftBest);
  })[0];
}

function judgeFromGlobalBest(args: {
  best: EvaluatedOutput;
  bestIteration: number;
  finalJudge: Awaited<ReturnType<typeof runJudgeAgent>>;
}): Awaited<ReturnType<typeof runJudgeAgent>> {
  if (
    args.finalJudge.selectedAgentId === args.best.agentId &&
    JSON.stringify(args.finalJudge.selectedNode) ===
      JSON.stringify(args.best.outputNode)
  ) {
    return args.finalJudge;
  }
  return {
    selectedAgentId: args.best.agentId,
    selectedNode: args.best.outputNode,
    reasoning:
      `Final selection preserves global best from iteration ${args.bestIteration}: ` +
      `${args.best.agentId} with score.total=${args.best.score.total} and ` +
      `adjustedSimilarity=${args.best.score.adjustedSimilarity}. ` +
      `The last judge selected ${args.finalJudge.selectedAgentId}, but it was not the best adjusted-score output.`,
  };
}

function bestOutput(
  left: EvaluatedOutput | undefined,
  right: EvaluatedOutput | undefined,
): EvaluatedOutput | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return outputSelectionScore(left) >= outputSelectionScore(right)
    ? left
    : right;
}

function shouldPreserveElite(
  elite: EvaluatedOutput | undefined,
  currentBest: EvaluatedOutput | undefined,
): elite is EvaluatedOutput {
  if (!elite) {
    return false;
  }
  if (!currentBest) {
    return true;
  }
  return outputSelectionScore(elite) > outputSelectionScore(currentBest);
}

function seedFromElite(args: {
  elite: EvaluatedOutput;
  currentBest?: EvaluatedOutput;
}): NextIterationSeed {
  const current = args.currentBest
    ? ` Current iteration best was ${args.currentBest.agentId} at ${outputSelectionSimilarity(args.currentBest)} adjusted similarity.`
    : "";
  return {
    type: "selected-output-with-reasoning",
    node: args.elite.outputNode,
    reasoning: `Preserve global elite ${args.elite.agentId} at ${outputSelectionSimilarity(args.elite)} adjusted similarity.${current} Use this as the next seed unless a later candidate improves the adjusted selection score.`,
  };
}

function outputSelectionScore(output: EvaluatedOutput): number {
  return output.score.total;
}

function outputSelectionSimilarity(output: EvaluatedOutput): number {
  return output.score.adjustedSimilarity;
}

function iterationId(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

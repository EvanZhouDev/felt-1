import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentBackend,
  type AgentSpec,
  type CandidateArchiveOperatorStat,
  createAgentWorkspace,
  runCandidateAgent,
  runJudgeAgent,
} from "@volta/agent-sdk";
import {
  type AudioDescription,
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
  loadCandidateArchive,
  loadTargetCandidateArchive,
  mergeCandidateArchives,
  operatorFitnessStats,
} from "./archive.ts";
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

export type AudioDescriber = (
  node: Extract<InputObj["inputNode"], { type: "audio" }>,
) => Promise<AudioDescription | undefined>;

export type ExecuteRunArgs = {
  id: string;
  input: InputObj;
  output: OutputObj;
  store: RunStore;
  oracle: NeuralOracle;
  runsRoot: string;
  backend: AgentBackend;
  loop?: Partial<LoopConfig>;
  journal?: EvolutionJournal;
  candidateModel?: string;
  judgeModel?: string;
  describeAudio?: AudioDescriber;
};

export type ResumeRunArgs = Omit<ExecuteRunArgs, "input" | "output">;

const judgeSpec: Extract<AgentSpec, { role: "judge" }> = {
  role: "judge",
  id: "judge",
};

export async function executeRun(args: ExecuteRunArgs): Promise<void> {
  const backend = args.backend;
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
  const backend = args.backend;
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
    description?: AudioDescription;
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
    const iterationPath = join(
      args.runPath,
      "iterations",
      iterationId(iteration),
    );
    const stalled = isEliteStalled(iterations);
    const iterationResult = await executeIteration({
      ...args,
      iteration,
      candidateSpecs,
      previous,
      target,
      stalled,
      // Elitism: carry the reigning global best into the population as an
      // already-scored candidate so best(N+1) >= best(N) by construction. It is
      // an existing EvaluatedOutput, so re-injecting it costs zero TRIBE calls.
      elite: bestOverallOutput(iterations),
    });
    // The post-injection rank-0 IS the global elite (elitism guarantees it is
    // never displaced by something worse). Always forward it as the seed so the
    // next iteration's challengers are mutations OF the champion — the (1+lambda)
    // climber — rather than re-derivations from the judge's pick.
    const bestAfter = iterationResult.rankedOutputs[0];
    if (bestAfter) {
      iterationResult.nextIterationSeed = seedFromElite({ elite: bestAfter });
      await writeJson(
        join(iterationPath, "next-seed.json"),
        iterationResult.nextIterationSeed,
      );
    }
    const stopReason = getStopReason({
      bestNeuralSimilarity: bestAfter?.score.neuralSimilarity,
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

  // Operator-fitness curve: per-iteration best neural similarity plus the
  // archive's final operator ranking. This is the signal that answers "is the
  // discrete-operator regime plateauing?" — i.e. whether a continuous-search
  // rewrite (CMA-ES / gradient guidance) is warranted, or operator tuning still
  // climbs.
  const finalArchive = loadCandidateArchive(args.runPath);
  const finalArchiveContext = archivePromptContext(finalArchive);
  const operatorFitness = {
    perIteration: iterations.map((iteration) => ({
      iteration: iteration.iteration,
      bestNeuralSimilarity: iteration.rankedOutputs.reduce(
        (best, output) => Math.max(best, output.score.neuralSimilarity),
        Number.NEGATIVE_INFINITY,
      ),
      operators: iteration.rankedOutputs.map((output) => ({
        agentId: output.agentId,
        operator: operatorFromEntropy(output.entropy),
        neuralSimilarity: output.score.neuralSimilarity,
      })),
    })),
    ranking: finalArchiveContext?.operatorStats ?? [],
  };

  await writeJson(join(args.runPath, "evolution-journal.json"), {
    runId: args.id,
    target: targetSummary(target),
    loop: args.loop,
    stopReason: result.stopReason,
    bestScore: result.bestScore,
    bestNeuralSimilarity: result.bestNeuralSimilarity,
    operatorFitness,
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

  const description = await describeTarget(args);

  const target = {
    rendered: targetRendered,
    activation: targetActivation,
    description,
  };
  await writeJson(join(args.runPath, "target.json"), target);
  if (description) {
    await writeJson(join(args.runPath, "describe-target.json"), description);
  }
  await writeCachedTarget(args, target);
  return target;
}

// Perceptual description of an input the agent cannot read directly. Only audio
// targets are described today; the describer fails soft, so a missing or down
// service yields no description and the run proceeds on neural similarity alone.
async function describeTarget(
  args: RunLoopArgs,
): Promise<AudioDescription | undefined> {
  const node = args.input.inputNode;
  if (node.type !== "audio" || !args.describeAudio) {
    return undefined;
  }
  return args.journal.trace({
    name: "target.describe",
    input: { runId: args.id, source: node.payload.source.uri },
    run: () => args.describeAudio?.(node) ?? Promise.resolve(undefined),
    output: (description) => description ?? { skipped: true },
  });
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
  return {
    rendered,
    activation: cached.activation,
    description: cached.description,
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
  return join(args.runsRoot, "..", "target-cache", `${rendered.sha256}.json`);
}

async function executeIteration(
  args: RunLoopArgs & {
    iteration: number;
    candidateSpecs: Extract<AgentSpec, { role: "candidate" }>[];
    previous: NextIterationSeed;
    target: RunLoopResult["target"];
    stalled?: boolean;
    elite?: EvaluatedOutput;
  },
): Promise<IterationResult> {
  const iterationPath = join(
    args.runPath,
    "iterations",
    iterationId(args.iteration),
  );
  await mkdir(iterationPath, { recursive: true });
  await writeJson(join(iterationPath, "target.json"), args.target);
  const archive = mergeCandidateArchives(
    ...(args.loop.reuseTargetArchive
      ? [loadTargetCandidateArchive(args.runsRoot, args.target.rendered.sha256)]
      : []),
    loadCandidateArchive(args.runPath),
  );
  const archiveContext = archivePromptContext(archive);

  // Bandit operator selection: rank refinement operators by their measured
  // fitness in the archive (UCB over operatorStats) instead of round-robin, so
  // the N candidates this iteration draw the N best distinct operators. When the
  // global elite has stalled, widen exploration; when it is climbing, exploit.
  const operatorPlan = planOperators({
    iteration: args.iteration,
    candidateCount: args.loop.candidateCount,
    operatorStats: operatorFitnessStats(archive),
    stalled: args.stalled ?? false,
  });
  await writeJson(join(iterationPath, "operator-plan.json"), operatorPlan);

  args.store.updateStatus(args.id, "predicting");
  const candidateOutputs = await Promise.all(
    args.candidateSpecs.map(async (spec, index) => {
      const entropy = mutationStrategy({
        iteration: args.iteration,
        index,
        candidateCount: args.loop.candidateCount,
        outputType: args.output.outputType,
        operator: operatorPlan[index]?.operator,
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
            inputDescription: args.target.description,
          }),
        output: candidateSummary,
      });
    }),
  );
  await writeJson(join(iterationPath, "candidates.json"), candidateOutputs);

  args.store.updateStatus(args.id, "scoring");
  await mkdir(join(iterationPath, "scores"), { recursive: true });
  const evaluatedOutputs = await mapWithConcurrency(
    candidateOutputs,
    args.loop.scoringConcurrency,
    async (candidate) => {
      const evaluated = await evaluateCandidate({
        ...args,
        candidate,
        targetActivation: args.target.activation,
      });
      await writeJson(
        join(iterationPath, "scores", `${candidate.agentId}.json`),
        evaluated,
      );
      return evaluated;
    },
  );
  // Elitism: re-insert the reigning global elite as an already-scored member of
  // this iteration's population (zero TRIBE calls — its activation is cached).
  // This guarantees best(N+1) >= best(N): the champion can only be displaced by
  // a candidate that genuinely outscores it. The challengers are meanwhile
  // generated as mutations *of* this elite (it is the forwarded seed), so the
  // population is the (1+lambda) shape: [elite, mutate(elite), ...].
  const rankedOutputs = (
    args.elite
      ? [{ ...args.elite, agentId: "elite" }, ...evaluatedOutputs]
      : evaluatedOutputs
  ).sort((left, right) => right.score.total - left.score.total);
  await writeJson(join(iterationPath, "scores.json"), rankedOutputs);
  await appendCandidateArchive({
    runPath: args.runPath,
    iteration: args.iteration,
    rankedOutputs,
    runId: args.id,
  });
  await appendTargetCandidateArchive({
    runsRoot: args.runsRoot,
    targetSha: args.target.rendered.sha256,
    iteration: args.iteration,
    rankedOutputs,
    runId: args.id,
  });

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
      rankings: rankedOutputs.map(evaluatedOutputSummary),
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
        rankedOutputs,
        workspace: judgeWorkspace,
        inputDescription: args.target.description,
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
    rankedOutputs,
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
  const activationWithDiagnostics = attachActivationDiagnostics({
    candidate: activation,
    target: args.targetActivation,
  });
  const score = await args.journal.trace({
    name: "candidate.score",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
      targetActivation: activationSummary(args.targetActivation),
      candidateActivation: activationSummary(activationWithDiagnostics),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
    },
    run: async () =>
      scoreActivations({
        target: args.targetActivation,
        candidate: activationWithDiagnostics,
        diversity: args.candidate.entropy ? 0.75 : 0.5,
      }),
    output: scoreSummary,
  });

  return {
    ...args.candidate,
    rendered,
    activation: activationWithDiagnostics,
    score,
  };
}

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
    name: "broad gestalt genotype",
    instruction:
      "Create a first-generation candidate from the target's broad perceptual genotype: dominant energy level, attention or salience pattern, spatial/compositional feel, sensory texture, and affect. Use only anchors supported by the input.",
  },
  {
    name: "affect-energy genotype",
    instruction:
      "Create a first-generation candidate emphasizing affect and energy: calm/tense, fast/slow, dense/sparse, intimate/distant, warm/cool, certain/ambiguous. Keep concrete details sparse unless they are central to the input.",
  },
  {
    name: "sensory-texture genotype",
    instruction:
      "Create a first-generation candidate emphasizing modality-neutral sensory texture: brightness, contrast, rhythm, edge quality, surface/timbre, color or tone, and softness/sharpness.",
  },
  {
    name: "structure-space genotype",
    instruction:
      "Create a first-generation candidate emphasizing structure and space: foreground/background weight, density, symmetry/asymmetry, proximity, scale, repetition, and compositional balance.",
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

function mutationStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  outputType: OutputObj["outputType"];
  operator?: string;
}): string {
  const strategies =
    args.iteration === 1 ? coldStartStrategies : refinementStrategies;
  // The bandit (planOperators) chooses the operator for refinement iterations;
  // fall back to round-robin for the cold start (no archive history yet) or if
  // the named operator is somehow missing.
  const named = args.operator
    ? strategies.find((strategy) => strategy.name === args.operator)
    : undefined;
  const generationOffset =
    args.iteration === 1
      ? 0
      : Math.max(0, args.iteration - 2) * Math.max(1, args.candidateCount);
  const strategy =
    named ?? strategies[(generationOffset + args.index) % strategies.length];
  return [
    `iteration=${args.iteration}`,
    `strategy=${strategy.name}`,
    `outputType=${args.outputType}`,
    strategy.instruction,
    outputTypeInstruction(args.outputType),
  ].join(" | ");
}

export type OperatorPlanEntry = {
  index: number;
  operator: string;
  ucb: number;
  meanNeuralSimilarity: number | null;
  count: number;
  reason: "explore-cold" | "exploit" | "explore-untried";
};

// UCB1-style operator selection over the archive's measured operator fitness.
// Each refinement operator gets a score = exploitation (its mean neural
// similarity so far) + exploration bonus (optimistic for under-tried operators).
// The N candidates this iteration take the N best *distinct* operators, so we
// still cover N regions but bias the population toward proven winners. Untried
// operators get an optimistic prior so they are always eventually sampled —
// this is what converts the previously-ignored operatorStats into real
// selection pressure (the round-robin read none of it).
//
// Deterministic given the archive (no Math.random), so smokes stay stable.
function planOperators(args: {
  iteration: number;
  candidateCount: number;
  operatorStats: CandidateArchiveOperatorStat[];
  stalled: boolean;
}): OperatorPlanEntry[] {
  // Iteration 1 has no operator history; keep the diverse cold-start sweep.
  if (args.iteration === 1) {
    return Array.from({ length: args.candidateCount }, (_, index) => ({
      index,
      operator:
        coldStartStrategies[index % coldStartStrategies.length]?.name ??
        "broad gestalt genotype",
      ucb: 0,
      meanNeuralSimilarity: null,
      count: 0,
      reason: "explore-cold" as const,
    }));
  }

  const statsByName = new Map(
    args.operatorStats.map((stat) => [stat.operator, stat]),
  );
  const totalPlays = Math.max(
    1,
    args.operatorStats.reduce((sum, stat) => sum + stat.count, 0),
  );
  // Stall → widen exploration (bigger bonus); climbing → exploit (smaller).
  const explorationWeight = args.stalled ? 1.5 : 0.6;
  // Optimistic prior for operators with no measured fitness yet, so untried
  // operators outrank mediocre proven ones and the search keeps probing.
  const optimisticMean = bestMean(args.operatorStats) + 0.05;

  const scored = refinementStrategies.map((strategy) => {
    const stat = statsByName.get(strategy.name);
    const count = stat?.count ?? 0;
    const mean = stat ? stat.meanNeuralSimilarity : optimisticMean;
    const bonus =
      explorationWeight *
      Math.sqrt((2 * Math.log(totalPlays + 1)) / (count + 1));
    return {
      operator: strategy.name,
      ucb: mean + bonus,
      meanNeuralSimilarity: stat ? stat.meanNeuralSimilarity : null,
      count,
      reason: (stat ? "exploit" : "explore-untried") as
        | "exploit"
        | "explore-untried",
    };
  });

  // Deterministic tie-break by name so identical archives plan identically.
  scored.sort(
    (left, right) =>
      right.ucb - left.ucb || left.operator.localeCompare(right.operator),
  );

  return Array.from({ length: args.candidateCount }, (_, index) => {
    const pick = scored[index % scored.length];
    return {
      index,
      operator: pick.operator,
      ucb: pick.ucb,
      meanNeuralSimilarity: pick.meanNeuralSimilarity,
      count: pick.count,
      reason:
        index === 0 && args.stalled && pick.reason === "exploit"
          ? "explore-untried"
          : pick.reason,
    };
  });
}

function operatorFromEntropy(entropy: string | undefined): string {
  return entropy?.match(/strategy=([^|]+)/)?.[1]?.trim() ?? "unknown";
}

function bestMean(stats: CandidateArchiveOperatorStat[]): number {
  return stats.reduce(
    (best, stat) => Math.max(best, stat.meanNeuralSimilarity),
    0,
  );
}

// The global elite has stalled if the best neural similarity has not improved
// between the two most recent completed iterations. Drives wider exploration.
function isEliteStalled(iterations: IterationResult[]): boolean {
  if (iterations.length < 2) {
    return false;
  }
  const bestUpTo = (count: number): number =>
    iterations
      .slice(0, count)
      .flatMap((iteration) => iteration.rankedOutputs)
      .reduce(
        (best, output) => Math.max(best, output.score.neuralSimilarity),
        Number.NEGATIVE_INFINITY,
      );
  const previous = bestUpTo(iterations.length - 1);
  const latest = bestUpTo(iterations.length);
  return latest <= previous;
}

function outputTypeInstruction(outputType: OutputObj["outputType"]): string {
  if (outputType === "text") {
    return "For text output, encode the candidate as compact descriptive prose or comma-separated semantic units. Keep it short unless the operator explicitly asks for a syntax reset.";
  }
  if (outputType === "image") {
    return "For image output, express the operator through image-generation intent: composition, subject anchors, light/color, texture, camera/framing, and atmosphere.";
  }
  return "For code output, express the operator through renderable UI/scene structure: layout, motion/static balance, density, typography, color/contrast, texture, and interaction-free visual state.";
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
    const candidateOutputs = readOptionalJson<
      Awaited<ReturnType<typeof runCandidateAgent>>[]
    >(join(iterationPath, "candidates.json"));
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
  return iterations
    .flatMap((iteration) => iteration.rankedOutputs)
    .sort(
      (left, right) =>
        right.score.neuralSimilarity - left.score.neuralSimilarity,
    )[0];
}

function seedFromElite(args: { elite: EvaluatedOutput }): NextIterationSeed {
  return {
    type: "selected-output-with-reasoning",
    node: args.elite.outputNode,
    reasoning: `This is the reigning global neural elite (${args.elite.agentId} at ${args.elite.score.neuralSimilarity}). Treat it as the parent: preserve its high-scoring structure and mutate toward higher neural similarity.`,
  };
}

function iterationId(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

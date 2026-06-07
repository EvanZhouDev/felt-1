import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  candidateOutputs: CandidateOutput[];
  rankedOutputs: EvaluatedOutput[];
  judge: Awaited<ReturnType<typeof runJudgeAgent>>;
  nextIterationSeed: NextIterationSeed;
  stopReason?: StopReason;
};

type CandidateOutput = Awaited<ReturnType<typeof runCandidateAgent>>;

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
  return join(args.runsRoot, "..", "target-cache", `${rendered.sha256}.json`);
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
  const generatedCandidateOutputs = await Promise.all(
    args.candidateSpecs.map(async (spec, index) => {
      const entropy = mutationStrategy({
        iteration: args.iteration,
        index,
        candidateCount: args.loop.candidateCount,
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
  const candidateOutputs = expandCandidateOutputs({
    candidates: generatedCandidateOutputs,
    outputType: args.output.outputType,
    textMicroMutations: args.loop.textMicroMutations,
  });
  await writeJson(
    join(iterationPath, "generated-candidates.json"),
    generatedCandidateOutputs,
  );
  await writeJson(join(iterationPath, "candidates.json"), candidateOutputs);

  args.store.updateStatus(args.id, "scoring");
  await mkdir(join(iterationPath, "scores"), { recursive: true });
  const evaluatedCandidateOutputs = await mapWithConcurrency(
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
  const evaluatedOutputs = [...probeElites, ...evaluatedCandidateOutputs];
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
    candidate: CandidateOutput;
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
    (left, right) => right.score.neuralSimilarity - left.score.neuralSimilarity,
  );
  const recombinationProbes = await scoreTextProbeCandidates({
    ...args,
    probePath,
    probes: textProbeRecombinations(
      baseProbes,
      args.loop.textProbeRecombinations,
    ),
    idPrefix: "probe-r",
    strategy: "text-probe-recombination",
  });
  const evaluatedProbes = [...baseProbes, ...recombinationProbes];
  evaluatedProbes.sort(
    (left, right) => right.score.neuralSimilarity - left.score.neuralSimilarity,
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
        targetActivation: args.target.activation,
      });
      await writeJson(
        join(args.probePath, `${candidate.agentId}.json`),
        evaluatedOutputSummary(evaluated),
      );
      return evaluated;
    },
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

function expandCandidateOutputs(args: {
  candidates: CandidateOutput[];
  outputType: OutputObj["outputType"];
  textMicroMutations: number;
}): CandidateOutput[] {
  if (args.outputType !== "text" || args.textMicroMutations <= 0) {
    return args.candidates;
  }

  const expanded: CandidateOutput[] = [...args.candidates];
  for (const candidate of args.candidates) {
    if (candidate.outputNode.type !== "text") {
      continue;
    }
    const variants = textMicroVariants(
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

function textSlots(text: string): string[] {
  return text
    .split(",")
    .map((slot) => slot.trim())
    .filter(Boolean);
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
  outputType: OutputObj["outputType"];
  archive?: CandidateArchive;
}): string {
  const strategy = selectMutationStrategy(args);
  return [
    `iteration=${args.iteration}`,
    `strategy=${strategy.name}`,
    `outputType=${args.outputType}`,
    strategy.instruction,
    outputTypeInstruction(args.outputType),
  ].join(" | ");
}

function selectMutationStrategy(args: {
  iteration: number;
  index: number;
  candidateCount: number;
  outputType: OutputObj["outputType"];
  archive?: CandidateArchive;
}): MutationStrategy {
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

function outputTypeInstruction(outputType: OutputObj["outputType"]): string {
  if (outputType === "text") {
    return "For text output, use compact comma-separated semantic units by default: 6-8 phrase fragments, 10-18 words total, no full sentence, no labels, no proper names, no explanatory prose.";
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
  return iterations
    .flatMap((iteration) => iteration.rankedOutputs)
    .sort(
      (left, right) =>
        right.score.neuralSimilarity - left.score.neuralSimilarity,
    )[0];
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
  return left.score.neuralSimilarity >= right.score.neuralSimilarity
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
  return elite.score.neuralSimilarity > currentBest.score.neuralSimilarity;
}

function seedFromElite(args: {
  elite: EvaluatedOutput;
  currentBest?: EvaluatedOutput;
}): NextIterationSeed {
  const current = args.currentBest
    ? ` Current iteration best was ${args.currentBest.agentId} at ${args.currentBest.score.neuralSimilarity}.`
    : "";
  return {
    type: "selected-output-with-reasoning",
    node: args.elite.outputNode,
    reasoning: `Preserve global neural elite ${args.elite.agentId} at ${args.elite.score.neuralSimilarity}.${current} Use this as the next seed unless a later candidate improves the neural similarity.`,
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

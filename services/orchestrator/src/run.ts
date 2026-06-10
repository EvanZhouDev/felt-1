import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentBackend,
  type AgentSpec,
  createAgentWorkspace,
  runCandidateAgent,
  runJudgeAgent,
  type TrajectoryContext,
} from "@volta/agent-sdk";
import {
  type ActivationTrace,
  type AudioDescription,
  type EvaluatedOutput,
  type InputObj,
  type NeuralOracle,
  type NextIterationSeed,
  type OutputObj,
  type RenderedStimulus,
  scoreActivations,
} from "@volta/core";
import { type LoopConfig, normalizeLoopConfig } from "./config.ts";
import { FLUX_URI_PREFIX, type ImageGenerator } from "./imagegen.ts";
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
import {
  activationNovelty,
  buildTrajectoryContext,
  type ScoredAttempt,
  textNovelty,
} from "./trajectory.ts";

// The search loop is an OPRO-style "LLM as optimizer" with Reflexion-style
// verbal feedback (Ranked-Reflect):
//
//   each iteration:
//     1. show the candidate agents the score-sorted trajectory of past
//        attempts plus the judge's critique of the current best
//     2. ask for N new candidates that should score higher
//     3. render each candidate and score it against the target's TRIBE
//        activation (the expensive oracle calls)
//     4. re-rank including the reigning best-so-far; the judge critiques the
//        new leader, and that critique steers the next round
//
// The ranked, critiqued history is the entire steering mechanism — there are
// no hand-coded mutation operators. Stops on similarity threshold, stall
// (no improvement for STALL_PATIENCE iterations), or the iteration cap.

// Stop early when the best neural similarity has not improved for this many
// consecutive iterations — each iteration costs candidateCount oracle calls,
// so a flat trajectory is expensive to keep probing.
const STALL_PATIENCE = 3;

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
  generateImage?: ImageGenerator;
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

type StopReason = "threshold" | "stalled" | "max_iterations";

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
    const iterationResult = await executeIteration({
      ...args,
      iteration,
      candidateSpecs,
      previous,
      target,
      trajectory: buildTrajectoryContext({
        attempts: scoredAttempts(iterations),
        critique: iterations.at(-1)?.judge.reasoning,
      }),
      bestSoFar: bestOverallOutput(iterations),
      priorActivations: priorActivations(iterations),
    });
    const stopReason = getStopReason({
      iterations: [...iterations, iterationResult],
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
    // The score curve answers "is the search climbing?" at a glance: the best
    // neural similarity after each iteration plus every candidate's score.
    scoreCurve: iterations.map((iteration) => ({
      iteration: iteration.iteration,
      bestNeuralSimilarity: iteration.rankedOutputs.reduce(
        (best, output) => Math.max(best, output.score.neuralSimilarity),
        Number.NEGATIVE_INFINITY,
      ),
      candidates: iteration.rankedOutputs.map((output) => ({
        agentId: output.agentId,
        neuralSimilarity: output.score.neuralSimilarity,
        total: output.score.total,
      })),
    })),
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
    trajectory?: TrajectoryContext;
    bestSoFar?: EvaluatedOutput;
    priorActivations: ActivationTrace[];
  },
): Promise<IterationResult> {
  const iterationPath = join(
    args.runPath,
    "iterations",
    iterationId(args.iteration),
  );
  await mkdir(iterationPath, { recursive: true });
  await writeJson(join(iterationPath, "target.json"), args.target);
  if (args.trajectory) {
    await writeJson(join(iterationPath, "trajectory.json"), args.trajectory);
  }

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
          outputType: args.output.outputType,
          trajectorySize: args.trajectory?.entries.length ?? 0,
          bestNeuralSimilarity: args.trajectory?.bestNeuralSimilarity,
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
            trajectory: args.trajectory,
            candidateIndex: index,
            candidateCount: args.candidateSpecs.length,
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
  const priorTexts = trajectoryTexts(args.trajectory);
  const evaluatedOutputs = await mapWithConcurrency(
    candidateOutputs,
    args.loop.scoringConcurrency,
    async (candidate, index) => {
      const evaluated = await evaluateCandidate({
        ...args,
        candidate,
        targetActivation: args.target.activation,
        // Novelty guard: compare against everything already scored plus the
        // sibling candidates generated this round (excluding the candidate
        // itself), so near-duplicates from any source are penalized.
        noveltyPriors: [
          ...priorTexts,
          ...candidateOutputs
            .filter((_, otherIndex) => otherIndex !== index)
            .map(candidateText)
            .filter((text): text is string => Boolean(text)),
        ],
      });
      await writeJson(
        join(iterationPath, "scores", `${candidate.agentId}.json`),
        forDisk(evaluated),
      );
      return evaluated;
    },
  );
  // Re-insert the reigning best-so-far as an already-scored member of this
  // round (zero oracle calls — its activation is cached). This guarantees
  // best(N+1) >= best(N): the leader is only displaced by a candidate that
  // genuinely outscores it.
  const rankedOutputs = (
    args.bestSoFar
      ? [{ ...args.bestSoFar, agentId: "best-so-far" }, ...evaluatedOutputs]
      : evaluatedOutputs
  ).sort((left, right) => right.score.total - left.score.total);
  await writeJson(
    join(iterationPath, "scores.json"),
    rankedOutputs.map(forDisk),
  );

  args.store.updateStatus(args.id, "judging");
  const judgeWorkspace = await createAgentWorkspace({
    runsRoot: args.runsRoot,
    runId: args.id,
    iteration: args.iteration,
    agentId: judgeSpec.id,
  });
  const judge = await args.journal.trace({
    name: "judge.critique",
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
  // The next seed is always the global best (rank 0 after re-insertion) so the
  // next round refines the champion; the judge's reasoning rides along as the
  // critique shown to the next round's candidates.
  const best = rankedOutputs[0];
  const nextIterationSeed: NextIterationSeed = best
    ? {
        type: "selected-output-with-reasoning",
        node: best.outputNode,
        reasoning: judge.reasoning,
      }
    : { type: "fresh" };
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
    noveltyPriors: string[];
    priorActivations: ActivationTrace[];
  },
): Promise<EvaluatedOutput> {
  const candidate = await materializeImageNode(args);
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
    target: args.targetActivation,
  });
  const text = candidateText(candidate);
  const score = await args.journal.trace({
    name: "candidate.score",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
      targetActivation: activationSummary(args.targetActivation),
      candidateActivation: activationSummary(activationWithDiagnostics),
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: candidate.agentId,
    },
    run: async () =>
      scoreActivations({
        target: args.targetActivation,
        candidate: activationWithDiagnostics,
        diversity: combinedNovelty({
          // Surface guard: near-verbatim repeats of prior texts.
          text: text ? textNovelty(text, args.noveltyPriors) : undefined,
          // Attractor guard (issue #6): distance from where prior attempts
          // landed in TRIBE space — texts can be worded apart yet neurally
          // identical, and only this term sees that.
          activation: activationNovelty(
            activationWithDiagnostics,
            args.priorActivations,
          ),
        }),
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

// Image candidates arrive as flux:<prompt> pseudo-URIs (agents can't paint).
// Materialize them through the configured generator before render/score, and
// record the prompt on the payload so trajectories steer in prompt space.
async function materializeImageNode(
  args: RunLoopArgs & {
    iteration: number;
    candidate: Awaited<ReturnType<typeof runCandidateAgent>>;
  },
): Promise<Awaited<ReturnType<typeof runCandidateAgent>>> {
  const node = args.candidate.outputNode;
  if (
    node.type !== "image" ||
    !node.payload.source.uri.startsWith(FLUX_URI_PREFIX)
  ) {
    return args.candidate;
  }
  const prompt = node.payload.source.uri.slice(FLUX_URI_PREFIX.length).trim();
  const generate = args.generateImage;
  if (!generate) {
    throw new Error(
      `Candidate ${args.candidate.agentId} returned a flux: image but no image generator is configured (VOLTA_FLUX_URL).`,
    );
  }
  const outPath = join(
    args.runPath,
    "iterations",
    iterationId(args.iteration),
    "assets",
    `${args.candidate.agentId}.png`,
  );
  const source = await args.journal.trace({
    name: "candidate.generate-image",
    input: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
      prompt,
    },
    attributes: {
      runId: args.id,
      iteration: args.iteration,
      agentId: args.candidate.agentId,
    },
    run: () => generate({ prompt, outPath }),
    output: (ref) => ref,
  });
  return {
    ...args.candidate,
    outputNode: {
      ...node,
      payload: { ...node.payload, source, prompt },
    },
  };
}

function candidateText(candidate: {
  outputNode: EvaluatedOutput["outputNode"];
}): string | undefined {
  return candidate.outputNode.type === "text"
    ? candidate.outputNode.payload.text
    : undefined;
}

function trajectoryTexts(trajectory: TrajectoryContext | undefined): string[] {
  return (trajectory?.entries ?? []).map((entry) => entry.preview);
}

// A candidate's diversity share requires being novel on BOTH axes: a verbatim
// repeat fails the text guard even when its activation drifts; a fresh wording
// of the same neural point fails the activation guard. Min, not mean, so one
// axis can't buy back the other.
function combinedNovelty(novelty: {
  text?: number;
  activation?: number;
}): number | undefined {
  const defined = [novelty.text, novelty.activation].filter(
    (value): value is number => typeof value === "number",
  );
  if (defined.length === 0) {
    return undefined;
  }
  return Math.min(...defined);
}

// Activations of every distinct attempt so far, for the activation-space
// novelty guard. Deduped by rendered stimulus (the best-so-far is re-ranked
// into every round); attempts reloaded from disk on resume have no values and
// are skipped downstream. Same-round siblings are scored concurrently, so they
// are not in each other's priors — the text guard covers sibling collisions.
function priorActivations(iterations: IterationResult[]): ActivationTrace[] {
  const seen = new Set<string>();
  const traces: ActivationTrace[] = [];
  for (const iteration of iterations) {
    for (const output of iteration.rankedOutputs) {
      if (seen.has(output.rendered.sha256)) {
        continue;
      }
      seen.add(output.rendered.sha256);
      traces.push(output.activation);
    }
  }
  return traces;
}

function scoredAttempts(iterations: IterationResult[]): ScoredAttempt[] {
  return iterations.flatMap((iteration) =>
    iteration.rankedOutputs.map((output) => ({
      iteration: iteration.iteration,
      output,
    })),
  );
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

function getStopReason(args: {
  iterations: IterationResult[];
  iterationsCompleted: number;
  loop: LoopConfig;
}): StopReason | undefined {
  const bestNeuralSimilarity = bestOverallOutput(args.iterations)?.score
    .neuralSimilarity;
  if (
    typeof bestNeuralSimilarity === "number" &&
    bestNeuralSimilarity >= args.loop.similarityThreshold
  ) {
    return "threshold";
  }
  if (isStalled(args.iterations)) {
    return "stalled";
  }
  if (args.iterationsCompleted >= args.loop.maxIterations) {
    return "max_iterations";
  }
  return undefined;
}

// Stalled = the last STALL_PATIENCE iterations produced no improvement over
// the best that existed before them.
function isStalled(iterations: IterationResult[]): boolean {
  if (iterations.length < STALL_PATIENCE + 1) {
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
  return (
    bestUpTo(iterations.length) <= bestUpTo(iterations.length - STALL_PATIENCE)
  );
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
  if (!lastIteration) {
    throw new Error(`Run ${args.id} has no completed iterations to resume.`);
  }

  return {
    input: artifact.input,
    output: artifact.output,
    runPath: record.runPath || join(args.runsRoot, args.id),
    target: result.target,
    previous: lastIteration.nextIterationSeed,
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

function iterationId(iteration: number): string {
  return String(iteration).padStart(3, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// The full per-timestep activation matrix (~[23, 20484] for rendered text) is
// needed in memory for scoring and best-so-far carry-forward, but persisting it
// makes each scores.json tens of megabytes. Drop activation.values for disk;
// keep shape/diagnostics/summary so the artifacts stay inspectable.
function forDisk(output: EvaluatedOutput): EvaluatedOutput {
  if (!output.activation.values) {
    return output;
  }
  const { values: _values, ...activation } = output.activation;
  return { ...output, activation };
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

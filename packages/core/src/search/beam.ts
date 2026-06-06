import { scoreActivations } from "../scoring/activation.ts";
import type {
  Candidate,
  Critique,
  InputModule,
  NeuralOracle,
  OutputModule,
} from "../types.ts";

export type BeamSearchOptions = {
  iterations: number;
  beamWidth: number;
};

export async function runBeamSearch<
  TInputState,
  TPayload,
  TOutputState,
  TSeed,
>(args: {
  inputModule: InputModule<TInputState, TPayload>;
  outputModule: OutputModule<TOutputState, TSeed>;
  oracle: NeuralOracle;
  input: TPayload;
  seed: TSeed;
  options: BeamSearchOptions;
}): Promise<Candidate<TOutputState>[]> {
  const inputState = await args.inputModule.ingest(args.input);
  const renderedInput = await args.inputModule.render(inputState);
  const targetActivation = await args.oracle.encode(renderedInput.encoderInput);
  const initialState = await args.outputModule.initialize(args.seed);

  let candidates: Candidate<TOutputState>[] = [
    {
      id: "candidate-0",
      state: initialState,
    },
  ];

  for (let iteration = 0; iteration < args.options.iterations; iteration += 1) {
    const evaluated = await Promise.all(
      candidates.map(async (candidate) => {
        const rendered = await args.outputModule.render(candidate.state);
        const activation = await args.oracle.encode(rendered.encoderInput);
        const scores = scoreActivations({
          target: targetActivation,
          candidate: activation,
        });
        return {
          ...candidate,
          rendered,
          activation,
          scores,
        };
      }),
    );

    evaluated.sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0));
    const survivors = evaluated.slice(0, args.options.beamWidth);

    if (iteration === args.options.iterations - 1) {
      return survivors;
    }

    const nextStates = await Promise.all(
      survivors.map((candidate) =>
        args.outputModule.revise(candidate.state, critiqueCandidate(candidate)),
      ),
    );

    candidates = nextStates.flat().map((state, index) => ({
      id: `candidate-${iteration + 1}-${index}`,
      state,
    }));
  }

  return candidates;
}

function critiqueCandidate<TState>(candidate: Candidate<TState>): Critique {
  return {
    summary: "Initial scaffold critique.",
    directions: ["shift imagery while preserving the input's neural feel"],
    scores: candidate.scores ?? {
      neuralSimilarity: 0,
      seedAdherence: 0,
      coherence: 0,
      diversity: 0,
      total: 0,
    },
  };
}

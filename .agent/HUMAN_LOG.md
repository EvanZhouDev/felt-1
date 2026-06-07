# Human Log - Volta Optimization

## Where We Are

Branch: `codex/volta-pipeline-optimization`

Current Mona Lisa baseline:

- Old run: `c0f43ac5-9f74-437a-932b-1d7c1bdca646`
- Best similarity after 5 iterations: `0.0446379915415347`
- Target: Mona Lisa image rendered through cached short MP4, encoded by hosted TRIBE HTTP.

What changed so far:

- Added `.agent/LOG.md` for detailed experiment tracking.
- Added hosted TRIBE retry behavior and failed-run recovery from completed iteration artifacts.
- Added `bun run probe:texts`, a cheap text-candidate scorer that reuses a saved target activation.
- Ran an 8-text calibration probe. The old best text still won. More literal Mona Lisa descriptions did not improve the score.
- Replaced generic entropy strings with explicit candidate mutation strategies so parallel candidates should be meaningfully different.

## Research Notes

Useful AlphaEvolve idea:

- AlphaEvolve is not just "ask an LLM for a better answer." It keeps a program database, samples parent programs plus inspirations into prompts, evaluates candidates with automatic metrics, and registers scored results back into the database. Source: [Google DeepMind AlphaEvolve blog](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) and [AlphaEvolve white paper](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/AlphaEvolve.pdf).

Useful MAP-Elites idea:

- Do not keep only one global best. Keep best candidates per behavior/style cell, because diversity can make the global search better and reveal which kinds of outputs work. Source: [Mouret and Clune, "Illuminating search spaces by mapping elites"](https://arxiv.org/abs/1504.04909).

Useful novelty-search idea:

- Ambitious objectives can be deceptive; direct hill-climbing toward the final score may get stuck. Maintain novelty/diversity pressure so the system explores genuinely different regions before exploiting. Source: [Lehman and Stanley, "Novelty Search and the Problem with Objectives"](https://www.cs.swarthmore.edu/~meeden/DevelopmentalRobotics/lehmanNoveltySearch11.pdf).

Useful CMA-ES idea:

- For continuous knobs, sample from a distribution and adapt it from successful candidates. Volta's current text search is not naturally continuous, but the same principle applies to tunable strategy weights, text length, factuality, concreteness, and mutation intensity. Source: [CMA-ES overview](https://cma-es.github.io/).

## Current Working Hypothesis

The system should stop behaving like:

```text
best text -> rewrite best text -> rewrite best text
```

and move toward:

```text
archive of scored candidates
  -> sample best + diverse inspirations
  -> generate strategy-specific children
  -> score
  -> update archive
```

For this repo, the next practical implementation should be:

- Cache target activations so parameter experiments do not re-encode Mona Lisa.
- Store a compact candidate archive per run.
- Feed candidates a small set of top and diverse prior outputs, not only the single last winner.
- Add behavior descriptors for text outputs: length bucket, named-entity usage, object-list vs prose, visual/emotional/style emphasis.
- Use the archive to select parent/inspiration context for each mutation strategy.

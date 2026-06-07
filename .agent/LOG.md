# Volta Pipeline Optimization Log

## 2026-06-06 17:21 PDT - Baseline and Goal

- Goal: make the Volta loop converge toward high TRIBE neural similarity efficiently, using Mona Lisa image-to-text as the first proving run, aiming for about 0.9 similarity within roughly 10 iterations and no more than 20.
- Prior baseline from `/Users/evan/Desktop/project-volta`: run `c0f43ac5-9f74-437a-932b-1d7c1bdca646`, remote TRIBE HTTP, image target with cached video, Codex candidates, five iterations.
- Prior best: iteration 4, `candidate-a`, neural similarity `0.0446379915415347`, total score `0.1937465940790743`; the run remained far from `0.9`.
- The initial Mona Lisa target embedding was saved and reused in the old run at `/var/folders/gy/pplhy6xj63l_7f09587mc3900000gn/T/tmp.IchrK0iOvZ/runs/c0f43ac5-9f74-437a-932b-1d7c1bdca646/target.json`.
- This checkout is set up: `bun install`, `bun run check`, `bun run smoke`, `bun run setup:tribe`, and a TRIBE Python import sanity check all passed.
- Current checkout has the descriptive-text prompt fix, but does not yet have the old thread's retry/recovery patches or run visualizer.

Immediate hypotheses:

- Need controlled run tooling before spending real TRIBE/Codex cycles.
- Need robust HTTP TRIBE retry and failed-run recovery so long runs do not waste progress.
- Need richer candidate feedback than "previous selected output + judge reasoning"; agents should see best score, score trend, negative examples, and explicit mutation strategies.
- Need better candidate diversity than `entropy-iteration-index`.
- Need to test whether 0.9 cross-modal image-to-text similarity is even calibrated as reachable; if not, we need to identify the ceiling and avoid optimizing against an impossible target.

## 2026-06-06 17:26 PDT - Robustness Pass 1

Changes in progress:

- Ported HTTP TRIBE retry behavior for transient hosted failures: server restart while job was in flight, resubmitted job messages, and 502/503/504 responses.
- Ported failed-run resume support: the API can resume `failed` runs, and resume can prefer completed per-iteration disk artifacts when `run.json` is stale.

Expected effect:

- Long multi-iteration runs should no longer lose all progress when the hosted TRIBE service restarts mid-score.
- Recovery should continue from the last complete iteration instead of repeating already scored iterations.

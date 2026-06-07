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

Validation:

- `bun run check` passed.
- `bun run smoke` passed.

## 2026-06-06 17:28 PDT - Text Candidate Calibration 1

Added `bun run probe:texts` for scoring arbitrary text probes against a saved target activation without running candidate agents or re-encoding the target.

Probe:

- Target: saved Mona Lisa activation from old run `c0f43ac5-9f74-437a-932b-1d7c1bdca646`.
- Oracle: hosted TRIBE HTTP.
- Texts: 8 hand-written candidates in `.agent/probes/mona-lisa-texts-v1.json`.

Results:

- Best: `prior-best-iteration-4`, neural similarity `0.0446379915415347`.
- Runner-up: `object-list`, neural similarity `0.03276093506673319`.
- Direct title/name description performed poorly: `literal-title` scored `-0.1353451610439663`.
- Literal captions and museum-label prose also failed to beat the old best.

Interpretation:

- Plain semantic accuracy is not enough. The old best seems to have landed on a text style TRIBE likes better than more factual Mona Lisa captions.
- The next search strategy should use larger parallel variation and explicit mutation styles rather than only refining toward a "better description."
- We should add score-history feedback and mutation strategies to candidate prompts before spending on another full Codex+TRIBE loop.

## 2026-06-06 17:33 PDT - Mutation Strategy Pass 1

Changes in progress:

- Replaced generic `entropy-N-M` candidate cues with explicit mutation strategies:
  prior-best-preserving edit, compact visual inventory, spatial composition pass, affect/energy pass, texture/color pass, and negative-control escape.
- Updated candidate prompts to treat refinement as score-driven neural search, not simple description polishing.
- Updated judge prompts to return optimizer-style reasoning: keep/discard/next mutation plus score references.

Expected effect:

- Parallel candidates should explore different text styles instead of converging into near-duplicate portrait prose.
- The next seed should carry more actionable feedback into the following generation.

Validation:

- Initial `bun run check` caught JSON formatter drift in probe reports; fixed with Biome format.
- `bun run check` passed after formatting.
- `bun run smoke` passed with the new mutation cues; selected `candidate-b` in the mock run, which is acceptable because the smoke asserts judge selection follows ranking rather than a fixed candidate id.

## 2026-06-06 17:39 PDT - Search Algorithm Research Pass

User nudge: research existing genetic/evolutionary algorithms, including AlphaEvolve, and optionally create a human-readable log.

Sources checked:

- Google DeepMind AlphaEvolve blog and white paper.
- MAP-Elites paper by Mouret and Clune.
- Novelty Search paper by Lehman and Stanley.
- CMA-ES reference site.

Takeaways:

- AlphaEvolve's important pattern for Volta is a scored archive/database plus prompt sampling from parent and inspiration candidates, not one-winner-only refinement.
- MAP-Elites suggests keeping elite outputs per behavior/style cell so exploration survives while still improving quality.
- Novelty search is relevant because the 0.9 objective may be deceptive or poorly calibrated; we should preserve diverse candidates even when they are not immediate score winners.
- CMA-ES is less directly applicable to raw text, but useful for tunable strategy distributions and mutation strengths.

Added `.agent/HUMAN_LOG.md` with a readable summary and source links.

## 2026-06-06 17:43 PDT - Target Activation Cache

Changes in progress:

- Added a target activation cache under `<runsRoot>/../target-cache/<renderedSha>.json`.
- `buildTarget` now renders the target first, checks the cache by rendered stimulus hash, and reuses the cached activation if present.
- On cache hit, the run still writes its own `target.json` with the current rendered target plus cached activation.

Expected effect:

- Repeated parameter experiments for the same Mona Lisa target should not re-encode the target video.
- This is a general optimization for any repeated stable input target, not a Mona Lisa special case.

Validation:

- `bun run smoke` passed.
- Initial `bun run check` found one formatting wrap in `run.ts`; fixed with Biome format.
- `bun run check` passed after formatting.

## 2026-06-06 17:49 PDT - Candidate Archive Pass 1

Changes in progress:

- Added a persisted per-run `candidate-archive.json`.
- Archive entries track iteration, agent id, neural similarity, total score, output type, compact text, and behavior descriptors.
- Behavior keys currently bucket text outputs by length, sentence style, proper-name usage, and emphasis style.
- Candidate prompts now receive compact top/diverse/recent archive slices when available.

Expected effect:

- The loop can exploit top candidates without losing diversity.
- Later iterations should have evidence beyond the single selected previous seed.
- This is the first concrete step toward an AlphaEvolve/MAP-Elites-style candidate database.

## 2026-06-06 17:56 PDT - Progress Tracking Moved to Notion

User requested that the human-readable progress log live in Notion instead of `.agent/HUMAN_LOG.md`.

Actions:

- Updated Notion page `3789a760-ad80-80e6-bfa0-eacbb8cab5b8` with the current progress summary via `ntn pages update`.
- Removed `.agent/HUMAN_LOG.md` from the branch to avoid maintaining two human-facing logs.
- Kept `.agent/LOG.md` as the detailed local experiment/audit log.

Validation:

- `bun run smoke` passed with archive wiring.
- Initial `bun run check` found formatter drift in `archive.ts`; fixed with Biome format.
- `bun run check` passed after formatting.
- Smoke artifact wrote `candidate-archive.json` with 4 entries across the two smoke iterations.

## 2026-06-06 18:00 PDT - Bounded Real Run 1 Exposed Scoring Observability Bug

Run attempted:

- Run id: `353ee43a-86b2-45d4-823b-efaa43747d04`
- Hosted TRIBE HTTP, Codex backend, Mona Lisa cached target, 4 candidates, 2 max iterations.
- Target cache worked: run moved quickly into `predicting`, then `scoring`.
- Candidate diversity improved: generated compact inventory, spatial composition, affect/energy, and restrained portrait candidates.

Problem:

- Run stayed in `scoring` after remote TRIBE queue cleared.
- No `scores.json` existed because the code only writes scores after all candidates finish.
- This creates all-or-nothing scoring observability and wastes recoverable partial progress.

Changes in progress:

- Added 30s bounded fetches around hosted TRIBE submit, job polling, artifact fetch, and prediction download.
- Marked timeout/abort errors as retryable for the existing HTTP retry loop.
- Added per-candidate score snapshots under `iterations/<NNN>/scores/<agent>.json` immediately after each candidate finishes scoring.

Validation:

- `bun run check` passed.
- `bun run smoke` passed.
- Smoke artifacts include per-candidate score snapshots for both iterations.

## 2026-06-06 18:05 PDT - Salvaged Candidate Probe From Stuck Run

Instead of launching new Codex generations, salvaged the four generated candidates from stuck run `353ee43a-86b2-45d4-823b-efaa43747d04` and scored them sequentially with `bun run probe:texts`.

Results:

- `candidate-b` compact visual inventory: `0.017743644507674988`.
- `candidate-a` restrained portrait prose: `-0.011906040739213029`.
- `candidate-d` affect/energy prose: `-0.024936240237532242`.
- `candidate-c` spatial composition prose: `-0.08631622091198896`.

Interpretation:

- Mutation strategies produced meaningfully different text forms, but none beat the old best `0.0446379915415347`.
- Compact inventory is promising relative to the other fresh candidates, but still not enough.
- New runs should not start from an empty archive for the same target. We need a target-specific archive or imported prior elite so repeated experiments exploit known good candidates immediately.

## 2026-06-06 18:09 PDT - Target-Specific Archive Pass

Changes in progress:

- Extended candidate archives with optional `runId`.
- Added target-specific archives under `<runsRoot>/../target-archives/<targetSha>.json`.
- Candidate prompts now merge target-specific archive entries with the current run archive.
- New scored candidates append to both the run archive and the target archive.

Expected effect:

- Repeated experiments on the same target can reuse prior elites immediately.
- Mona Lisa experiments can begin with the known `0.0446379915415347` text in context instead of rediscovering it.
- This is closer to AlphaEvolve's persistent program database, but scoped by target hash to avoid cross-target contamination.

Validation:

- `bun run smoke` passed.
- Initial `bun run check` found formatter drift in `archive.ts`; fixed with Biome format.
- `bun run check` passed after formatting.
- Smoke artifact created a target-specific archive with 4 entries and `runId: smoke-run`.

## 2026-06-06 18:12 PDT - Cold-Start Strategy Probe

User clarified that warm target-specific archives are only diagnostic; the system
must converge from scratch in roughly 10 turns.

Cold-start boundary:

- Used an isolated absolute runs root with only the cached target activation.
- No target candidate archive was present.
- Run `26b8e0d3-5b07-4aa1-81f5-f565645974f1`, 4 candidates, 1 scored iteration
  before cutting off the weak second iteration.

Cold run v1 results:

- `candidate-c`: `-0.002558308172464763`.
- `candidate-a`: `-0.035465723040737605`.
- `candidate-d`: `-0.060632256759209385`.
- `candidate-b`: `-0.08662212833950082`.

Interpretation:

- Generic visual description, scene graph, and object inventory are bad
  first-turn strategies for this cross-modal target.
- The judge would have refined a weak spatial-composition seed, so the initial
  strategy schedule was steering the loop into a low-value basin.

Small-scale probe:

- Added `.agent/probes/mona-lisa-cold-strategy-v2.json`.
- Scored 8 hand-authored strategy probes with `bun run probe:texts` and hosted
  TRIBE.
- Best probe: `affect-low-motion` scored `0.0731565229976215`, beating the
  previous known warm-run best `0.0446379915415347` without using old candidate
  state.
- Runner-up: `minimal-neural-caption` scored `0.03222768091373522`.
- Worst: `scene-graph-plain` scored `-0.15589541680958133`.

Changes:

- Split mutation schedules into cold-start strategies and refinement strategies.
- Cold-start now prioritizes affect-state vectors, minimal neural captions,
  surface/light/texture, perceptual gestalt, warm/cool contrast, and anti-literal
  probes.
- Candidate prompt now tells first-pass text agents to favor perceptual-state
  language over exhaustive object inventory.

Validation so far:

- `bun run check` passed.
- `bun run smoke` passed.
- Real 4x1 cold-start run
  `5769ab19-49b7-464b-b74a-2905ec4696bb` completed under
  `.volta/cold-strategy-v2`.

Real run after strategy patch:

- `candidate-a` affect-state vector: `0.03525156767633251`.
- `candidate-d` global perceptual gestalt: `-0.029479720295879096`.
- `candidate-b` minimal neural caption: `-0.07253182191582468`.
- `candidate-c` surface/light/texture: `-0.0818080272110829`.

Interpretation:

- The implemented schedule improved the live cold-start batch from
  `-0.002558308172464763` best to `0.03525156767633251` best.
- It still did not reproduce the manual `affect-low-motion` probe at
  `0.0731565229976215`.
- Next likely improvement: make cold-start generation score-calibrated with
  positive/negative style exemplars or evolve the mutation prompts themselves,
  as in PromptBreeder/APE, instead of relying only on abstract strategy names.

## 2026-06-06 18:20 PDT - Minimal Caption Cold-Start Breakthrough

Follow-up change:

- Tightened the first cold strategy to explicitly ask for the phrase-cloud
  format that the manual probe suggested.
- Ran a new isolated cold-start test with only target activation cache and no
  candidate archive.
- Run id: `27639b41-00d8-4dce-b444-44f97e8339e5`.

Generated candidates:

- `candidate-a`, affect phrase cloud:
  `The feeling is stillness, fixed attention, low warm restraint, suspended ambiguity, intimate distance, hushed air, soft green-gold light, aged varnish texture, composed upright posture, a woman held in quiet reserve.`
- `candidate-b`, minimal neural caption:
  `A quiet half-smile in warm dim light, still hands, distant mist, soft gaze, aged texture, hushed ambiguity.`

Results:

- `candidate-b`: `0.14318439748392836`.
- `candidate-a`: `0.003292393616047465`.
- `candidate-d`: `-0.005547407216969007`.
- `candidate-c`: `-0.07748413342606966`.

Interpretation:

- The active ingredient is not the phrase-cloud prefix itself. The high-scoring
  pattern is a very short caption-like phrase set that combines one or two
  target anchors with light, stillness, distance/air, texture, and ambiguity.
- This is the first true cold first-turn run to beat both the old 5-iteration
  baseline (`0.0446379915415347`) and the manual probe (`0.0731565229976215`).
- Promoted `minimal neural caption` to the first cold-start strategy and
  tightened its instruction to 10-18 comma-separated words. This should help
  small candidate counts as well as 4-agent runs.

## 2026-06-06 18:30 PDT - Caption Population 4x2 Run

Problem:

- The minimal-caption strategy was high variance. A later 4x3 test produced only
  `0.04139772892407319` in iteration 1 and collapsed to `0.002353006227135108`
  in iteration 2, so a single short-caption slot was not robust enough.

Change:

- Made the first four cold-start strategies all 10-18 word caption variants:
  expression/light, affect/air, texture/color, and posture/depth.
- Made the first four refinement strategies preserve 10-18 word
  comma-separated captions: score-preserving edit, crossover, ablation, and
  affect intensity.

Real cold test:

- Run id: `6d78538a-99ae-4db4-a770-2f2e722dc950`.
- Boundary: isolated runs root, target activation cache only, no preseeded
  target candidate archive.
- Loop: 4 candidates x 2 iterations.

Iteration 1:

- `candidate-b`: `0.25988236470169435`.
- `candidate-a`: `0.09221710678432093`.
- `candidate-c`: `0.012898474085625677`.
- `candidate-d`: `0.010483963859717615`.
- Winning text: `warm stillness, held attention, quiet face, heavy air, near distance, softened ambiguity`.

Iteration 2:

- `candidate-b`: `0.3656164165710571`.
- `candidate-a`: `0.3318511489960349`.
- `candidate-c`: `0.28106761268685615`.
- `candidate-d`: `0.19991621105623367`.
- Winning text: `warm hush, held gaze, quiet face, heavy amber-green air, close distance, folded hands, softened uncertainty`.

Interpretation:

- This is the first robust cold convergence curve: `0.25988236470169435` on
  turn 1 to `0.3656164165710571` on turn 2.
- All iteration-2 candidates were positive and two exceeded `0.33`, so the
  caption-preserving refinement policy is working.
- The path is still far below `0.9`, but we now have a real search direction
  worth scaling to more turns.

## 2026-06-06 18:39 PDT - Elite Preservation Patch

Resume experiment:

- Resumed run `6d78538a-99ae-4db4-a770-2f2e722dc950` for additional turns.
- Iteration 3 regressed: best `0.2628201513071159`.
- Iteration 4 also regressed: best `0.2565110465731476`.
- The global best remains iteration 2 `candidate-b` at
  `0.3656164165710571`.

Issue:

- The pipeline used the latest judge-selected seed for the next iteration even
  when that iteration underperformed the global best.
- This lets search walk away from a good elite after a local regression.
- Final reporting already kept the best overall output, but future turns did not
  necessarily seed from it.

Change:

- `bestOverallOutput` now ranks by `score.neuralSimilarity`, not total score.
- Stop checks use the best neural similarity seen so far.
- After a regression, the loop overwrites `next-seed.json` and the in-memory
  `nextIterationSeed` with the global neural elite.
- Resume now starts from the global neural elite across completed iterations
  instead of blindly using the last iteration seed.

Validation:

- `bun run check` passed.
- `bun run smoke` passed.

Next:

- Run a fresh bounded cold run with the caption population plus elite
  preservation. The expected behavior is that later turns do not drift away from
  a high-scoring iteration-2-style caption.

## 2026-06-06 18:47 PDT - Fresh Elite-Preserved 4x4 Run

Run:

- Run id: `738e1334-f9b2-4105-a08e-573c1de321b2`.
- Boundary: isolated runs root, target activation cache only, no preseeded
  candidate archive.
- Loop: 4 candidates x 4 iterations.

Scores by iteration:

- Iteration 1 best: `0.3400386823277736`.
- Iteration 2 best: `0.4447056855600945`.
- Iteration 3 best: `0.30969653102678785`.
- Iteration 4 best: `0.42138055417989095`.

Best text:

`warm stillness, suspended attention, heavy air, close distance, shadowed face, unreadable calm`

Elite preservation check:

- Iteration 3 regressed below the iteration-2 elite.
- `iterations/003/next-seed.json` was overwritten with the iteration-2 elite.
- Iteration 4 was generated from the elite and recovered to `0.42138055417989095`.
- Final `run.json` reports `bestNeuralSimilarity: 0.4447056855600945` and
  carries the elite-preservation reasoning in `nextIterationSeed`.

Interpretation:

- Caption population + elite preservation gives a credible from-scratch curve:
  `0.3400 -> 0.4447` in 2 turns, then a regression and partial recovery.
- We still need a way to push past the `0.44` local basin. Tiny phrase swaps are
  now conservative enough to avoid collapse, but not exploratory enough to break
  through.
- Next likely knob: add a small number of more aggressive but still compact
  mutation strategies around the elite, such as replacing one semantic axis
  (face/gaze, air/distance, warmth/shadow, texture/surface) while preserving
  caption length.

## 2026-06-06 18:58 PDT - Axis-Swap Refinement Test

Change:

- Replaced the first refinement slots after the score-preserving edit with
  explicit compact axis swaps:
  - face/gaze/expression/attention,
  - air/distance/depth/haze/atmosphere,
  - warmth/color/light/shadow.
- Kept every strategy constrained to 10-18 comma-separated words.

Run:

- Continued run `738e1334-f9b2-4105-a08e-573c1de321b2` for iterations 5 and 6.
- Seed was the global elite:
  `warm stillness, suspended attention, heavy air, close distance, shadowed face, unreadable calm`.

Results:

- Iteration 5 best: `0.36235703287684884`.
- Iteration 6 best: `0.33658293434128994`.
- Global best remains iteration 2 `candidate-a` at `0.4447056855600945`.

Interpretation:

- Axis swaps preserve decent quality but did not break the `0.44` local basin.
- The best mutation so far already looks like a compact affect/atmosphere code.
  Further single-axis replacements mostly degrade it.
- Next likely mechanism should be more global than phrase swapping: either
  calibrate a small local phrase library by probing individual cue substitutions,
  or add a deterministic micro-search around the best caption's slots instead of
  relying only on Codex-generated one-shot children.

## 2026-06-06 19:02 PDT - Caption Slot Micro-Search Partial

Probe:

- Added `.agent/probes/mona-lisa-caption-microsearch-v1.json`.
- Goal: score one-slot substitutions around the current elite caption before
  spending on more full agent turns.
- Elite baseline reproduced at `0.444706`.

Partial results before hosted TRIBE failed with `[Errno 24] Too many open files`:

- `dense-air`: `0.460126` — first observed text to beat the `0.4447056855600945`
  elite.
- `private-uncertainty`: `0.388255`.
- `old-air`: `0.374872`.
- `veiled-face`: `0.362357`.
- `quiet-face`: `0.358556`.
- `held-attention`: `0.353134`.
- `near-distance`: `0.344863`.
- `softened-ambiguity`: `0.251761`.
- `green-gold-haze`: `0.213208`.
- `fixed-attention`: `0.187181`.
- `warm-hush`: `0.181977`.
- `amber-hush`: `0.162105`.
- `intimate-distance`: `0.137337`.

Failed remaining probes:

- `folded-hands`.
- `quiet-face-softened-ambiguity`.

Tooling fix:

- `probe:texts` now writes the output report incrementally after each scored
  probe.
- If a later probe fails, it writes a `status: "failed"` report with the error
  and any completed results instead of losing all progress.

Interpretation:

- The best local improvement was a single slot replacement:
  `heavy air` -> `dense air`.
- This supports the user's suggestion to introduce new structured entropy, but
  at the slot-library level rather than broad free-form randomness.
- Hosted TRIBE is currently returning file-descriptor failures despite healthy
  `/health`, so pause real scoring briefly before retrying the remaining probes
  or Yeo-7 diagnostics.

## 2026-06-06 19:12 PDT - Course Correction Toward Generic Evolution

Problem:

- The previous slot-search direction was useful experimentally, but it was too
  close to optimizing directly for the Mona Lisa caption basin.
- The system objective is now explicitly generic: improve the Volta pipeline for
  any input/output pairing, using Mona Lisa as one benchmark rather than as the
  algorithm's hidden target.

Changes:

- Replaced Mona-specific refinement language with medium-neutral evolutionary
  operators in the orchestrator:
  - broad first-generation genotypes,
  - elitist point mutation,
  - generic semantic-unit mutation,
  - elite crossover,
  - ablation,
  - novelty injection,
  - diagnostic-axis correction,
  - representation reset.
- Added `outputType=...` to entropy/operator strings, with separate guidance for
  text, image, and code outputs.
- Added operator lineage (`entropy`) to the candidate archive so the archive is
  closer to an evolutionary population, not just a string memory.
- Generalized archive behavior descriptors away from Mona-specific vocabulary
  into spatial / affect / sensory / concrete buckets.
- Added `probe:evolve-texts` for cheap, generic text-population generation from
  scored parents.
- Added `probe:yeo` as an auxiliary Yeo-7 diagnostic probe. It is deliberately
  sidecar-only: Yeo deltas can guide mutation axes later, but full-vector TRIBE
  cosine remains the scorer.
- Added `smoke:generic`, covering mock text-to-text, text-to-image, and
  image-to-code runs through the same operator schedule.

Cheap experiment:

- Seeded `.agent/probes/generic-text-parents-v1.json` with three non-Mona text
  parents.
- Ran `probe:evolve-texts` to produce
  `.agent/probes/generic-text-evolution-v1.json`.
- First version over-produced mutations from the top parent before crossover or
  novelty under a low child limit. Fixed the generator to round-robin both
  operator families and parents.
- Current 24-child output includes elites, unit mutations, crossovers,
  axis-injections, syntax resets, and ablations across all parents.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed for:
  - text-to-text,
  - text-to-image,
  - image-to-code.

TRIBE status:

- Hosted `/health` is still `ok`, but latest `/list-jobs` entries remain failed
  with `[Errno 24] Too many open files`.
- Do not spend more hosted scoring compute until the latest job history shows a
  successful fresh job or the service is restarted.

## 2026-06-06 19:17 PDT - Scorer Concurrency Control

Problem:

- The pipeline can run multiple candidate agents per iteration, but scoring used
  `Promise.all`, which submits all candidate evaluations to the oracle at once.
- For a genetic/evolutionary search this couples population size to oracle load.
  That is bad for hosted TRIBE and likely contributed to the file-descriptor
  failure mode.

Change:

- Added `loop.scoringConcurrency` and `VOLTA_SCORING_CONCURRENCY`.
- Default is `1`, so hosted TRIBE scoring is serialized unless explicitly
  raised.
- Candidate population size remains controlled separately by
  `VOLTA_CANDIDATE_COUNT`.
- Updated architecture/config docs to describe evolutionary operators rather
  than target-specific random entropy.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This makes the generic evolutionary algorithm safer to scale: we can explore
  a larger population without automatically creating concurrent oracle pressure.

## 2026-06-06 19:20 PDT - Cold-Start Archive Hygiene

Problem:

- Target-specific candidate archives are useful for warm-start experiments, but
  they make "10 turns from scratch" ambiguous.
- The generic algorithm should be testable without borrowing old target-specific
  candidates.

Change:

- Added `loop.reuseTargetArchive` and `VOLTA_REUSE_TARGET_ARCHIVE`.
- Default is `false`, so new runs use only their local run archive unless a
  warm-start experiment explicitly opts in.
- The pipeline still writes target archives for later analysis or explicit warm
  starts.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This keeps future Mona Lisa, text, image, or audio benchmarks honest: a cold
  run is really cold unless the experiment intentionally enables old-state
  reuse.

## 2026-06-06 19:24 PDT - Generic Smoke Adds Image-to-Image

Change:

- Added an `image-to-image` scenario to `smoke:generic`.
- Updated `docs/IO_MODULES.md` so the live API notes match the new scorer
  throttle: TRIBE text scoring is not batched, and evaluation concurrency is
  controlled by `loop.scoringConcurrency`.

Verification:

- `bun run check` passed.
- `bun run smoke:generic` passed with four scenarios:
  - text-to-text,
  - text-to-image,
  - image-to-code,
  - image-to-image.
- `bun run smoke` passed.

Interpretation:

- This is still mock-oracle coverage, not a real Flux/TRIBE image-to-image
  success. It does make the generic operator schedule exercise the image output
  path explicitly while hosted scoring is unhealthy.

## 2026-06-06 19:27 PDT - Operator Cycling for Small Populations

Problem:

- With `candidateCount=2`, refinement turns previously reused the first two
  refinement operators every generation.
- That means crossover, novelty injection, ablation, and representation reset
  could be skipped forever unless the population was large.

Change:

- The mutation/operator scheduler now offsets by iteration and candidate count.
- A small population rotates through the full operator list across turns instead
  of repeatedly sampling only the first operators.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This is a better default for 10-turn convergence: even two candidates per turn
  can cover multiple evolutionary operator families over time.

## 2026-06-06 19:30 PDT - Operator Fitness Feedback

Problem:

- The archive preserved candidate scores and behavior keys, but did not summarize
  which evolutionary operators were actually producing useful children.
- Without that, the next generation could see good examples but not whether
  mutation, crossover, novelty, ablation, or representation reset was working.

Change:

- Added `operatorStats` to the archive prompt context.
- Stats include operator name, sample count, best neural similarity, and mean
  neural similarity.
- Operator names are parsed from the entropy/operator lineage already attached
  to candidates.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This makes the archive more like a real evolutionary journal. Future agents can
  adapt based on operator performance instead of treating all archive entries as
  undifferentiated examples.

## 2026-06-06 19:32 PDT - Operator-Fitness Exploit Child

Change:

- Added a refinement operator named `operator-fitness exploit`.
- This child reads archive `operatorStats`, identifies the strongest operator
  family so far, and deliberately generates another child in that family while
  preserving the current elite.
- If there are no stats, it falls back to conservative point mutation.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This makes the operator stats actionable. The search now mixes fixed
  operator cycling with an adaptive exploitation slot.

## 2026-06-06 19:36 PDT - Yeo-7 Sidecar Diagnostics in HTTP Oracle

Change:

- `HttpTribeOracle` now fetches each completed job's `result.json` after the
  full-vector prediction download.
- If `yeo7_means` are present, they are attached to `ActivationTrace.diagnostics`.
- Candidate evaluation attaches `yeo7DeltaFromTarget` when both target and
  candidate activations have Yeo means.
- Observability summaries include diagnostics, so the judge can see them through
  ranked candidate summaries.

Important boundary:

- Yeo-7 diagnostics do not replace scoring.
- `scoreActivations` still uses the full activation vector for cosine.
- If `result.json` is unavailable, scoring continues without diagnostics.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This is the safest version of the user's Yeo hypothesis: expose Yeo deltas as
  mutation-axis hints without spending extra TRIBE jobs or letting 7 scalar means
  override full-vector fitness.

## 2026-06-06 19:44 PDT - Seed-Constrained Text-to-Text Benchmark

Problem:

- A text-to-text target can become an identity/paraphrase test if the output is
  allowed to stay on the same topic.
- For vibe transfer, the seed should force a new topic while TRIBE scoring
  preserves the target's emotional/perceptual activation feel.

Change:

- Updated `smoke:generic` text-to-text scenario:
  - target: `A terse paragraph with cold urgency and clipped rhythm.`
  - seed: write about a dog while preserving emotional pressure, pace, and
    perceptual feel.
- The smoke now asserts that generated text candidates preserve the `dog` seed
  topic.
- Candidate prompts now explicitly tell same-medium transfers not to copy or
  paraphrase the target, but to translate the target activation feel into the
  seed topic.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Interpretation:

- This makes the cheap text-to-text benchmark closer to real Volta behavior:
  preserve the vibe, change the subject.

## 2026-06-06 19:57 PDT - Cold Benchmark Harness and Hosted TRIBE Canary

Change:

- Added `benchmark:cold`, a generic cold-start benchmark runner with selectable
  scenarios, oracle, backend, iteration count, population size, scoring
  concurrency, output path, and archive reuse.
- Default scenarios now cover:
  - seeded text-to-text dog topic transfer,
  - Mona Lisa image-to-text,
  - Mona Lisa image-to-image.
- The benchmark runner defaults to `reuseTargetArchive: false` so cold-start
  claims do not silently depend on old target-specific state.
- Cleaned the deterministic backend so benchmark/smoke candidates are renderable
  artifacts derived from the seed, target type, and assigned evolutionary
  operator. It no longer sends orchestration prompt scaffolding to the scorer as
  candidate text.

Hosted TRIBE status:

- Ran a one-job hosted text canary. Job `f3c4b91d1fea` completed in `15.846s`
  and returned both `preds.norm.f16.bin` and Yeo-7 diagnostics.
- Hosted TRIBE is not down, so I did not switch to local TRIBE.
- It remains throughput-sensitive: the first hosted benchmark after recovery had
  one job take `62.6s`, but it completed.

Benchmarks:

- Mock deterministic cold benchmark before deterministic cleanup:
  `.agent/benchmarks/generic-cold-mock-v1.json`
  - seeded text-to-text dog: `0.20840908636117636`
  - Mona image-to-text: `0.35019456831731827`
  - Mona image-to-image: `0.16876461011322388`
- Hosted deterministic seeded text benchmark before cleanup:
  `.agent/benchmarks/seeded-text-http-canary-v1.json`
  - best neural similarity: `-0.0005951459978818529`
  - candidate text was prompt scaffolding, not a clean artifact.
- Mock deterministic cold benchmark after cleanup:
  `.agent/benchmarks/generic-cold-mock-v3.json`
  - seeded text-to-text dog: `0.5231534937960899`
  - Mona image-to-text: `0.3397067159480239`
  - Mona image-to-image: `0.2745577349508502`
- Hosted deterministic seeded text benchmark after cleanup:
  `.agent/benchmarks/seeded-text-http-v2.json`
  - best neural similarity: `0.08418220497384195`
  - selected candidate:
    `A dog moves through terse paragraph cold urgency clipped rhythm, with broad steady attention`

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.
- `bun run benchmark:cold -- --backend deterministic --oracle mock --max-iterations 2 --candidate-count 3 --out .agent/benchmarks/generic-cold-mock-v3.json`
  passed.
- `bun run benchmark:cold -- --backend deterministic --oracle http --scenario seeded-text-to-text-dog --max-iterations 1 --candidate-count 2 --scoring-concurrency 1 --out .agent/benchmarks/seeded-text-http-v2.json`
  passed.

Interpretation:

- The harness gives a repeatable, medium-spanning cold-start test instead of
  judging changes only by the Mona Lisa caption basin.
- Hosted TRIBE can be used again, but only with serialized scoring and canary
  checks before larger runs.
- Clean candidate artifacts matter: removing prompt scaffolding improved the
  real seeded text benchmark from roughly zero to `0.084`, but the score is
  still much too low. The next serious experiment should use Codex-generated
  text candidates under this benchmark harness rather than the deterministic
  baseline.

## 2026-06-07 - New full-data API + temporal similarity metric

Context: hosted TRIBE API upgraded. `result.json` now returns the FULL
per-timestep matrix `predictions` `[timesteps, 20484]` plus a Yeo-7
`predictions_by_network` breakdown. The old client mean-pooled to one R^20484
vector then took a single global cosine — the weak signal that kept cross-modal
similarity near 0.04-0.35 in prior runs.

Changes (committed: 06ca49c oracle/types, fa35f24 scoring):
- Oracle (`services/orchestrator/src/oracle.ts`): fetch `result.json`, keep every
  timestep in `ActivationTrace.values`, expose network breakdown via
  `diagnostics.networkMeans`.
- Scorer (`packages/core/src/scoring/activation.ts`): `neuralTrajectorySimilarity`
  = 0.5 * per-timestep mean-centered cosine + 0.5 * frame-to-frame delta cosine,
  mapped to [0,1] via (raw+1)/2.

Metric validation (8-probe text set, target = swirling Starry-Night text):
- naive cosine over averaged 20k: true vibe-match ranks 2/8 (loses to a calm
  night sky counterfactual). gap -0.017.
- Yeo-7 cosine (unweighted / engagement-weighted / variance-weighted): all 2/8.
- temporal+dynamics: match ranks 1/8, repetition reward-hack +0.037 BELOW match.
- Diagnosis: calm-sky beats match in EVERY one of the 7 networks after
  time-averaging; the discriminative signal is temporal, not spatial. No
  spatial reweighting fixes a pooled metric.

CALIBRATION NOTE (important): the new metric maps cosine to [0,1] with
(raw+1)/2, so 0.5 == orthogonal, not 0. The old "0.9" target was on the raw
cosine scale. Before chasing 0.9 we must re-measure where a single image->text
score lands on the NEW scale, and what a strong vs weak candidate spread looks
like. Target for this round: maximize the new neuralSimilarity efficiently and
report the realistic ceiling, rather than assume 0.9 transfers across metrics.

Server fix: `/predict/image` was briefly broken (NameError 'extra'); owner fixed
it. Image jobs now return timesteps=2, vertices=20484, with network breakdown.

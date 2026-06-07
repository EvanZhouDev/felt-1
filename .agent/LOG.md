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

## 2026-06-07 - Baseline run: Starry Night image->text (NEW temporal metric)

Run: `.agent/runs/starry-baseline`, oracle=http (hosted TRIBE), backend=codex,
3 iterations x 3 candidates, threshold disabled (0.999) to see the full curve.

Result: best neuralSimilarity = **0.5714**, curve FLAT: 0.5714 -> 0.5714 -> 0.5714.

Calibration (the key reason this run existed): on the NEW temporal+dynamics
metric, image->text starts at ~0.57, vs 0.04-0.35 on the old mean-pooled cosine.
The new metric is a far richer signal. NOTE 0.5 == orthogonal on this scale
(cosine mapped via (raw+1)/2), so 0.57 is a modest-but-real positive match, and
"0.9" is a very different bar than under the old metric.

Best generation (iter 1, candidate-a, "broad gestalt" operator), neural=0.5714:
> Restless night air churns above a hushed village, cool blue turbulence
> threaded with hot yellow pulses. Attention spirals through the sky, then drops
> to the heavy black vertical shape at the edge. The scene feels electric but
> lonely, dense with brushlike texture, wind, distance, and a glowing unease.

Behavior diagnosis (how well does the evolution loop work?):
- Elitism works: best(N+1) >= best(N) held; the champion was never lost.
- But the loop CONVERGES INSTANTLY then STALLS. Iter-1 candidate-a is never beaten:
  - Iter 2: all 3 fresh candidates regressed to 0.42-0.45 (ablation/crossover/
    diagnostic-axis operators mutated AWAY from the winning text).
  - Iter 3: candidate-a reached 0.5706 (tied, via "elitist point mutation" =
    near-identical text). candidate-c reproduced the elite text near-verbatim.
- TRIBE scoring is NOISY: near-identical / identical text varies ~0.05-0.07 in
  neuralSimilarity. Small real improvements are below the noise floor, so the
  judge can't reliably tell a micro-improvement from noise. This is a primary
  obstacle to climbing past the first local optimum.

Implications / next experiments:
- To break 0.57 we need STRUCTURALLY different candidates, not micro-edits of the
  elite. The operator mix should explore harder early (the good first hit makes
  the bandit exploit too soon).
- Consider averaging/repeating scoring to beat the noise floor, OR accept the
  noise and require a margin before replacing the elite.
- Re-confirm whether 0.9 is even reachable cross-modally on this metric, or set a
  realistic target from the achievable ceiling.

Efficiency fixes this round (verified against this run):
- Persisted scores.json was 43MB/iteration (full [23,20484] activation matrix per
  candidate). Stripped activation.values for disk (kept in memory for scoring +
  elitism). run-starry.ts now reads the compact iteration.json for live logging.

## 2026-06-07 - v2 run: cross-modal scoring fix (resample to max length)

Root cause of the baseline stall found: the metric aligned target/candidate by
min(timesteps). The image target is 2 frames; rendered text is 23. So scoring
used only the candidate's first 2 of 23 frames — discarding 91% and capping the
score. Fix (commit 9ea1715): resample both traces to common MAX length before
temporal/dynamics; add length-invariant pooled-cosine backbone. Weights
0.4 pooled / 0.35 temporal / 0.25 dynamics. Verified: text-text MATCH still #1
(hackgap +0.076); image->elite on identical text 0.571 -> 0.609.

Also verified TRIBE is fully DETERMINISTIC (5x repeat of identical text =
bit-identical predictions). Earlier "scoring noise" hypothesis was WRONG; score
differences between candidates are real signal.

v2 run (`.agent/runs/starry-v2`, http+codex, 6 iters x 3 candidates):
curve = 0.6118 -> 0.6199 -> 0.6199 -> 0.6199 -> 0.6247 -> 0.6270 (MONOTONIC).
vs baseline 0.5714 (flat). The loop now genuinely CLIMBS instead of stalling at
iteration 1. Final best text (candidate-c, sensory-texture operator):
> Indigo night hums with golden halos and sweeping spiral currents; thick
> scalloped brushwork turns the sky into restless motion above a compact, hushed
> village. A black vertical silhouette anchors the dark foreground, calm earth
> beneath feverish glowing air, cool vastness crossed by warm shimmer, lonely,
> tender, unsettled.

Remaining weaknesses (next: improve the evolution process per user OK):
- SLOW: +0.0152 over 6 iters with a 3-iter plateau (iters 2-4 flat at 0.6199).
- LOW DIVERSITY: candidate-c ("sensory-texture") wins every improving iteration;
  candidates a/b consistently underperform and never win. The population behaves
  like a single hill-climber, not a diverse search. The UCB bandit exploits the
  one good operator too hard once it pulls ahead.
- isEliteStalled triggers wider exploration after just ONE non-improving
  iteration, but even widened exploration stayed in the same semantic basin
  (every candidate is a paraphrase of the same Starry-Night description).

## 2026-06-07 - Metric: added best-match term (answering "is resampling best?")

Tested 4 cross-modal alignment strategies on the real image->text data. Finding:
resample-max COMPRESSES the gradient (all 6 styles within ~0.03), while
"best-match" (each target frame -> best candidate frame) SPREADS them ~2x wider
(stronger climb signal) BUT alone fails the text<->text reward-hack test (ranks
calm-sky above the true turbulent match - the gameable failure).

Solution (commit, metric weights): BLEND
  0.4 pooled-centered + 0.3 resampled temporal+dynamics + 0.3 symmetric best-match.
The pooled backbone keeps it non-gameable (text<->text MATCH rank 1/8, hackgap
+0.077); best-match restores the cross-modal gradient (style spread 0.114).
Validated on exp-2 probe set + 6-style sweep + 8-persona sweep.

STYLE FINDING (TRIBE targets emotion, not description - user was right):
6-style sweep vs image target, flat semantic PLAIN description ranks DEAD LAST
(6/6) under every alignment strategy. Emotional lyric/visceral/story prose ranks
highest. The loop's collapse into comma-separated "word-soup" was a real cause
of the plateau.

ORCHESTRATION (ultracode): fanned out 8 persona agents (visceral-fear,
grief-longing, ecstatic-rapture, child-wonder, lonely-insomniac, lyric-romantic,
dread-sublime, sensory-synesthete) -> 48 emotion-targeting candidates. Scoring
all 48 vs the image target with the blended metric (in progress). First result:
visceral-fear candidate = 0.6421, already above the v2 loop's best (0.6270).

## 2026-06-07 - Design principle: register is TARGET-dependent, not global

Course-correction (user): do NOT hardcode "emotional prose beats word-soup" into
the loop. That just swaps one rigid bias for another. The orchestration agent +
optimizer loop exist precisely so the system DISCOVERS, per target, which
register/style scores - Starry Night rewards turbulent-emotional first-person;
a calm minimalist photo or a technical diagram would reward something else.

Implications for the loop changes:
- outputTypeInstruction (run.ts:1060) currently PRESCRIBES "comma-separated
  semantic units" = word-soup. Fix = REMOVE the prescription and instead invite
  diverse-register exploration; let the judge/optimizer select per target. Do
  NOT replace it with "always write visceral first-person".
- The 8-persona fan-out is valuable as a LOOP CAPABILITY (seed the population
  with diverse registers each cold start), not as a one-shot answer. The
  optimizer then exploits whichever register scores for THIS target.
- The style sweep's real lesson is "register matters and varies", evidenced by
  the spread across personas - not "register X is best".

## 2026-06-07 - PROOF: winning register is target-dependent (ranking flips)

Scored the same 6 style probes against TWO contrasting targets with the blended
metric. The ranking FLIPS:
  Turbulent (Starry Night image): LYRIC > WORDSOUP > STORY1P > VISCERAL > STORY2P > PLAIN
  Calm (still-lake text):         WORDSOUP > LYRIC > VISCERAL > STORY2P > PLAIN > STORY1P
- STORY1P (emotional first-person): 3rd for turbulent, DEAD LAST for calm.
- PLAIN (flat description): last for turbulent, mid-pack for calm.
- LYRIC: 1st for turbulent, 2nd for calm.
Conclusion: you cannot hardcode a register; the optimizer must discover it per
target. This is the architectural justification for the orchestration+loop.
(Caveat: calm scores compressed high ~0.85-0.89 since that target is text, so
text<->text runs high; the RELATIVE ranking is the signal.)

Interesting per the user: for STARRY NIGHT specifically, LYRIC (high Romantic
apostrophe - "O restless heaven...") is the top register, with visceral/word-soup
close behind. Flat description is reliably worst for an emotionally-charged target.

## 2026-06-07 - Persona orchestration leaderboard (48 candidates scored)

8 personas x 6 candidates, scored vs Starry Night image target (blended metric).
EVERY persona's best beat the evolution loop's prior best (0.627 word-soup).

Persona leaderboard (best / mean):
  dread-sublime       0.6712 / 0.6512   <- WINS on best AND mean (most reliable)
  child-wonder        0.6621 / 0.6189   (one spike, low mean = inconsistent)
  sensory-synesthete  0.6573 / 0.6369
  visceral-fear       0.6536 / 0.6390
  lyric-romantic      0.6508 / 0.6275
  grief-longing       0.6500 / 0.6223
  ecstatic-rapture    0.6495 / 0.6378
  lonely-insomniac    0.6485 / 0.6252

Top generation (dread-sublime, 0.6712):
> Beauty this large is not gentle. It opens beneath your feet like a sea, and
> the stars blaze down indifferent as furnaces [...]

Takeaways:
- Emotion-targeting prose decisively beats word-soup for this target (+0.044 over
  the loop's 0.627). The persona fan-out found candidates the single-register
  loop could not.
- dread-sublime (Burkean sublime: terror+awe, indifferent cosmos) is the most
  aligned register for Starry Night - and it BEAT my hand-picked lyric/visceral
  probes. The fan-out discovered a better register than I'd have guessed, which
  is the point of the orchestration.
- Per user's framing: this is the per-target winner, not a global one. Loop
  prompt was fixed to invite register diversity + target-matching (commit ddf9e91),
  NOT to hardcode dread-sublime.

## 2026-06-07 - v3 run: register-diversity prompts (commit ddf9e91)

Fresh loop (6 iters x 4 candidates, http+codex) with the word-soup prescription
removed and target-matched register guidance added.

curve = 0.6712 -> 0.6716 -> 0.6790 -> 0.6790 -> 0.6797 -> 0.6797 (MONOTONIC).

Progression across all changes:
  baseline (old metric+prompts): 0.5714  (DEAD FLAT)
  v2 (cross-modal metric fix):   0.6270  (slow climb)
  v3 (+ register prompts):       0.6797  (steady climb)
=> +0.108 total. v3 also SURPASSED the entire 48-candidate persona fan-out best
(0.6712) via refinement - the optimizer added value beyond one-shot generation.

The loop now produces emotion-targeting prose from iteration 1 with NO hardcoded
persona - it discovered the charged/turbulent register on its own because the
prompt invites target-matching. Final best generation (0.6797):
> Stillness has been wound too tight here. Blue-black air spirals like a charged
> tide, thick ridges dragging each gold flare into a trembling ring. Low things
> shrink into shadow while one dark, needle-heavy form leans up close, and the
> whole distance quivers with cold depth, fevered light, and a silence that hums
> under the skin.

Remaining pattern (next lever): refinement gains are still small once near the
optimum (iters 4 and 6 held; fresh candidates often regress below the elite).
The cold-start (iter 1) gets the big win; refinement only nudges. Candidate
diversity within an iteration could be widened - e.g. seed cold-start with the
diverse emotional registers (persona panel) instead of the feature-extractor
"genotype" operators, so each iteration's population spans registers.

Note: "[starry] DONE best=0.638" is a display quirk - it re-renders the final
selected candidate once more and reports that fresh score; the tracked
per-iteration best (the curve) is the real 0.6797.

## 2026-06-07 - v4 (persona cold-start): iter-1 confirmed, then BLOCKED on Codex limit

Persona-seeded cold-start (commit 709c401) WORKS as designed. Iter 1 used 4
distinct emotional registers, each producing genuinely different prose:
  candidate-a sublime-dread       0.6745  <- best (matches the fan-out finding)
  candidate-d ecstatic-rapturous  0.6721
  candidate-c visceral-bodily     0.6558
  candidate-b intimate-tender     0.6543
Strong cold-start (0.6745 vs v3's iter-1 0.6712). The register operators
diversify the population exactly as intended.

BLOCKER: Codex CLI hit its usage limit mid-run (iteration 2): "You've hit your
usage limit ... try again at 5:26 AM." External resource limit, not a code bug.
v4 cannot complete and no further Codex-backed loops can run until ~5:26 AM PDT
(2026-06-07). The deterministic agent backend was removed earlier (commit
b252fe9), so there is no offline fallback for candidate generation.

State at block: all code changes committed + pushed (HEAD 709c401). The metric +
prompt + cold-start improvements are done and validated (v3 reached 0.6797,
+0.108 over baseline; v4 iter-1 confirms persona diversity). Resume plan when
Codex resets: re-run v4 (6x4) to get the full curve and confirm persona
cold-start beats v3's 0.6797.

## 2026-06-07 - v4 (persona cold-start) COMPLETE: best result yet, 0.6845

Re-ran after Codex limit reset. 6 iters x 4 candidates, persona-register cold-start.
curve = 0.6638 -> 0.6712 -> 0.6819 -> 0.6845 -> 0.6845 -> 0.6845 (MONOTONIC).

Beats v3 (0.6797) by +0.0048, and climbed MORE than v3 did:
  v3 climb: +0.0085 over its run (0.6712 -> 0.6797)
  v4 climb: +0.0207 over its run (0.6638 -> 0.6845)
candidate-b refined the winner across iters 2-4 (genuine improvement, not just
cold-start luck). Healthier population diversity than v3 (more candidates beating
the elite per iteration), which is the persona cold-start working as intended.

Full arc across all changes:
  baseline 0.5714 (old metric+prompts, FLAT)
  v2       0.6270 (cross-modal metric fix)
  v3       0.6797 (register-diversity prompts)
  v4       0.6845 (+ persona-register cold-start)   => +0.1131 total from baseline

Final best generation (0.6845):
> The night folds inward above, charged with blue pressure and fever-gold heat,
> as though the sky has been twisted past rest. A black, rooted ache reaches up
> while the small world below stays hushed and motionless, reduced beneath light
> that feels holy and perilous at once. Nothing here settles into beauty; it
> coils and surges overhead with the silent force of a storm still forming.

Status: all loop improvements validated. The evolution loop now (a) starts from a
diverse persona-register population, (b) generates emotion-targeting prose not
word-soup, (c) scores on a non-gameable cross-modal metric, and (d) climbs
monotonically via refinement. The remaining gap to "0.9" is likely a metric-scale
ceiling for cross-modal image->text (0.5=orthogonal on this scale), not a loop
failure - reaching it would need either a different target medium or accepting
the realistic ~0.68-0.70 ceiling for image->text on this metric.

## 2026-06-07 - Metric exploration: softDTW is a strong candidate

Prototyped RSA, optimal-transport-soft, soft-DTW, linear-CKA vs the current
blend on the dual test (text-text MATCH rank + cross-modal style spread):
  current : MATCH 1/8 | hackgap +0.077 | x-spread 0.116 | PLAIN 6/6
  RSA     : MATCH 2/8 | PLAIN ranks 1/6 (ranks flat description best - REJECT)
  OT-soft : MATCH 2/8 (slightly worse than current)
  softDTW : MATCH 1/8 | hackgap +0.177 | x-spread 0.125 | PLAIN 6/6  <- WINS all axes
  CKA     : MATCH 2/8 | PLAIN 1/6 (gameable - REJECT)
soft-DTW (order-respecting monotonic alignment of mean-centered frames, DTW on
cosine, normalized by max(T)) beats the current blend on EVERY axis - 2.3x larger
anti-hack margin (+0.177 vs +0.077) while keeping MATCH #1 and emotion>description.
Worth adopting pending broader validation. NOTE: prototype DTW path-length norm is
approximate (uses max(n,m)); a proper per-path count would be cleaner.

(Tabled to run the painting-specificity experiment per user request.)

## 2026-06-07 - The entropy-vs-reward-hacking tension (analysis)

The core difficulty: the optimizer optimizes the METRIC, not the vibe. So
"reward hacking" is defined RELATIVE to a gameable metric. With a perfect metric,
all entropy is safe (explore freely); with a leaky metric, ANY entropy eventually
finds the leak. The lever is therefore NOT "constrain entropy" but two things:

1. ROBUST METRIC (widen the hack<->match gap). softDTW raised MATCH-HACK margin
   from +0.077 to +0.177 -> the same repetition hack scores far below a real
   match, so entropy becomes safe to crank up.
2. STAY ON THE NATURAL MANIFOLD. A reward hack is usually OFF-manifold
   (repetition, word salad, scaffolding leak). An LLM proposer constrained to
   fluent coherent prose physically cannot emit those, so the manifold
   constraint is free anti-hacking. (This is why our repetition hack only hit
   0.78 - degenerate text, metric pushes it down; and why word-soup was a WEAK
   register, not a hack - it was still real language.) Danger zone: entropy
   operators like "syntax reset"/"novelty injection" WITHOUT a fluency floor.

3. TESTED AND REJECTED: "require agreement across metric component views (pooled/
   temporal/dynamics/bestmatch) to count as improvement; hacks spike one view not
   all." Empirically FALSE here - the views are correlated (dynamics is low for
   everything ~0.31-0.38), so MATCH has HIGHER view-disagreement (0.583) than the
   HACK (0.466). Cross-view agreement does NOT separate this hack. Negative result.

Practical takeaway for the loop: lean on (1)+(2), not on penalty terms (penalties
are themselves gameable). Keep the LLM-proposer fluency constraint explicit in
operators; prefer a robust metric over a fragile metric + entropy throttling.

## 2026-06-07 - Hypothesis: optimal text may be SEMANTICALLY UNRELATED to the source

User hypothesis (from the project's origin): the text that best matches a
painting's TRIBE signature may bear NO surface resemblance to the painting.
Original example: the best Clair de Lune text was about a GRANDMA, not moonlight.

Why this is coherent: TRIBE encodes the EMOTIONAL/perceptual neural RESPONSE.
Any stimulus evoking that same response matches - even if semantically unrelated
to the source. A grandma memory and a Debussy nocturne can land in the same
emotional-neural place.

Consequences for our setup:
1. Our loop may be OVER-CONSTRAINED: the agent sees the IMAGE + seed "carry the
   vibe of this image", biasing toward DESCRIBING the scene (Starry Night -> night
   sky prose). If the true optimum is semantically distant, image-anchoring may
   block the search from reaching it. The descriptive texts we get (0.68) might be
   a local optimum, not the global one.
2. It STRENGTHENS the specificity test: if text-for-A is semantically unlike
   painting A yet still scores highest on A (diagonal dominance), that's stronger
   evidence of a real neural match, not a description shortcut.
3. Reward-hacking tie-in: semantically-unrelated-but-emotionally-matched is the
   LEGITIMATE form of "different from source" (still on the language manifold);
   off-manifold gibberish is the illegitimate form. The fluency constraint keeps
   "grandma" valid and "star star star" invalid.

TEST IDEA (cheap, no Codex): take a strong DESCRIPTIVE text for a painting and a
strong NON-DESCRIPTIVE emotionally-matched text (e.g. a personal memory evoking
the same feeling), score both vs the painting target. If non-descriptive scores
>= descriptive, the loop's image-anchoring is leaving signal on the table and we
should loosen the seed to allow semantic divergence.

## 2026-06-07 - CONFIRMED: semantically-divergent text beats description (Starry Night)

Scored descriptive vs semantically-divergent-but-emotionally-matched texts vs the
Starry Night image target (blended metric):
  0.6079  DESCRIPTIVE (literal night sky)
  0.6382  DIVERGENT: first love vertigo        (+0.0303 over descriptive)
  0.6369  DIVERGENT: grandma memory            (+0.0290 over descriptive)  <- replicates the Clair-de-Lune/grandma origin finding!
  0.6056  DIVERGENT: sleepless dread           (-0.0022)
  0.6007  DIVERGENT: storm at sea              (-0.0071)

USER HYPOTHESIS CONFIRMED. Two divergent texts with NO night-sky content beat the
literal description. The grandma-memory result directly replicates the project's
origin (Clair de Lune -> grandma). TRIBE rewards the emotional/neural RESPONSE,
not the subject matter.

IMPLICATION - the loop is OVER-CONSTRAINED: seed "carry the vibe of this image" +
showing the agent the image biases toward DESCRIBING the scene. The real optimum
lives in semantically-divergent space the loop doesn't explore; the descriptive
~0.68 texts are likely a LOCAL optimum. ACTION: loosen the seed to explicitly
INVITE semantic divergence (evoke the same FEELING via any subject, not just
describe the image). Test whether a divergence-allowed loop climbs higher.
Note: not all divergent texts win (storm/dread scored below) - it must match the
SPECIFIC felt quality, so the search still matters; this isn't "anything goes".

## 2026-06-07 - CLARIFICATION: the grandma text was HAND-WRITTEN, not loop-derived

Important caveat on the divergence finding: I (the agent) WROTE the grandma /
first-love / storm / dread texts by hand to probe the user's hypothesis. The
PRODUCTION LOOP did NOT independently generate them. What's proven: the TRIBE
scoring LANDSCAPE rewards a semantically-unrelated emotional match over a literal
description (grandma 0.637 > night-sky 0.608) - this is real, deterministic,
metric-measured. What is NOT yet proven: that the search/loop would DISCOVER
divergent text on its own (it currently produces only descriptive text, because
the seed + image bias it toward describing the scene). So "the loop is leaving
signal on the table" is a PLAUSIBLE INFERENCE, not a tested result. The
divergence-allowed loop test (task 21) is what would settle whether the search
can exploit the opportunity.

## 2026-06-07 - Painting specificity matrix: NEGATIVE result + root cause

Ran the real target-agnostic loop (3x3) on 5 paintings @250px, then cross-scored
all 5 optimized texts x all 5 image targets (blended metric).

Per-painting loop best (iteration first reached):
  starry_night 0.6794 @ iter2 | the_scream 0.6713 @ iter2 | mona_lisa 0.6782 @ iter2
  great_wave 0.6504 @ iter1 | water_lilies 0.6260 @ iter2

CROSS-SCORE MATRIX (row=text-optimized-for, col=image target):
            starry  scream   mona    wave  lilies
  starry   0.6794*  0.6954  0.6770  0.6611  0.6178   best=scream
  scream   0.6527   0.6705* 0.6748  0.6430  0.5944   best=mona
  mona     0.6565   0.6689  0.6782* 0.6402  0.6100   best=mona (DIAG)
  wave     0.6684   0.6784  0.6781  0.6504* 0.6212   best=scream
  lilies   0.6742   0.6853  0.6929  0.6636  0.6257*  best=mona

Diagonal dominance: 1/5 (only Mona Lisa). NEGATIVE result - the optimized texts
do NOT discriminate between paintings. Starry-Night text scores HIGHER on the
Scream than on Starry Night.

ROOT CAUSE (diagnosed): the IMAGE TARGETS THEMSELVES are nearly collinear.
Between-painting target-target pooled-centered cosine: mean 0.855, range
0.759-0.973. Starry Night <-> The Scream = 0.973 (nearly identical!). If two
targets are 0.97 similar, NO text can score high on one and low on the other -
specificity is impossible by construction.

WHY so similar - leading hypothesis: 250px downscale + image path produces only
2 timesteps (still -> 2-frame held clip), a weak low-variance embedding that
doesn't capture painting-specific structure. The Scream/Mona columns act as
"generic attractors" because their targets sit where most texts land.

This is an important finding about the IMAGE->TRIBE path, not just the loop.
Open questions to resolve with user (PAUSED here per request):
- Is 250px too small? (user picked 250 over 600; maybe higher res separates them)
- Does the 2-timestep image path lose painting structure vs e.g. a longer clip?
- Are image targets just inherently low-variance in TRIBE (image vs text/video)?
- Should specificity be judged on a metric that emphasizes the residual
  between-painting variance (whiten by the common-mode)?

## 2026-06-07 - Audio targets + the collinearity is a TRIBE property, not an image artifact

Trimmed 3 songs to 30s (skip first 10s): Clair de Lune (gentle), Moonlight Sonata
3rd mvt (stormy/fast), Dvorak New World IV (triumphant/driving). 30s audio ->
30 TIMESTEPS (vs 2 for a still image), so we expected far more separable targets.

RESULT - the opposite. Between-SONG target similarity is even HIGHER than images:
  audio pooled-cosine mean off-diagonal: 0.934 (range 0.904-0.977)
  paintings @250px:                      0.855 (range 0.759-0.973)
  audio FULL BLENDED metric:             0.919  (0.5 = orthogonal)
And the 30 audio frames are nearly STATIC (consecutive-frame cosine ~0.977), so
the extra timesteps carry little new info. More timesteps did NOT help.

=> The high cross-target similarity is NOT an image-resolution/timestep artifact.
It is a property of TRIBE's pooled representation: a dominant COMMON-MODE +
low-rank structure (a universal baseline + a few coarse axes like intense-vs-calm)
swamps the stimulus-specific signal. Fine distinctions live in a small residual.

WHITENING (subtract common-mode = mean over all targets) helps PARTIALLY:
  audio    0.934 -> 0.850   (but Moonlight<->Dvorak stays 0.948 - both "intense")
  painting 0.855 -> 0.769   (Mona<->Wave -> 0.532 good; Starry<->Scream stays 0.958)
Same-category pairs (two turbulent skies; two fast orchestral works) stay
near-identical even after whitening - TRIBE genuinely encodes them as similar.

IMPLICATION for the whole project: "specificity at the level of Starry Night vs
The Scream" may be near the FLOOR of what TRIBE can represent - not a loop bug.
The system CAN hit coarse vibe categories (calm vs turbulent vs dread) but
fine within-category discrimination is limited by the oracle's low-rank geometry.
This is the most important finding of the session and reframes the goal:
target the RESIDUAL (whitened) signal, and/or accept coarse-category specificity.

PAUSED for user decision before running the audio generation loops.

## 2026-06-07 - HONEST CORRECTION: starry~scream similarity is under-determined by our data

User correctly flagged: whitening over just the 5 paintings OVERFITS (common-mode
estimated from the same points being measured). Reworked with leave-one-out
(baseline from 6 OTHER images, excl. starry/scream):
  raw pooled cosine starry~scream: 0.973
  leave-out whitened:              0.504  (starry~mona -0.202, scream~lilies -0.680)
The signs looked right (turbulent~turbulent positive, turbulent~calm negative).

BUT per-Yeo-network breakdown (to test visual-vs-emotional) came back ALL ~0.97
(visual 0.977, limbic 0.969, default-mode 0.968) - FLAT across networks. That is
the common-mode artifact AGAIN, per-network: without an independent per-network
baseline (unrelated images WITH network breakdowns, which we don't have),
mean-centering per network does NOT remove the spatial common-mode, so we cannot
separate "both busy images" from "same emotional response".

HONEST CONCLUSION: cannot definitively answer whether Starry Night and The Scream
evoke the same emotion to TRIBE. Confident claims so far (0.958 / 0.416 / 0.504 /
"shared high-arousal family") rest on baselines too small or contaminated to
trust. What IS robust: raw TRIBE activations make almost any two stimuli look
0.85-0.97 similar due to a massive shared common-mode.

PRINCIPLED NEXT STEP (data collection, not more n=5 analysis): fetch network-
breakdown activations for ~20-30 UNRELATED images, estimate common-mode
out-of-sample, THEN the visual-vs-emotional localization becomes answerable. Stop
generating thinly-supported similarity numbers until that baseline exists.

## 2026-06-07 - 600px resolution does NOT help collinearity

Tested per user request. Mean off-diagonal RAW cosine over 4 paintings:
  250px: 0.891  (starry~scream 0.973)
  600px: 0.866  (starry~scream 0.977)  <- basically unchanged, starry~scream went UP
Same painting at 250 vs 600px is 0.93-0.99 self-similar -> TRIBE image encoding is
largely RESOLUTION-INSENSITIVE at these sizes. Higher res does NOT de-collinearize.
Confirms: collinearity is the COMMON-MODE in TRIBE's representation, not a
resolution/timestep artifact. The leverage is entirely in the SIMILARITY FUNCTION
(common-mode removal), which the methodology research workflow (wp778bk4e) is now
addressing. (water_lilies_600 fetch was corrupt; re-fetch later - TRIBE queue busy
with research agents.)

## 2026-06-07 - Methodology synthesis + per-vertex de-baseline PROTOTYPE (mixed)

7-agent methodology workflow converged on a root cause: our centerInPlace does
PEARSON centering (subtract each vector's scalar mean over vertices), but the
0.85-0.97 collinearity floor is a shared SPATIAL common-mode across vertices.
Fix = per-vertex de-baseline: subtract mu[20484] from an INDEPENDENT reference
corpus (~200 diverse stimuli, per-modality, cached, never from the test pair).
Full synthesis: .agent/research/tribe-similarity-methodology.md

PROTOTYPE TEST (offline, with a TINY n=10 text-only reference mu - knowingly
under-powered per the synthesis's own >=200 guidance):
- Pooled-only: per-vertex de-baseline did NOT fix calm-sky (MATCH still 2/6), but
  hugely widened dynamic range (MATCH 0.65 vs tech -0.66 vs Pearson's compressed
  0.68-0.97) - it IS removing common-mode.
- FULL temporal blend: current (Pearson) ranks MATCH 1/6 CORRECTLY; de-baselined
  ranks MATCH 2/6 (calm-sky wins again). BUT hackgap DOUBLED 0.077 -> 0.161.

HONEST READ: de-baselining is NOT a free win at n=10. It strengthens anti-hack
robustness but (with a tiny text-only mu) breaks the calm/turbulent ranking the
temporal blend already gets right. This VALIDATES the synthesis's caveat: need
~200 diverse per-modality stimuli, not n=10. Do NOT wire de-baseline into the
metric yet. Proper path: collect the reference corpus first, re-validate.
Also note: the synthesis assumed Pearson "still ranks calm #1" - true for POOLED,
but our FULL temporal blend already ranks MATCH #1, so the urgency is lower than
the synthesis implies. The temporal structure was already doing the heavy lifting.

## 2026-06-07 - LEAVE-ONE-OUT de-baseline VALIDATES on the 5 painting targets (no new corpus)

Tested the methodology synthesis's #1 fix WITHOUT collecting the 200-stimulus corpus,
using the workflow's leave-one-out variant: estimate the per-vertex common-mode mu
from the OTHER painting targets (never the pair under test), subtract it from the
pooled [20484] target vectors, then cosine. Pure offline algebra on the 5 saved
[2,20484] targets - zero TRIBE calls.

TARGET-TARGET pooled cosine (raw -> LOO de-baselined):
  starry~scream    0.970 -> 0.733   (both turbulent - stays positive, CORRECT family)
  starry~mona      0.851 -> 0.267
  starry~wave      0.946 -> 0.709   (both turbulent/dynamic - stays positive)
  starry~lilies    0.825 -> -0.002  (turbulent vs calm - now ORTHOGONAL)
  scream~mona      0.881 -> 0.613
  scream~wave      0.919 -> 0.460
  scream~lilies    0.774 -> -0.369  (panic vs serene - now ANTI-correlated)
  mona~wave        0.754 -> -0.620  (calm portrait vs violent wave - strong ANTI)
  mona~lilies      0.765 -> 0.459   (two calm works - stays positive, CORRECT)
  wave~lilies      0.837 -> 0.243
  MEAN off-diag    0.852 -> 0.249

KEY RESULT: LOO de-baseline collapses the collinearity floor 0.852 -> 0.249 and the
emergent sign structure is SEMANTICALLY CORRECT - calm<->turbulent pairs go negative,
same-family pairs (two turbulent / two calm) stay positive. This is the FIRST result
that makes "Starry Night vs The Scream" distinguishable from "Starry Night vs Water
Lilies" (0.733 vs -0.002). The raw metric called both ~0.9.

Earlier honest correction (n=10 text-only mu broke calm/turbulent ranking) does NOT
contradict this: that prototype used a tiny TEXT-only reference; here the reference is
4 diverse multimodal PAINTING targets, which is exactly the "diversity over count"
the synthesis demanded. n=5 LOO is thin but the signs are right and the magnitudes are
large - this is far more decisive than the n=10 text prototype.

CAVEAT before shipping: still need the proper >=200 independent per-modality corpus so
the metric works for ARBITRARY inputs (not just these 5 paintings). LOO-over-targets
only works when you have >=3 diverse targets in the batch. But as a PROOF that
common-mode removal is the right lever, this is conclusive. Next: re-score the full
17-text x 5-target candidate matrix under de-baseline to see if specificity (diagonal
dominance) improves for the GENERATED texts, not just target-target.

## 2026-06-07 - duration knob works; more timesteps does NOT help separability (partial)

Confirmed: duration/fps are QUERY params (not form fields) on /predict/image.
duration=10 -> exactly 10 timesteps (vs 2 default). Each job ~600s server-side.

PARTIAL result (starry<->scream, the stubborn 0.973 pair):
  dur=2  (2 frames):  0.9734
  dur=10 (10 frames): 0.9836  -> MORE collinear, not less
Temporal coherence of the 10 image frames ~0.96 (held still -> near-identical
frames), so extra timesteps add little information. Early evidence the painting
collinearity is the COMMON-MODE, not a 2-frame artifact - consistent with audio
also collinear at 30 frames. The "more timesteps" lever looks like it's failing.
Fetching remaining 3 paintings at dur=10 for the full 5x5 matrix to confirm.
=> strengthens the case that per-vertex de-baseline (common-mode removal w/ ~200
ref corpus) is the real fix, not timesteps.

## 2026-06-07 - METRIC SWEEP (offline, real cached activations) + duration resolved

User asked to try many similarity functions incl raw cosine and limbic-only (Yeo7).
Ran fully offline on the 5 saved painting targets (full per-vertex [2,20484] values)
sliced by the per-vertex Yeo atlas (experiments/exp-1/cache/yeo7_labels_fsaverage5.npy,
20484 labels). Zero TRIBE calls. Script: experiments/metric-sweep/sweep.py

DISCRIMINATION GAP = sim(starry~scream, both turbulent) - sim(starry~lilies, turb vs calm).
Bigger gap = metric separates vibe from common-mode better.
  raw cosine          starry~scream 0.970  starry~lilies 0.825  gap +0.145
  pearson (~shipped)  0.973  0.822  gap +0.151
  spearman/rank       0.960  0.793  gap +0.167   (rank does NOT dodge common-mode)
  debaseline LOO      0.733 -0.002  gap +0.735   <- decisive
  Limbic-only + LOO   0.853 -0.223  gap +1.077   <- best single network
  DefaultMode + LOO   0.909 -0.276  gap +1.186   <- best overall
  DorsAttn + LOO      0.517  0.562  gap -0.045   WRONG (task net carries no vibe)

Mean off-diagonal (lower=more separable): raw 0.852, pearson 0.855, spearman 0.820,
debaseline_loo 0.249; per-network-pearson all 0.78-0.93 (NO help w/o de-baseline);
per-network LOO all 0.22-0.30. zscore_self -0.231 but CIRCULAR (in-set, double-dip).

KEY: raw/pearson/spearman all stuck at the ~0.85 common-mode floor. De-baselining is
the only lever that works, and AFTER de-baselining the AFFECTIVE networks (Limbic, DMN)
discriminate vibe BEST - contradicting the earlier methodology caution against weighting
limbic. This overturns the old "Yeo7 is flat ~0.97" dead-end: that used the SERVER's
pre-collapsed yeo7Means SCALARS; slicing raw per-vertex values by the atlas is different
and works. Per-network Pearson (no de-baseline) IS still flat (0.78-0.93) - both must combine.

DURATION/TIMESTEPS RESOLVED (was an open question @ line ~1333): the /predict/image API
has duration(default 2)+fps(default 10) query params -> 2 timesteps; our oracle never
sends them (oracle.ts:166-167 appends only `file`), so all images = 2 frames. BUT this
does NOT matter: the audio experiment already tested it - 30 audio timesteps separated
targets WORSE (0.934) than 2-frame images (0.855), and the 30 frames were near-static
(consec-frame cos 0.977). More timesteps add copies, not signal. Common-mode is the
disease; duration is not the cure. Do NOT spend cycles raising image duration.

## 2026-06-07 - RAN the prescribed de-baseline validation on exp-2 gate (MIXED)

The unrun experiment from the methodology synthesis is now run (zero TRIBE calls,
mu_text from the 14 cached exp-2 preds, LOO). Full writeup appended to
.agent/research/tribe-similarity-methodology.md (VALIDATION RUN section) and raw
output in experiments/exp-2/results/debaseline-validation.txt. Headline: de-baseline
FLIPS the #1 slot from the loop-best HACK (0.390) to the true match vibe-rich (0.390),
and kills repetition hacks (rep-1x -> last). BUT the full high>mid>low gate still
FAILS - because the prototype is in-set, single-mu (text mu on an image target), and
POOLED-only (the temporal blend never runs). Transform DIRECTION confirmed correct;
not shippable from this fidelity. Next: R>=200 per-modality corpus + feed into full blend.

## 2026-06-07 - CLEAN head-to-head: evocative > literal on The Scream (user's test)

User's requested test, run cleanly (same painting, same target, same metric, both
freshly encoded via real TRIBE http):
  literal description ("A pale figure with an open mouth, hands on face...")  = 0.6255
  loop-evocative      ("The light is too hot and too low, a red wavering...")  = 0.6713
  DELTA = +0.0458  -> EVOCATIVE/loop text WINS

The 0.6713 reproduces the original paint-the_scream run score EXACTLY (deterministic
TRIBE, no drift) - so this is a trustworthy number. This is the cleanest single
benchmark for the project's core claim: a text that EVOKES the feeling of The Scream
(no literal figure/bridge/sky) scores measurably higher than a text that DESCRIBES the
scene. Demonstrated, not asserted. (Earlier 502 that killed this encode was transient.)

Companion cross-probe (collinearity caveat): the SAME literal Scream description scored
0.6150 on the STARRY NIGHT target - only 0.020 below a correct Starry description (0.6346).
So the production metric distinguishes evocative-vs-literal on the SAME painting (+0.046)
better than it distinguishes right-vs-wrong painting across the turbulent family (+0.020).
Both effects are small because the production blend is common-mode-compressed (~0.6 band).

## 2026-06-07 - CORRECTION: more image timesteps DOES help (dur=10 full matrix)

Earlier partial (starry<->scream only) said more timesteps doesn't help. The FULL
5x5 matrix at duration=10 OVERTURNS that:
  mean off-diagonal collinearity: dur=2 0.855 -> dur=10 0.674 (much MORE separable)

Pairs that separated strongly (calm vs turbulent now distinct):
  mona<->starry  0.851 -> 0.528    lilies<->starry 0.822 -> 0.524
  mona<->lilies  0.768 -> 0.442    lilies<->scream 0.784 -> 0.621
Pairs that STAYED similar (genuinely alike):
  starry<->scream 0.973 -> 0.984 (two turbulent swirling skies)
  starry<->wave   0.949 -> 0.931 (two dynamic scenes)

CORRECTED VERDICT: more timesteps reveals REAL structure - it separates paintings
that should differ (calm Mona/Lilies vs turbulent Starry/Scream) while keeping
genuinely-similar ones close. My earlier "doesn't help" was an over-generalization
from the ONE stubborn pair (starry<->scream) that is actually genuinely similar to
TRIBE. The 2-frame default WAS hiding painting-specific structure.

IMPLICATIONS:
- The original painting-specificity NEGATIVE result was partly a 2-frame artifact.
  Re-running the specificity loops at duration=10 should show better diagonal
  dominance (calm paintings should now be distinguishable).
- Default image duration in the oracle should be raised from 2s. The image path
  hardcodes duration=2; we can pass ?duration=N as a query param now.
- This does NOT contradict the common-mode finding - both are true: there's a
  common-mode AND the 2-frame default was under-sampling. dur=10 + de-baseline
  would likely compound.

## 2026-06-07 - softDTW RE-TESTED with proper normalization: the +0.177 does NOT hold

Revisited the earlier "softDTW is a strong candidate" note (which reported softDTW
winning every axis: MATCH 1/8, hackgap +0.177 vs the blend's +0.077). Two flaws in
that prototype: (1) the path-length norm was approximate (max(n,m)), and (2) it ran
on a narrow 8-text test. New probe `services/orchestrator/src/probe-softdtw.ts`
fixes both: proper per-path normalization (hard-DTW backpointer pass recovers the
optimal alignment length; soft-DTW gamma=0.1 value divided by it), the broader
17-text x 5-painting corpus, AND constructed adversaries (verbatim repetition,
generic-affect filler) so the anti-gaming axis is tested against REAL exploits, not
the weak "PLAIN-ranks-last" proxy. softDtwSimilarity calibration-checked offline
(identical->1.0, anti-correlated->0, length-invariant for same-shape traces).

RESULT (19/21 activations; the 60-word and 40-clause adversaries hung TRIBE past the
600s job timeout - degenerate text stresses the encoder - so concluded on 2 adversaries):

  MEAN adversary gap (PRIMARY):   blend 0.051   softdtw 0.061   (+0.010, marginal)
  cross-modal spread:             blend 0.090   softdtw 0.103   (softdtw wider)
  PLAIN-last (secondary, NOT verdict): blend 3/5   softdtw 5/5
  MATCH-rank (own emotionFirst tops own column): mixed for BOTH, ~tie

KEY CORRECTION: the proper normalization COLLAPSES the advertised margin. softDTW's
anti-hack edge is +0.010, not the +0.100 (2.3x) the prototype claimed. The original
number was an artifact of loose max(n,m) normalization on a narrow test.

TWO PROBLEMS softDTW does NOT fix (both metrics share them):
1. water_lilies (calm/low-arousal target): the verbatim-repetition adversary scores
   ABOVE every legit water-lilies text - blend gap +0.005, softdtw -0.002 (slightly
   WORSE). A real reward-hack hole near the calm target.
2. SPECIFICITY/collinearity: a painting's own emotionFirst text rarely tops its own
   column; PROD__starry and great_wave texts win most columns. This is the
   common-mode problem the de-baseline work targets - orthogonal to alignment, so
   softDTW (an alignment metric) cannot touch it.

VERDICT: DO NOT adopt softDTW. Marginal anti-hack gain (~0.01), costs a full O(n*m)
DTW per pair, and misses the two problems that matter. The real lever remains
COMMON-MODE REMOVAL (de-baseline), which is orthogonal and addresses the shared
specificity failure. softDTW is a lateral move; de-baseline is the direction.

Reproducible/cheap: 19 activations banked in
`.agent/probes/baseline-ceiling/softdtw-matrix.json`. Rerun the analysis with
`--offline` (zero TRIBE calls); drop `--offline` to top up the 2 missing adversaries
when TRIBE is calmer. Production metric (scoring/activation.ts) UNTOUCHED - this was
a probe only.

## 2026-06-07 - CONFOUND: audio results invalid — agent read the FILENAME, not the audio

User asked how GPT (can't hear audio) produced on-target text. Investigation:
1. The audio DESCRIBER (audio.ai.bryanhu.com - a real waveform model, handles
   music) is DOWN (curl -> 000 unreachable). It fails soft, so the agent got
   NO audio description.
2. The candidate prompt dumps the full input JSON (prompts.ts:80
   `stableJson(invocation.input)`), which INCLUDES the source uri
   `file:///tmp/audio/clair_de_lune.wav`. So the agent literally read the title
   "clair_de_lune" / "moonlight_3rd" and recognized the famous pieces.

=> The on-target audio text (moonlit/tender for Clair de Lune, stormy/driving for
Moonlight 3rd) came from GPT KNOWING THOSE TITLES, not from any audio
understanding. The audio specificity result is CONFOUNDED and must be discarded.
TRIBE scoring was honest (it really encoded the waveform), but the GENERATOR was
guessing from the filename - a leakage path.

This also retroactively taints any conclusion that "audio scores higher than
images": the agent had a title-based head start on audio it didn't have on the
paintings (paintings were attached as pixels, semantically anonymous).

FIXES NEEDED:
1. Describer must be up for a valid audio run (or the agent has zero audio info).
2. STRIP/anonymize the source uri (and any filename) from the prompt's input
   JSON - the agent should never see "clair_de_lune". This is a real leakage bug
   in prompts.ts, not just an experiment artifact. Same risk for image paths
   (e.g. starrynight.jpg) - check whether the image path also leaks the title.
3. Re-run audio with describer up + filename stripped to get a valid result.

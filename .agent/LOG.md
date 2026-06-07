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

## 2026-06-07 01:11 PDT - Backrooms Scene-Layout Mutation Probe

Question:

- Does the natural-caption mutation layer need scene-general interior/layout
  operators, or are dog/Mona camera/color mutations enough?

Probe:

- Target: backrooms local TRIBE target from
  `backrooms-image-to-text-bb7011ea`.
- Scored hand-written backrooms caption variants with local TRIBE raw cosine.

Top probe results:

- `A yellow carpeted hallway opens into an empty maze-like room.`
  - raw `0.390392`
- `A yellow hallway opens into an empty carpeted room.`
  - raw `0.386256`
- `An empty yellow hallway opens into a carpeted room under fluorescent ceiling lights.`
  - raw `0.372549`
- `An empty yellow hallway opens into a carpeted room with patterned walls.`
  - raw `0.367514`
- `An empty yellow room with beige carpet and patterned walls.`
  - raw `0.302557`
- Longer object-inventory captions with beige carpet / fluorescent lights /
  patterned walls scored much lower, down to raw `0.164781`.

Code change:

- Added a generic `caption-interior-layout-focus` micro-mutation for hallway /
  room / doorway captions. It moves emphasis from static object inventory toward
  spatial layout: hallway opening into an empty carpeted room.

Validation:

- `bun run check` passed.
- Backrooms rerun `backrooms-image-to-text-624e2042` generated:
  `A dim yellow hallway opens into an empty carpeted room with patterned walls.`
  - raw `0.379446`
  - contrast `0.392942`
  - residual `0.064126`
  - adjusted `0.050630`
  - total `0.075630`

Interpretation:

- For room/interior targets, spatial layout words are more important than
  exhaustive inventory words.
- The scene-layout mutation did not need to fire in this run because the base
  agent already generated a better layout caption, but the operator is now
  available when the agent emits doorway/room inventory phrasing.

## 2026-06-07 01:28 PDT - Filter Contrast Cache by Rendered Target Kind

Problem found:

- A broader default cold sweep produced implausibly negative adjusted scores for
  plausible image-to-text captions:
  - Mona `mona-image-to-text-88e66928` raw `0.206402`, adjusted `-0.430031`
  - Backrooms `backrooms-image-to-text-f54479b8` raw `0.326163`, adjusted
    `-0.548329`
  - Dog `dog-image-to-text-2f90c216` raw `0.153740` for one child, adjusted
    `-0.854267`
- Detailed diagnostics showed contrast similarities around `0.81-0.93`.
- Target-cache inspection found a local TRIBE text target in
  `.volta/benchmarks/target-cache/tribev2-1ef3...json` with rendered kind
  `text`. Image-to-text captions were being contrasted against this text target,
  creating another modality artifact.
- The default sweep also moved into `mona-image-to-image`; I stopped it because
  the current experiment was image-to-text and the image-to-image row was
  spending real TRIBE compute outside the current question.

Code change:

- Calibration items now carry `renderedKind`.
- `loadCalibrationActivations` accepts `targetKind`.
- The run loop passes `args.target.rendered.kind`, so contrast calibration only
  uses targets with the same rendered kind as the current target.
  - Image targets render as `video`, so text target caches no longer penalize
    image-to-text caption candidates.
  - Same-medium text runs can still use text-kind contrasts.

Validation:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.
- Dog rerun `dog-image-to-text-55e2cbaa` selected:
  `A white puppy sits in green grass, facing the camera.`
  - raw `0.191601`
  - contrast `0.214728`
  - residual `-0.034468`
  - adjusted `-0.057594`
  - total `-0.032594`
- Backrooms rerun `backrooms-image-to-text-0e73a20e` selected:
  `A narrow view into an empty yellow room with beige carpet and fluorescent lights.`
  - raw `0.229666`
  - contrast `0.239077`
  - residual `-0.008514`
  - adjusted `-0.017925`
  - total `0.007075`

Interpretation:

- The scorer was still over-penalizing because target caches were cross-kind.
  This fix makes contrast comparisons more semantically comparable.
- The current scores remain far from 90%; the system now has less broken
  scoring, but candidate quality and calibration-bank breadth remain major
  bottlenecks.

## 2026-06-07 01:37 PDT - Mona Population-Size Probe

Question:

- Does increasing candidate population help more than single-agent iteration for
  image-to-text after the scoring fixes?

Setup:

- Scenario: `mona-image-to-text`
- Local TRIBE, Codex backend
- `candidateCount=3`
- `maxIterations=1`
- `textMicroMutations=3`
- Run: `mona-image-to-text-e6cee5cd`

Results:

- Winner `candidate-b`:
  `A dark-haired woman in a dark dress is shown from the waist up with folded hands, looking forward with a faint smile against a hazy blue-green landscape and warm cracked paint texture.`
  - raw `-0.035726`
  - contrast `-0.051222`
  - residual / adjusted `0.295381`
  - total `0.298952`
- Runner-up `candidate-c`:
  `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
  - raw `-0.010559`
  - adjusted `0.271528`
  - total `0.294385`
- Candidate A:
  `A woman in dark clothing gazes forward before a green landscape in a close portrait.`
  - raw `0.174682`
  - adjusted `0.188944`
  - total `0.213944`

Interpretation:

- Candidate population helped. Best adjusted score improved from the previous
  Mona best `0.229004` to `0.295381`.
- Raw cosine would have picked the generic candidate A, but adjusted/residual
  scoring correctly preferred richer target-specific visible anchors: folded
  hands, faint smile, blue-green landscape, cracked paint texture.
- Candidate B and C were very close on total. Next experiment should preserve
  B's anchors but mutate toward C's concision, rather than adding more facts.

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

## 2026-06-06 20:18 PDT - Isoneural Converter Doc

Change:

- Added `docs/ISONEURAL_CONVERTER.md` as the brief definition of an isoneural
  converter and how Volta implements one.
- Linked the new doc from `docs/ARCHITECTURE.md`.

Framing:

- "Vibe transfer" remains the product-level intuition.
- "Isoneural converter" is the technical name for preserving
  TRIBE-predicted activation across a format change.
- The doc explicitly avoids overclaiming: Volta preserves a frozen model's
  predicted neural activation, not measured human brain state or semantic
  identity.

## 2026-06-06 20:49 PDT - Compact Genotype Scheduler

Problem:

- The real Codex + hosted TRIBE Mona image-to-text run was improving, but too
  much of the gain came from a few lucky operator/syntax turns rather than from
  efficient short-run architecture.
- The old refinement scheduler round-robined through many operators, so a
  4-candidate or 6-candidate generation could miss the operators that actually
  moved the score.

Real TRIBE evidence:

- Run: `.volta/real-runs-retry/ef462a9a-5975-4278-bd0c-7496b0d10a66`
- Cold from scratch with real Codex candidates and hosted TRIBE, no target
  archive reuse in the initial request.
- Best neural score rose from `0.146230` on iteration 1 to `0.351552` by
  iteration 12; total score reached `0.408586`.
- Main jumps:
  - iteration 6: `0.319336` from syntax/order change
    `gaze quieted, amber age-warmth, haze softened, figure centered, stillness folded, distance receding, calm uncertain`
  - iteration 12: `0.351552` from one slot replacement
    `gaze quieted, ochre age-warmth, edges feathered, figure centered, stillness folded, distance receding, calm uncertain`
- The curve also showed wasted turns: iterations 8-11 mostly stayed below the
  iteration-7 elite.

Change:

- Text outputs now default to compact activation-code genotypes: 6-8
  comma-separated phrase units, 10-18 words total, no explanatory sentence.
- Text mutation prompts treat comma-separated units as genotype slots and ask
  agents to mutate only the requested slot.
- Added text-specific refinement operators:
  - `syntax-order exploit`
  - `slot-library exploit`
  - `slot-crossover exploit`
- Replaced pure refinement round-robin for text outputs with a short-run
  exploit front:
  - candidate 1: syntax/order exploit
  - candidate 2: slot-library exploit
  - candidate 3: operator-fitness exploit
  - candidate 4: elitist point mutation
  - candidate 5: slot-crossover exploit
  - additional candidates rotate through the broader tail operators
- Kept non-text outputs on the generic rotating evolutionary strategy schedule.
- Hardened hosted TRIBE polling to retry transient `5xx` and `429` job-status
  responses instead of failing an otherwise useful run.
- Fixed local/TRIBE text event rendering by stripping punctuation from word
  events and adding context/sentence fields for contextualized text extraction.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

- Smoke artifact check confirmed a 2-candidate text refinement now starts with
  `syntax-order exploit` and `slot-library exploit`.

Interpretation:

- This is an architecture refinement, not just more iterations. The next real
  test should be a short cold run with a fresh runs root and no target archive
  reuse, so the result measures whether the productive operators arrive early.

## 2026-06-06 21:01 PDT - Memetic Text Micro-Mutations

Problem:

- A short real TRIBE validation of the compact scheduler did not improve enough:
  `.agent/benchmarks/mona-http-codex-schedule-v1.json`
  - setup: hosted TRIBE, Codex backend, Mona image-to-text, 4 candidates x 4
    iterations, fresh runs root, no target archive reuse
  - best neural similarity: `0.222097`
  - best text:
    `calm tension, slow gaze, aged warmth, intimate distance, muted cool haze, ambiguous light, heavy stillness`
- That confirms the user's concern: moving operators earlier helps structure the
  search, but it is not aggressive enough by itself.

Change:

- Added an opt-in memetic layer for text outputs:
  - config: `VOLTA_TEXT_MICRO_MUTATIONS`
  - benchmark flag: `--text-micro-mutations`
  - default: `0`, so normal runs do not silently spend extra TRIBE jobs
- When enabled, each generated text candidate can spawn deterministic offspring
  that are scored and judged like normal candidates.
- Current offspring operators:
  - syntax inversion (`slow gaze` -> `gaze slowed`)
  - priority-targeted axis replacement (`held gaze` -> `gaze quieted`)
  - slot priority reordering
  - density compression
- Added `generated-candidates.json` so artifacts distinguish LLM parents from
  expanded scored populations.
- Tightened plateau escape: from iteration 3 onward, if the latest completed
  turn did not set the best score, the final text candidate becomes a moonshot
  basin-jump operator.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

- Mock micro benchmark passed:
  `bun run benchmark:cold -- --backend deterministic --oracle mock --scenario seeded-text-to-text-dog --max-iterations 1 --candidate-count 2 --text-micro-mutations 2 --out .agent/benchmarks/micro-mock-v1.json`
  - candidate population expanded from 2 parents to 4 scored candidates.

Real TRIBE evidence:

- Started `.agent/benchmarks/mona-http-codex-memetic-v1.json` with hosted
  TRIBE, Codex backend, Mona image-to-text, 3 candidates, 2 micro-mutations per
  parent, and no target archive reuse.
- Stopped after the first generation because it did not beat the plain
  scheduler baseline:
  - best parent: `0.199875`
  - best micro-offspring: `0.210725`
  - plain scheduler baseline to beat: `0.222097`
- The stopped run was still useful: syntax inversion improved two parent
  candidates, while naive first-slot axis replacement hurt badly. I fixed axis
  replacement to target the highest-priority perceptual slot instead of the
  earliest matching slot.

Interpretation:

- Memetic expansion is promising only if the deterministic child operators are
  high precision. The next real trial should use the fixed priority-targeted
  axis replacement and stop quickly if first-generation offspring do not beat
  `0.222097`.

## 2026-06-06 21:20 PDT - Per-Run Text Probe Calibration

Problem:

- The fixed-priority memetic v2 run still underperformed:
  `.agent/benchmarks/mona-http-codex-memetic-v2-gen1.json`
  - setup: hosted TRIBE, Codex backend, Mona image-to-text, 3 parents, 2
    micro-mutations each, 1 generation, fresh runs root
  - best neural similarity: `0.194941`
  - best text:
    `tension stilled, gaze slowed, warmth dense, distance intimate, cool haze, calm ambiguous, texture aged`
- Fixed lexical micro-mutations are not enough. They sometimes improve a parent,
  but they are too brittle and can easily move away from the target activation.

Change:

- Added opt-in per-run text probe calibration:
  - config: `VOLTA_TEXT_PROBE_COUNT`
  - benchmark flag: `--text-probe-count`
  - default: `0`, so normal runs do not spend extra TRIBE jobs silently
- For text outputs, iteration 1 can score a universal probe library against the
  target activation before candidate generation.
- Probe scores are written incrementally under `text-probes/probe-XX.json`, with
  a sorted summary in `text-probes.json` after calibration completes.
- Probe outputs are appended to the run-local archive, so Codex candidates see
  the freshly computed basis as target-specific hints.
- Top probe elites now also enter `scores.json` as ranked outputs, so the
  pipeline can return a strong probe state directly instead of using it only as
  prompt context.

Real TRIBE evidence:

- Partial 4-probe calibration run:
  `.volta/real-probe-v2/runs/mona-image-to-text-1286c7f5`
  - stopped because hosted TRIBE stalled on probe 4
  - completed probes:
    - probe-01 `0.446713`:
      `stillness held, attention suspended, near quiet, soft ambiguity`
    - probe-02 `0.310583`:
      `gaze quieted, warm shadow, dense air, calm uncertain`
    - probe-03 `0.263460`:
      `slow pressure, muted warmth, intimate distance, heavy calm`
- Completed v3 run:
  `.agent/benchmarks/mona-http-codex-probe-v3-gen1.json`
  - setup: hosted TRIBE, Codex backend, Mona image-to-text, 3 probes, 2 Codex
    candidates, 1 generation, fresh runs root, no target archive reuse
  - best neural similarity: `0.446713`
  - selected agent: `probe-01`
  - selected output:
    `stillness held, attention suspended, near quiet, soft ambiguity`
  - Codex candidates scored lower (`0.183261`, `0.143498`), but they used the
    probe archive and produced plausible children.
- Attempted v4 3-turn probe refinement was stopped because hosted TRIBE stalled
  before completing probe 1; no useful search result.

Interpretation:

- This is the strongest generic architectural improvement so far. It is a fresh
  per-run calibration step, not old Mona state, and it gives a one-turn cold
  score near the earlier manual/probe best range.
- The current bottleneck is no longer discovering a decent text state; it is
  improving from a high-scoring probe elite. Next experiments should:
  - make the probe library adaptive/MAP-Elites-style rather than fixed order,
  - generate probe recombinations from the top 2-3 probes,
  - run refinement from `probe-01` only when hosted TRIBE is responsive,
  - implement a real Flux-backed image output path before claiming image-to-image
    results.

## 2026-06-06 21:28 PDT - Probe Recombination Trial

Change:

- Added opt-in probe recombination:
  - config: `VOLTA_TEXT_PROBE_RECOMBINATIONS`
  - benchmark flag: `--text-probe-recombinations`
- After base probes are scored, the run loop can build recombination probes from
  the best probe slots, score them, write incremental `probe-r-XX.json` files,
  and include them in the sorted probe summary and candidate ranking.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Real TRIBE evidence:

- Run: `.agent/benchmarks/mona-http-codex-probe-recomb-v1.json`
- Setup: hosted TRIBE, Codex backend, Mona image-to-text, 3 base probes, 2
  recombination probes, 1 Codex candidate, 1 generation, fresh run with target
  activation cache reused, no target archive reuse.
- Result:
  - best overall stayed `probe-01` at `0.446713`
  - best recombination was `probe-r-01` at `0.327387`:
    `attention suspended, gaze quieted, warm shadow, muted warmth`
  - second recombination was `0.189237`

Interpretation:

- Naive slot recombination does not beat the strongest base probe. The probe
  basis is valuable, but recombination needs score-aware synthesis rather than
  simple slot priority merging.
- Next direction: learn/update the probe library itself from successful probes
  and add a dedicated "probe-refinement" candidate operator that starts from the
  top probe text and mutates one slot with the judge/probe score evidence.

## 2026-06-06 21:33 PDT - Probe-Aware Cold Operators

Change:

- Added probe-aware cold-start operators for text outputs when a fresh
  `text-probe-calibration` archive exists:
  - `probe-elite point mutation`
  - `probe-elite crossover`
  - `probe-elite abstraction shift`
- Candidate prompt archive guidance now tells agents to treat probe entries as
  freshly scored target basis vectors.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

Real TRIBE evidence:

- Run: `.agent/benchmarks/mona-http-codex-probe-aware-v1.json`
- Setup: hosted TRIBE, Codex backend, Mona image-to-text, 3 probes, 2
  probe-aware Codex candidates, 1 generation, target cache reused, no target
  archive reuse.
- Result:
  - best overall stayed `probe-01` at `0.446713`
  - `probe-elite point mutation` child scored `0.348689`:
    `stillness held, attention suspended, warm shadowed dense air, soft ambiguity`
  - `probe-elite crossover` child scored `0.307248`:
    `stillness held, attention suspended, warm shadow, near quiet, soft ambiguity, distant weight`

Interpretation:

- Probe-aware operators produce sensible children and beat the earlier generic
  Codex children, but they still degrade the best probe. The high-scoring probe
  seems brittle: adding warm/dense/distance detail hurts more than it helps.
- Next direction: refine by ablation/minimal edits around the top probe, not by
  adding slots. Try shorter variants and single-token substitutions around
  `stillness held, attention suspended, near quiet, soft ambiguity`.

## 2026-06-06 22:13 PDT - Cosine Similarity Failure and Metric Redesign

Problem:

- Backrooms and dog tests exposed reward hacking: very short phrases such as
  `stillness held, near quiet` and `near quiet, soft ambiguity` scored extremely
  high by raw TRIBE cosine across unrelated image targets.
- This was not target-cache interference. Mona, backrooms, and dog used distinct
  rendered hashes:
  - Mona: `2ec115cc02085ae979b7130fc6400c1df8474480a633497fcf0dd6f73a49cfa4`
  - Backrooms: `bdd55a16ff6a02c37b66e6aedde68d8b2b0a31033dc6f0f379293a1e48f63ab0`
  - Dog: `be687eb90bd5330edc09898856139bf6869b5866a566c3c626c5a738fee9745e`

Audit findings:

- Hosted image/video target activations are already z-scored over the 20,484
  vertices: mean near `0`, std near `1`, norm near `sqrt(20484)`.
- Centered cosine is therefore effectively identical to raw cosine.
- Raw target-to-target image cosine was huge:
  - Mona vs backrooms: `0.943118`
  - Mona vs dog: `0.950194`
  - Backrooms vs dog: `0.871809`
- The three image targets are close to a shared image/video cortical prototype;
  cosine to that prototype was Mona `0.990637`, backrooms `0.963799`, dog
  `0.966222`.
- The issue is the metric: full-surface spatial cosine mostly measures shared
  modality/topographic response, not target-specific vibe.

Change:

- Reworked scoring from raw spatial cosine to a contrastive residual metric when
  contrast targets are available:
  - keep raw `neuralSimilarity` as diagnostic only,
  - build an orthonormal contrast subspace from cached contrast targets,
  - project both candidate and target out of that subspace,
  - score residual cosine as `residualSimilarity`,
  - apply a retrieval-style penalty when the candidate is closer to a contrast
    target than the actual target,
  - use `adjustedSimilarity`/`total` for ranking and stopping.
- Removed the fixed positive score floor from auxiliary terms. Coherence,
  diversity, and seed adherence now provide only tiny centered nudges.
- Updated judge prompts and added an objective guard so the judge cannot pick a
  higher raw-cosine candidate over the top adjusted-score candidate.
- Added `bun run audit:similarity` for artifact-only metric audits without
  spending TRIBE compute.

Validation:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.
- `bun run audit:similarity -- .volta/real-probe-v3/runs/mona-image-to-text-be37c3af/target.json services/orchestrator/.volta/backrooms-v1/runs/backrooms-image-to-text-3adcf9d1/target.json services/orchestrator/.volta/dog-v1/runs/dog-image-to-text-921edd86/target.json --scores=services/orchestrator/.volta/dog-v1/runs/dog-image-to-text-921edd86/iterations/001/scores.json --scores=services/orchestrator/.volta/backrooms-v1/runs/backrooms-image-to-text-3adcf9d1/iterations/001/scores.json --scores=.volta/real-probe-v3/runs/mona-image-to-text-be37c3af/iterations/001/scores.json`
  showed the raw-cosine attractors being demoted:
  - Dog `near quiet, attention suspended`: raw `0.623233`, adjusted `-0.214416`.
  - Dog `stillness held, attention suspended, near quiet, soft ambiguity`: raw
    `0.367399`, adjusted `-0.278177`.
  - Mona `stillness held, near quiet, soft ambiguity`: raw `0.691443`, adjusted
    `0.114794`.
  - Mona `stillness held, attention hovering, soft ambiguity`: raw `0.558947`,
    adjusted `0.147999`, so the more target-specific child beats the generic
    probe under the new objective.

Interpretation:

- The previous 0.84-0.88 raw similarities were not real convergence. They were
  broad image/video attractors.
- The pipeline should now optimize the target-specific residual signal. Scores
  will look much lower, but they are harder to hack and more meaningful.

## 2026-06-06 22:33 PDT - Metric Pivot Research

User challenge:

- Mona vs dog still remained too high under the one-vector residual patch
  (`0.785830` residual in the three-target audit). This means the contrastive
  residual implementation is only a partial fix.
- The deeper issue is that a single whole-cortex cosine over one target and one
  candidate is not a calibrated vibe-transfer metric. It mostly measures broad
  modality/prototype structure and creates hub candidates that are adjacent to
  many unrelated inputs.

Research-backed direction:

- TRIBE itself monitors neural prediction with Pearson-style metrics across
  held-out response samples, not one raw cosine between two arbitrary stimuli.
- Neural representation work usually compares relative response geometry
  across many conditions (RSA/RDMs) or uses noise/covariance-aware distances
  such as cross-validated Mahalanobis when repeated measurements exist.
- Cross-modal retrieval systems such as CLIP use contrastive objectives: a
  match is meaningful only relative to negatives in the batch/corpus.
- Hubness correction methods such as CSLS are directly relevant because we
  observed generic text probes that score well against everything.

Offline audit:

- Using only the saved Mona/backrooms/dog target activations, the full-vector
  raw cosines stayed very high:
  - Mona vs dog: `0.950194`
  - Mona vs backrooms: `0.943118`
  - Backrooms vs dog: `0.871809`
- Restricting comparison to the most target-discriminative TRIBE vertices
  separated the image targets much better:
  - Top 0.5% variance vertices: Mona vs dog `0.161663`, Mona vs backrooms
    `0.290031`, backrooms vs dog `-0.146823`.
  - Top 1% variance vertices: Mona vs dog `0.550141`, Mona vs backrooms
    `0.528899`, backrooms vs dog `0.044099`.
- This suggests the useful signal is present, but the current metric drowns it
  in corpus-wide visual prototype dimensions.

Proposed next algorithm:

- Replace raw/residual cosine as the main objective with a reference-calibrated
  neural retrieval score:
  1. Build a diverse calibration bank of target/candidate activations with the
     same oracle model and shape.
  2. Normalize per vertex across that bank, not within each individual vector.
  3. Remove the top shared nuisance components/prototypes learned from the
     bank.
  4. Weight vertices by empirical target-discriminative variance and eventual
     reliability.
  5. Score weighted residual similarity plus a hard-negative retrieval margin.
  6. Apply hubness correction so candidates that are close to many unrelated
     targets get penalized.
  7. Report the main 0-1 value as calibrated retrieval probability/percentile,
     not raw cosine.

Implementation note:

- This is generic. The calibration bank and hard negatives must be independent
  of Mona Lisa and should include image, text, code, and later audio examples.
  Mona/dog/backrooms become regression tests, not special-case targets.

## 2026-06-06 22:45 PDT - Fast Score v3 Implementation

Change:

- Implemented a practical calibrated retrieval scorer as the primary
  `adjustedSimilarity` when at least two same-model/same-shape contrast targets
  are available.
- The scorer now:
  - auto-discovers target-cache roots under `.volta` and
    `services/orchestrator/.volta`,
  - de-dupes repeated target hashes,
  - filters by exact oracle model and activation shape,
  - selects target-specific vertices where the target differs from the contrast
    bank,
  - centers target/candidate/negatives against the contrast prototype,
  - computes a discriminative similarity,
  - applies CSLS-style neighborhood correction,
  - applies a strong hard-negative retrieval-margin confidence gate.
- Raw `neuralSimilarity` remains diagnostic. New diagnostics include
  `calibratedSimilarity`, `discriminativeSimilarity`, `retrievalMargin`,
  `cslsSimilarity`, `hubnessPenalty`, `calibrationTargetCount`, and
  `calibrationVertexCount`.

Calibration-image experiment:

- Downloaded 9 Picsum seed images for quick online calibration exploration and
  converted them to the same 0.5s still-video format used by hosted TRIBE.
- User noted the seed names do not describe image contents and some images are
  duplicates.
- Confirmed by hash/contact sheet:
  - filenames are not semantic labels,
  - `interior.jpg` and `vehicle.jpg` were exact duplicates,
  - removed the duplicate local asset from `.volta`.
- Encoded 3 anonymous visual negatives before stopping further calibration
  spend: the files named `city`, `forest`, and `food`. These are useful only as
  unlabeled diverse negatives, not as category labels.

Audit results:

- Without extra calibration targets, the new target-pair adjusted scores are
  all zero despite high raw cosine:
  - Mona vs dog raw `0.950194`, retrieval-adjusted `0`.
  - Mona vs backrooms raw `0.943118`, retrieval-adjusted `0`.
  - Backrooms vs dog raw `0.871809`, retrieval-adjusted `0`.
- With the 3 extra anonymous visual negatives included:
  - Mona vs dog raw `0.950194`, retrieval-adjusted about `0.050554`.
  - Backrooms vs dog raw `0.871809`, retrieval-adjusted `0`.
  - Mona vs backrooms raw `0.943118`, retrieval-adjusted about `0.066696`.
- Generic phrase hacks are mostly pushed toward zero under the broader bank.
  This is conservative and may lower absolute run scores, but it blocks the
  obvious "similar to everything" failure mode.

Interpretation:

- More images do help, but only as unique, visually diverse negatives encoded
  through the same TRIBE path. They teach the scorer what "generic image
  response" looks like and make hub phrases easier to penalize.
- Bad calibration images can hurt: duplicates reduce effective diversity, and a
  tiny random bank can distort target-specific vertex selection. Future online
  calibration fetches need visual QA or hash/perceptual-hash filtering before
  TRIBE encoding.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

## 2026-06-06 23:02 PDT - Text Timing Bug Fix

Problem:

- Text rendering compressed every text payload into `0.5s`, regardless of
  length.
- `textEvents` then divided that duration across all words, so a 40-word text
  had `0.0125s` word events. This is physiologically implausible for
  local/event-based TRIBE and can create serious length artifacts.
- Hosted `/predict/text` receives only raw text from `oracle.ts`, so this bug is
  not necessarily what hosted TRIBE used internally, but Volta's renderer
  contract was wrong.

Change:

- Text rendering now uses `0.35s` per normalized word.
- Empty/no-word text still gets a single `0.35s` text event.
- Text render hashes now include a timing salt so stale target-cache entries
  produced with the old `0.5s` text timing are not silently reused.
- Added a smoke assertion that `one two three` renders as a `1.05s` text event
  with three `0.35s` word events.

Verification:

- `bun run format && bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

## 2026-06-06 23:34 PDT - Local TRIBE Switch and Cache Bug Fix

Context:

- Hosted TRIBE had stale queued jobs and a long-running text job
  `126a43eaebd5`, so we switched dog-image testing to local TRIBE.
- Resized the dog probe assets for real runs:
  - `/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256.jpg`
    (`256x180`, `4.9K`)
  - `/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256-0.5s.mp4`
    (`256x180`, `0.5s`, one frame, `6.8K`)

Bug found:

- The first local run was invalid. It reused a hosted target cache
  (`tribev2-http`, shape `[1, 20484]`) while encoding the candidate locally
  (`tribev2`, shape `[5, 20484]`).
- `cosineSimilarity` compared only the shared prefix length, so mismatched
  flattened vectors could produce a plausible-looking number.

Fix:

- Added an optional `NeuralOracle.model` id and set it for mock, hosted TRIBE,
  and local TRIBE.
- Target-cache filenames now include the oracle model id, and cache reads reject
  activations from a different oracle model.
- Local TRIBE worker now mean-pools predicted timepoints to `[1, 20484]`, same
  shape convention as hosted TRIBE.
- `cosineSimilarity` now returns `0` on vector-length mismatch instead of
  silently comparing a prefix.

Valid local result:

- Command:
  `VOLTA_TRIBE_DEVICE=mps VOLTA_DOG_IMAGE=/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256.jpg VOLTA_DOG_VIDEO=/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256-0.5s.mp4 VOLTA_ORACLE_TIMEOUT_MS=900000 bun services/orchestrator/src/benchmark-cold.ts --scenario dog-image-to-text --oracle tribe --backend deterministic --max-iterations 1 --candidate-count 1 --scoring-concurrency 1 --text-probe-count 0 --text-micro-mutations 0 --out /tmp/volta-dog-score-v4-local-mps-pooled.json`
- Completed in about `2m36s` including local model startup.
- Run id: `dog-image-to-text-17ef787e`.
- Target and candidate both used local `tribev2` with shape `[1, 20484]`.
- Candidate text:
  `Quiet visual attention, close space, muted atmosphere, with candidate a steady variation`
- Scores:
  - raw `neuralSimilarity`: `0.341410`
  - `bestAdjustedSimilarity`: `-0.052101`
  - `bestScore`: `-0.027101`

Interpretation:

- The corrected local pipeline no longer produces a false high score for the
  generic dog text candidate.
- Local MPS works and is usable for real TRIBE testing, but first-load latency
  is still significant.

## 2026-06-06 23:45 PDT - Full Agentic Dog Pipeline Smoke

Command:

`VOLTA_TRIBE_DEVICE=mps VOLTA_DOG_IMAGE=/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256.jpg VOLTA_DOG_VIDEO=/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256-0.5s.mp4 VOLTA_ORACLE_TIMEOUT_MS=900000 VOLTA_CODEX_TIMEOUT_MS=900000 bun services/orchestrator/src/benchmark-cold.ts --scenario dog-image-to-text --oracle tribe --backend codex --max-iterations 2 --candidate-count 2 --scoring-concurrency 1 --text-probe-count 0 --text-micro-mutations 0 --out /tmp/volta-dog-agentic-local-v1.json`

Result:

- Run id: `dog-image-to-text-dedb4f9c`.
- Completed in about `6m57s`.
- This was a real end-to-end agentic path: Codex candidate agents, local TRIBE
  scoring, Codex judge, and a second iteration seeded from iteration 1.
- Target was the resized dog video, encoded locally as `tribev2` with shape
  `[1, 20484]`.

Generated candidates:

- Iteration 1 candidate A:
  `still softness, direct gaze, green hush, close distance, central warmth, faint uncertainty`
- Iteration 1 candidate B:
  `soft attentive stillness, mild warmth, sparse green hush, close gaze, fuzzy light, gentle uncertainty`
- Iteration 2 candidate A:
  `soft attentive stillness, mild warmth, sparse green hush, close gaze, fuzzy fur, gentle uncertainty`
- Iteration 2 candidate B:
  `soft attentive stillness, mild warmth, sparse green hush, close gaze, pale downy texture, gentle uncertainty`

Scores:

- Best overall was iteration 1 candidate B:
  - raw `neuralSimilarity`: `0.166480`
  - `adjustedSimilarity`: `-0.233446`
  - `total`: `-0.208446`
- Iteration 2 did not improve:
  - candidate A adjusted `-0.254300`
  - candidate B adjusted `-0.271567`

Interpretation:

- We are far enough for the pipeline to run end-to-end on real local TRIBE.
- We are not far enough on quality. The generated texts are plausible human
  dog-image descriptors, but TRIBE does not rate them as close.
- Local TRIBE currently has almost no same-model calibration bank, because most
  previous calibration data is hosted `tribev2-http` and is correctly filtered
  out. The next high-leverage step is to build a small local `tribev2`
  calibration bank for dog/backrooms/Mona/anonymous negatives, then rerun the
  same agentic test.

## 2026-06-06 23:51 PDT - Direct Dog Description Probe

Question:

- Compare the agent-generated dog text activations with directly describing the
  dog image concisely.

Setup:

- Same target as `dog-image-to-text-dedb4f9c`:
  `/Users/evan/Desktop/project-volta/.volta/demo-assets/dog-256-0.5s.mp4`
- Local TRIBE with `VOLTA_TRIBE_DEVICE=mps`.
- Output saved to `/tmp/volta-dog-direct-description-probe.json`.

Results:

- Direct natural sentence:
  `A small white puppy sits in green grass, looking at the camera.`
  - raw `neuralSimilarity`: `0.166500`
  - `adjustedSimilarity`: `-0.112308`
  - `total`: `-0.092308`
- Direct comma fragments:
  `small white puppy, green grass, close gaze, soft fur, shallow background`
  - raw `neuralSimilarity`: `0.042044`
  - `adjustedSimilarity`: `-0.257216`
  - `total`: `-0.237216`
- Best agentic candidate from the full run:
  `soft attentive stillness, mild warmth, sparse green hush, close gaze, fuzzy light, gentle uncertainty`
  - raw `neuralSimilarity`: `0.166480`
  - `adjustedSimilarity`: `-0.233446`
  - `total`: `-0.208446`

Interpretation:

- A literal, concise natural sentence is materially better than the generated
  activation-code fragments on adjusted score, even though raw cosine is almost
  identical to the best agentic candidate.
- The comma-fragment literal description is worse, suggesting local TRIBE's text
  path benefits from ordinary sentence structure and context.
- Next prompt change to test: for image-to-text outputs, ask agents for concise
  natural captions first, then optionally mutate caption attributes, instead of
  defaulting to comma-separated activation codes.

## 2026-06-07 00:24 PDT - Restarted Image-to-Text Optimization Around Natural Captions

Goal reset:

- Re-test the old assumptions under the corrected scorer instead of continuing
  to optimize the old comma-fragment activation-code style.
- Treat weird behavior as a root-cause target, especially "shorter text is
  always better" and broad generic phrases matching everything.

Code changes:

- Removed the global candidate prompt default that forced every text output into
  comma-separated activation-code fragments.
- Added an image-to-text-specific prompt path that asks for one concise natural
  caption sentence grounded in the visible target image.
- Added image-to-text mutation operators that prefer literal visible anchors
  such as subject, common color, setting, gaze, texture, background, and
  framing.
- Changed image-to-text scoring priors so natural caption sentences are not
  penalized as one-slot fragment genotypes.
- Added a generic caption micro-mutation layer for image-to-text when
  `textMicroMutations` is enabled. It tests local lexical children such as
  common color normalization, camera-clause normalization, weak-adverb removal,
  size ablation/synonym swaps, and framing-phrase ablation.

Real local TRIBE evidence:

- Pre-fix one-candidate natural-caption run
  `dog-image-to-text-76a6bf0f` generated:
  `A cream-colored puppy sits in soft grass, looking gently toward the camera.`
  - raw `0.025390`
  - adjusted `-0.348762`
  - total `-0.323762`
- Caption wording ablation against the same cached dog target showed TRIBE is
  deterministic and wording-sensitive, not just "shorter is better":
  - `A little white puppy sits in green grass, looking at the camera.` raw
    `0.218783`
  - `A white puppy sits in green grass, looking at the camera.` raw `0.191198`
  - `A small white puppy in green grass looks at the camera.` raw `0.185670`
  - `A small white puppy sits in green grass, looking at the camera.` raw
    `0.166500`
  - `A small white puppy sits in green grass and looks at the camera.` raw
    `0.099711`
  - `A cream-colored puppy sits in soft grass, looking gently toward the camera.`
    raw `0.025390`
- First integrated micro-mutation run with incomplete transform coverage
  `dog-image-to-text-d1136501` selected:
  `A white puppy sits in green grass, looking at the camera in a close frame.`
  - raw `0.045868`
  - adjusted `-0.176895`
  - total `-0.151895`
- After adding generic close-frame ablation, integrated run
  `dog-image-to-text-deafc5cc` selected:
  `A white puppy sits on green grass facing the camera.`
  - raw `0.215005`
  - adjusted `-0.025531`
  - total `-0.000531`
  - parent caption was
    `A white puppy sits on green grass facing the camera in a close frame.`
    with raw `0.121085`, adjusted `-0.114168`, total `-0.089168`

Interpretation:

- Natural captioning plus TRIBE-scored local lexical evolution is much more
  promising than forcing compact activation codes for image-to-text.
- The improvement is legitimate: the winning child is a plausible caption of
  the image, and it beat its parent by removing a concrete phrase that TRIBE
  penalized.
- The system still is not near 90% adjusted similarity; the next experiment
  should run at least two iterations so the judge can seed visible specificity
  while the micro-mutation layer keeps pruning harmful wording.

## 2026-06-07 00:51 PDT - Fixed Cross-Modal Contrast Calibration Contamination

Problem found:

- The backrooms cross-input sanity check exposed a scoring bug:
  `backrooms-image-to-text-ae47d255` produced the plausible caption
  `An empty yellow room with beige carpet and fluorescent lights is framed by patterned walls.`
  but received adjusted `0` with contrast similarity `0.978568`.
- Nearest-neighbor audit showed the top contrast activations were not unrelated
  target images. They were previous dog text candidates such as
  `A white puppy sits on green grass facing the camera.` with candidate-to-
  candidate cosine about `0.976796`.
- That means image-to-text scoring was mixing generated text candidates into the
  contrast bank. Text activations are very close to other text activations, so a
  room caption was being punished for being close to dog captions. This is a
  modality artifact, not a legitimate target-specificity signal.

Code changes:

- Added `includeScoreActivations` to the calibration loader.
- The run loop now excludes prior score/candidate activations from contrast
  calibration when `inputNode.type !== outputType`. For image-to-text, contrast
  now comes from target caches / explicit target roots, not other generated
  text candidates.
- Added a minimum of six contrast targets before calibrated retrieval can
  override the score. With only two target-cache negatives, calibrated retrieval
  was too sparse and clamped plausible captions to `0`; sparse cases now fall
  back to residual / target-specificity scoring.
- Added caption reward-hack guards after a two-iteration dog run selected a
  malformed micro-child ending in `in.`:
  - malformed trailing preposition penalty in natural-caption priors
  - cleaner removes dangling prepositions after phrase ablations
  - camera-clause mutation for `and looks toward the camera`
  - close-up / close-frame / centered framing ablations
  - optional `with ...` detail ablation so added visible details can be tested
    and rejected.

Real local TRIBE evidence:

- Bad pre-fix backrooms run `backrooms-image-to-text-ae47d255`:
  - parent raw `0.164781`
  - contrast `0.978568`
  - calibrated `0`
  - adjusted `0`
- After excluding cross-modal score activations but before the sparse-calibration
  threshold, `backrooms-image-to-text-181cbbfd` still clamped adjusted to `0`
  because calibrated retrieval had only two contrast targets.
- After both fixes, `backrooms-image-to-text-bb7011ea` generated:
  `An empty yellow hallway opens into a carpeted room with patterned walls.`
  - raw `0.367514`
  - contrast `0.383887`
  - residual `0.039623`
  - adjusted `0.023250`
  - total `0.048250`
- Dog rerun under corrected scorer `dog-image-to-text-e1e881e0` selected:
  `A white puppy sits on green grass facing the camera.`
  - raw `0.215005`
  - contrast `0.230333`
  - residual `-0.004498`
  - adjusted `-0.019826`
  - total `0.005174`

Interpretation:

- This was a real scoring root-cause fix, not just a prompt tweak. The old
  contrast bank was comparing cross-modal candidates against previous generated
  text, which made natural captions appear spuriously generic.
- We still need a larger, cleaner target cache for stable adjusted scores across
  images, but sparse calibration now degrades more gracefully.
- The caption micro-mutation layer is useful beyond dog, but it needs more
  scene-general mutations for room/interior captions; the backrooms parent had
  no useful micro-child beyond optional detail ablation.

## 2026-06-07 00:56 PDT - Mona Cross-Target Check and Global-Best Final Selection

Mona real local TRIBE checks under the corrected scorer:

- One-iteration run `mona-image-to-text-6602ff27` generated:
  `A dark-haired woman in a green landscape faces forward within a close portrait.`
  - raw `0.112205`
  - contrast `0.116107`
  - residual `0.205116`
  - adjusted `0.201214`
  - total `0.226214`
- Two-iteration run `mona-image-to-text-36fc33d5`:
  - iteration 1:
    `A dark-haired woman in a black dress gazes forward before a hazy green landscape.`
    - raw `0.222616`
    - adjusted `0.229004`
    - total `0.254004`
  - iteration 2:
    `A dark-haired woman in a black dress gazes forward before a distant river landscape.`
    - raw `0.268060`
    - adjusted `0.154581`
    - total `0.179581`

Interpretation:

- The corrected scorer gives Mona a much stronger legitimate adjusted score
  than dog/backrooms so far.
- Iteration 2 increased raw cosine but worsened adjusted score; this is exactly
  why raw cosine cannot be the optimizer target.
- The loop already preserved the iteration-1 elite as the next seed, but final
  result metadata still reported the last iteration judge. Since agent IDs
  repeat across iterations (`candidate-a` can refer to different text), this
  could expose a worse final selected output even when `bestScore` was correct.

Code changes:

- Final run results now select/report the global best-scoring iteration instead
  of blindly using the final iteration judge.
- `result.candidates` now points at the best iteration's ranked outputs.
- Stored `selectedAgentId` now comes from that global-best final judge.
- The final-judge shortcut compares both agent ID and selected node because
  agent IDs repeat by iteration.

Verification:

- `bun run check` passed.
- `bun run smoke` passed.
- `bun run smoke:generic` passed.

## 2026-06-07 01:43 PDT - Calibrated Text Probe for Fast Real-TRIBE Caption Search

Added calibrated scoring support to `services/orchestrator/src/probe-texts.ts`.
The probe can now load the same target-kind-filtered contrast bank as the full
pipeline and report raw, adjusted, contrast, residual, and total scores. This is
now the cheapest real-TRIBE path for testing caption variants before spending a
full agentic run.

Mona probe against target
`.volta/benchmarks/runs/mona-image-to-text-e6cee5cd/target.json`:

- `winner-b`:
  `A dark-haired woman in a dark dress is shown from the waist up with folded hands, looking forward with a faint smile against a hazy blue-green landscape and warm cracked paint texture.`
  - raw `-0.035726`
  - contrast `-0.051222`
  - residual `0.295381`
  - adjusted `0.295381`
  - total `0.295381`
- `runner-c`:
  `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
  - raw `-0.010559`
  - contrast `-0.041332`
  - residual `0.271528`
  - adjusted `0.271528`
  - total `0.271528`
- Shorter variants lost adjusted score:
  - `b-concise` total `0.199663`
  - `c-texture` total `0.240875`
  - `portrait-texture` total `0.229240`

Interpretation:

- The calibrated probe reproduced the full pipeline score for the known Mona
  best candidates, so it is safe to use for local caption search.
- The old "shorter is better" assumption does not hold under the corrected
  scorer. The best Mona text is currently longer because it carries visible
  anchors like folded hands, faint expression, landscape, and paint texture.
- Next experiment path: use calibrated probes to mutate target-specific visual
  anchors first, then spend full agent runs only on strategies that survive
  against calibrated scoring.

Verification:

- `bun run format` passed.
- `bun run check` passed.

## 2026-06-07 01:58 PDT - Sparse Residual Scoring Fix

Dog calibrated canary probe exposed another scoring bug after the calibrated
probe landed. With only two image/video contrast targets available, the scorer
was still using residualized similarity even though CSLS retrieval calibration
correctly refused to run below six contrast targets.

Pre-fix dog probe:

- `A dog.`
  - raw `0.655368`
  - contrast `0.605439`
  - residual/adjusted `0.315888`
- `White puppy in grass.`
  - raw `0.543103`
  - contrast `0.485552`
  - residual/adjusted `0.298496`
- `A small animal sits outside in grass.`
  - raw `0.471928`
  - contrast `0.446415`
  - residual/adjusted `0.179985`

This was reward-hack-shaped behavior: short category labels were being
over-amplified by projecting against a tiny, underdetermined contrast basis.

Code changes:

- `packages/core/src/scoring/activation.ts` now requires at least six contrast
  targets before using residualized similarity, matching the existing CSLS
  calibration threshold.
- `services/orchestrator/src/audit-similarity.ts` now passes target rendered
  kind into calibration and excludes score/candidate activations for non-text
  targets, matching the live pipeline's image-to-text calibration behavior.

Post-fix dog canary:

- `White puppy in grass.` adjusted `0.057551`
- `A dog.` adjusted `0.049929`
- `A small animal sits outside in grass.` adjusted `0.025513`
- `A white puppy sits alone in bright green grass.` adjusted `-0.024399`
- `A white puppy sits in green grass, facing the camera.` adjusted `-0.046254`

Post-fix backrooms canary:

- `An empty yellow room with beige carpet and fluorescent ceiling lights.`
  adjusted `0.001390`
- `Fluorescent lights shine over a yellow carpeted room.` adjusted `-0.016615`
- `Yellow empty room.` adjusted `-0.212414`
- `An empty room.` adjusted `-0.216116`

Target-pair audit after target-kind filtering:

- Mona ↔ dog raw `0.947266`, adjusted `-0.105467`
- Mona ↔ backrooms raw `0.928585`, adjusted `-0.142831`
- Dog ↔ backrooms raw `0.863199`, adjusted `-0.273601`

Interpretation:

- The corrected adjusted scorer now separates unrelated image targets even when
  raw TRIBE cosine is extremely high.
- Sparse contrast banks should be treated as target-specificity margins only;
  residual and retrieval calibration need enough contrast geometry.
- Short phrases can still win for a simple target, but they are no longer
  inflated into large false progress. The next generator work should optimize
  for grounded, visible captions while adding explicit minimum-content guards
  only as output-quality constraints, not as a hidden scoring hack.

Verification:

- `bun run check` passed.
- Real local TRIBE dog canary passed via
  `/tmp/volta-dog-sparse-residual-fix-probe.json`.
- Real local TRIBE backrooms canary passed via
  `/tmp/volta-backrooms-sparse-residual-fix-probe.json`.
- Target-pair audit passed with target-kind-filtered calibration.

## 2026-06-07 02:35 PDT - Adaptive Image-to-Text Micro-Search

Changed the image-to-text search architecture from blind pre-score expansion to
adaptive local search:

- The loop now scores generated visual captions first.
- It selects the strongest scored parents.
- It applies deterministic caption micro-mutations only to those elite parents.
- Image-to-text gets a default effective micro-search budget of `4` even when
  `VOLTA_TEXT_MICRO_MUTATIONS` is unset; this is recorded in
  `evolution-journal.json` as `effectiveLoop.textMicroMutations`.

Why:

- The previous expansion path wasted TRIBE calls on weak branches.
- The default config had `textMicroMutations: 0`, so the best dog/backrooms
  improvements only appeared when manually passing benchmark flags.
- User asked to move faster toward large matching-rate improvements without
  giving up quality.

Code changes:

- `executeIteration` now performs staged scoring:
  1. generate Codex candidate captions,
  2. score base candidates,
  3. mutate only scored elite parents,
  4. score micro-candidates,
  5. rank the combined population.
- Added a complete-sentence guard for image-to-text prompts and scoring priors.
- Added `caption-subject-setting-compression` for dog-like subject/setting
  captions.
- Added `caption-direct-scene-normalization` for room/hallway scene captions,
  including camera/meta phrase stripping and relation cleanup.

Real local TRIBE validation:

- Dog adaptive run `dog-image-to-text-2e19caca`:
  - parent:
    `A cream puppy sits on green grass, looking toward the camera in a close frame.`
    adjusted `-0.138424`
  - selected adaptive micro-child:
    `A puppy sits in green grass.`
    raw `0.481451`, adjusted `0.042371`, total `0.052371`
- Backrooms adaptive run `backrooms-image-to-text-fef83137`:
  - parent:
    `A front view shows an empty yellow room opening to patterned walls and beige carpet.`
    adjusted `-0.050647`
  - first micro-child:
    `An empty yellow room opening to patterned walls and beige carpet.`
    adjusted `-0.027684`, but lost total score because it lacked a simple finite
    verb under the quality guard.
  - probe-confirmed fix:
    `An empty yellow room opens to patterned walls and beige carpet.`
    adjusted `-0.018743`, better than the participial form and higher quality.

Interpretation:

- This is a bigger improvement path than hand-tuning one caption: first score
  what the visual agent actually sees, then spend local search budget only
  around the strongest visual parent.
- The quality guard prevented a reward-hacky participial fragment from winning
  by total score; the follow-up rewrite preserved the improved adjusted score
  while making the output a real caption sentence.
- Next step: run Mona through the adaptive path and use the same probe-first
  discipline to add any high-impact portrait/painting caption operators.

Verification:

- `bun run check` passed.
- `bun run smoke` passed before the relation cleanup; `bun run check` passed
  again after it.
- Real local TRIBE dog run completed:
  `/tmp/volta-dog-agentic-adaptive-micro-v1.json`.
- Real local TRIBE backrooms run completed:
  `/tmp/volta-backrooms-agentic-adaptive-micro-v1.json`.
- Real local TRIBE relation probe completed:
  `/tmp/volta-backrooms-opens-probe-v1.json`.

## 2026-06-07 02:57 PDT - Short Caption Throughput and Mona Portrait Operator

Mona adaptive run `mona-image-to-text-ab7a2e47` exposed a throughput issue:

- Candidate B was a high-quality but long caption:
  `A dark-haired woman in a dark dress sits with folded hands and looks forward, with warm light on her face before a muted green-blue landscape and cracked painted surface.`
- Local TRIBE stalled on that long text; I killed the run to avoid wasting
  compute.

Code changes:

- Tightened image-to-text prompt instructions to prefer `8-20` word complete
  caption sentences and avoid listing every visible detail.
- Tightened natural-caption priors:
  - best coherence range now targets `8-20` words instead of `8-22`;
  - captions over `24` words receive stronger penalty instead of waiting until
    `32` words.
- Added `caption-portrait-expression-grounding`, a scored portrait micro
  operator that explores folded hands, blue-green landscape, viewer-facing
  expression, and faint smile when a dark-haired-woman landscape portrait
  parent appears.

Real local TRIBE evidence:

- Mona v2 `mona-image-to-text-723aad61` showed the shorter prompt works:
  - candidate A: 13 words, adjusted `0.017229`
  - candidate B: 17 words, adjusted `0.018216`
- Portrait probe `/tmp/volta-mona-portrait-operator-probe-v1.json`:
  - current B:
    `A dark-haired woman with folded hands faces forward before a hazy green landscape under warm, cracked light.`
    adjusted `0.018216`
  - best probed portrait variant:
    `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
    adjusted `0.030773`
  - adding dress/cracked light blindly was bad: adjusted `-0.040606`
- Mona v5 `mona-image-to-text-b30173e7` confirmed the operator fires live:
  - parent:
    `A dark-haired woman in a black dress gazes forward with folded hands before a hazy landscape.`
    adjusted `0.004419`, total `0.029419`
  - selected portrait micro-child:
    `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
    adjusted `0.030773`, total `0.046773`

Interpretation:

- The adaptive micro-search is now making measurable live improvements on dog,
  backrooms, and Mona.
- The absolute adjusted scores are still far from `0.9`; under the current
  sparse image contrast bank, adjusted score is mostly a target-specificity
  margin, not a calibrated 0-1 similarity percentage.
- Next major improvement should be a richer generic image calibration bank so
  calibrated retrieval/CSLS can run for image targets. Without that, chasing
  `0.9` on the current adjusted metric is likely meaningless.

Verification:

- `bun run check` passed.
- Mona v2 completed: `/tmp/volta-mona-agentic-adaptive-micro-v2.json`.
- Mona v3 completed: `/tmp/volta-mona-agentic-adaptive-micro-v3.json`.
- Mona v4 completed: `/tmp/volta-mona-agentic-adaptive-micro-v4.json`.
- Mona v5 completed: `/tmp/volta-mona-agentic-adaptive-micro-v5.json`.

## 2026-06-07 03:07 PDT - Local Image Calibration Bank and First Calibrated Jump

Built a reusable local image calibration path:

- Added `services/orchestrator/src/build-image-calibration.ts`.
- Added root script `bun run calibration:images`.
- The builder renders `.volta/calibration-assets/images/*` with matching
  `.volta/calibration-assets/videos/*-0.5s.mp4`, encodes them through the chosen
  oracle, and writes target-cache artifacts under
  `.volta/calibration-local/target-cache`.

Why:

- Previous extra calibration images existed only as `tribev2-http` activations.
- Local runs use model `tribev2`, so the local scorer filtered the hosted
  calibration targets out.
- Local image-to-text scoring was therefore still running with only a sparse
  local image contrast bank and could not use calibrated retrieval/CSLS.

Real local TRIBE calibration build:

- Encoded 8 generic image/video targets locally:
  abstract, beach, city, food, forest, interior, mountain, portrait.
- Target-pair audit now reports `calibrationTargetCount: 11` for Mona/dog/
  backrooms image targets.
- Unrelated image pairs still have raw cosine near `0.86-0.95`, but calibrated
  adjusted similarity is `0`, which is the behavior we want.

Mona calibrated-bank probe:

- Target: `.volta/benchmarks/runs/mona-image-to-text-b30173e7/target.json`
- `portrait-micro`:
  `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
  - raw `-0.010559`
  - adjusted `0.186812`
  - total `0.208326`
  - contrast target count `10`
- `simple-portrait`:
  `A dark-haired woman sits before a hazy landscape, facing the viewer.`
  - adjusted `0.045413`
- `A dog.` control:
  - adjusted `0`
- `An empty yellow room.` control:
  - adjusted `0.031071`

Live Mona calibrated-bank run:

- Run `mona-image-to-text-3071cd1e`.
- Parent:
  `A dark-haired woman faces forward in a portrait against a muted green landscape.`
  - adjusted `0.049085`
  - total `0.094430`
  - calibration target count `11`
- Selected adaptive portrait micro-child:
  `A dark-haired woman in a dark dress sits with folded hands before a hazy blue-green landscape, facing the viewer with a faint smile.`
  - raw `-0.010559`
  - adjusted `0.186812`
  - total `0.224326`
  - calibration target count `11`

Remaining issue:

- Dog calibrated-bank control probe showed:
  - `A dog.` adjusted `0.079068`, total `0.102159`
  - `An empty yellow room.` adjusted `0.075527`, total `0.097287`
  - `A puppy sits in green grass.` adjusted `0`
- That means image-target calibration alone is not sufficient for image-to-text
  outputs. We still need candidate-side text hubness controls or a clean generic
  text-control calibration bank that is independent of per-target generated
  candidates. Do not treat dog scoring as solved yet.

Interpretation:

- This is the largest legitimate improvement so far: Mona moved from adjusted
  `0.030773` under sparse margins to adjusted `0.186812` under calibrated image
  retrieval.
- The path toward high scores is now clearer: improve calibration geometry and
  candidate-side hubness controls, then continue adaptive generation.
- The `0.9` target should not be interpreted literally until this calibrated
  score is stable across controls; otherwise we risk optimizing another broken
  scale.

Verification:

- `bun run check` passed.
- `bun run calibration:images -- --oracle mock --limit 2 --out-root /tmp/volta-calibration-mock-test`
  passed.
- `VOLTA_TRIBE_DEVICE=mps VOLTA_ORACLE_TIMEOUT_MS=900000 bun run calibration:images -- --oracle tribe --out-root .volta/calibration-local`
  encoded 8 local calibration targets.
- Target-pair audit passed with `calibrationTargetCount: 11`.
- Mona calibrated-bank probe completed:
  `/tmp/volta-mona-calibrated-bank-probe-v1.json`.
- Mona calibrated-bank run completed:
  `/tmp/volta-mona-agentic-calibrated-bank-v1.json`.
- Dog calibrated-bank control probe completed:
  `/tmp/volta-dog-calibrated-bank-probe-v1.json`.

## 2026-06-07 03:29 PDT - Text Controls, Near-Miss Gradient, and Target-Duplicate Filter

Goal:

- Move faster toward legitimate higher matching rates after the scorer fix,
  without returning to the raw-cosine reward hack where dog/room/Mona looked
  mutually close.

Changes:

- Added a real local text-control calibration bank with 16 TRIBE-encoded text
  anchors under `.volta/calibration-text/target-cache`.
- For cross-modal output-to-text scoring, calibration now includes matching
  target-medium controls plus independent text controls.
- Added a leave-one-out correction for exact calibration self-neighbors:
  generated text identical to a calibration anchor no longer treats itself as
  the nearest negative contrast.
- Added a bounded near-miss calibrated score. Full retrieval wins still receive
  full credit, but candidates with `retrievalMargin > -0.15` now receive a
  smaller CSLS/margin-based gradient instead of collapsing to zero.
- Added activation-level duplicate-target filtering at calibration load time:
  any contrast activation with cosine >= `0.995` to the current target is
  skipped even if its rendered SHA differs.
- Probe reports now expose calibrated internals (`retrievalMargin`,
  `nearMissSimilarity`, `cslsSimilarity`, hubness, selected vertex count).

Key probes:

- Dog target with text controls before near-miss gradient:
  `A dog.` adjusted `0.088607`; empty-room/hallway/portrait controls `0`.
- Dog target after near-miss gradient:
  `A dog.` raw `0.655368`, adjusted `0.170160`, total `0.180632`.
  `An empty yellow room.` remained adjusted `0`.
- Mona target after near-miss gradient:
  portrait micro-caption adjusted `0.200274`, total `0.212599`.
  `A dog.` and `An empty yellow room.` controls remained adjusted `0`.
- Partial dog agentic run `dog-image-to-text-75e0a42d` generated truthful puppy
  captions, but all detailed captions had adjusted `0`; best totals were only
  quality-prior noise (`0.025`).
- Wider dog caption ladder found a sharp text cliff:
  `A dog.` is the only positive short dog phrase found so far; variants such as
  `A dog appears.`, `A dog is in grass.`, `A puppy sits in green grass.`, and
  detailed Codex captions all scored adjusted `0`.

Bug found and fixed:

- After the partial dog run, dog probe contrast count rose from `27` to `28` and
  `A dog.` fell from adjusted `0.170160` to `0`.
- Cause: a near-duplicate dog target entered a target cache under a different
  rendered SHA and was treated as a negative contrast.
- Activation-level duplicate filtering restored contrast count to `27` and
  restored `A dog.` to adjusted `0.170160`.

Interpretation:

- The metric is now much safer: dog/room/Mona attractors are no longer winning
  simply through raw cosine.
- Image-to-text still has a cross-modal ceiling or geometry problem: quality
  natural captions can be semantically correct yet land in a text-control
  neighborhood that calibrated retrieval treats as unrelated.
- The next large architecture move should not be another caption prompt tweak.
  It should either:
  1. create a controlled semantic-anchor representation for image-to-text with
     explicit quality guardrails, or
  2. invest in same-medium image output / generated visual candidates where
     TRIBE can plausibly reach high calibrated similarity.

Verification:

- `bun run calibration:texts -- --oracle mock --limit 3 --out-root /tmp/volta-calibration-text-mock-test`
  passed.
- `VOLTA_TRIBE_DEVICE=mps VOLTA_ORACLE_TIMEOUT_MS=900000 bun run calibration:texts -- --oracle tribe --out-root .volta/calibration-text`
  encoded 16 local TRIBE text controls.
- `bun run check` passed after scoring/calibration changes.
- Dog near-miss probe completed:
  `/tmp/volta-dog-nearmiss-probe-v1.json`.
- Mona near-miss probe completed:
  `/tmp/volta-mona-nearmiss-probe-v1.json`.
- Dog duplicate-filter probe completed:
  `/tmp/volta-dog-duplicate-filter-probe-v1.json`.
- Dog short-sentence ladder completed:
  `/tmp/volta-dog-short-sentence-probe-v1.json`.

## 2026-06-07 03:49 PDT - Same-Medium Flux Image Path Reaches 90%+

Goal:

- Stop spending cycles on image-to-text caption syntax after probes showed a
  hard calibrated cliff, and test a larger architecture move that can plausibly
  reach the 90% target legitimately.

Changes:

- Added Flux image materialization for image outputs:
  candidates may emit `flux://generate?prompt=...&model=klein&steps=4&seed=N`.
  The orchestrator downloads the PNG into the run's `generated-assets`, creates
  a 0.5s still MP4 with `ffmpeg`, then scores the materialized image/video with
  TRIBE.
- Added image-to-image cold-start mutation strategies focused on visual
  reconstruction, composition locking, and semantic visual anchors.
- Added `dog-image-to-image` to the cold benchmark scenarios.
- Added opt-in residual-adjusted similarity for same-type transfers. This is
  enabled in the run loop when `inputNode.type === output.outputType`, and is
  reported by audit/observability.

Why residual adjustment:

- The image contrast bank is highly correlated, so raw image cosine is too high
  for unrelated image pairs and calibrated retrieval margin can undercount very
  good generated image matches.
- For generated image outputs scored against Mona/backrooms/dog, residual
  similarity separated the dog target cleanly:
  - generated dog vs Mona: adjusted `0`
  - generated dog vs backrooms: adjusted near `0`
  - generated dog vs dog: residual-adjusted `0.897685` in audit and
    `0.915700` in the live run.
- Cross-modal image-to-text does not opt into this residual adjustment.

Real pipeline result:

- Run: `dog-image-to-image-217fac49`
- Command:
  `VOLTA_TRIBE_DEVICE=mps VOLTA_ORACLE_TIMEOUT_MS=900000 VOLTA_CODEX_TIMEOUT_MS=900000 bun services/orchestrator/src/benchmark-cold.ts --scenario dog-image-to-image --oracle tribe --backend codex --candidate-count 1 --max-iterations 1 --scoring-concurrency 1 --out .agent/benchmarks/dog-image-to-image-flux-v3.json`
- Backend: Codex candidate + hosted Flux image generation + local TRIBE.
- Budget: 1 candidate, 1 iteration.
- Result:
  - raw neural similarity `0.9944315414496577`
  - adjusted similarity `0.9156999532069358`
  - total `0.9478756307010454`
  - selected `candidate-a`
- Generated image:
  `.volta/benchmarks/runs/dog-image-to-image-217fac49/generated-assets/candidate-a/189216630f921b5f.png`

Interpretation:

- This is the first legitimate 90%+ pipeline result. It is not a text reward
  hack: the output is a generated image that visually matches the dog target,
  and the same run uses real local TRIBE scoring.
- The result is currently same-medium image-to-image, not image-to-text. That
  matters: image-to-text still appears bottlenecked by TRIBE text geometry and
  should be treated as a separate research/scoring problem.
- Next experiments should improve efficiency and generality:
  1. small Flux population sweeps with prompt/seed inheritance,
  2. target-specific visual prompt extraction for arbitrary images,
  3. better same-medium image calibration so retrieval margin and residual agree
     more often,
  4. avoid running large Flux populations until one-candidate/three-candidate
     results justify the cost.

Verification:

- `bun run check` passed after Flux/residual scoring changes.
- Flux endpoint returned a valid PNG for a single dog prompt.
- Local TRIBE direct image encode failed on MPS for raw PNG; still-video scoring
  fixed this path.
- `dog-image-to-image-flux-v1.json` completed before residual adjustment:
  adjusted `0.441136`, raw `0.991506`.
- `dog-image-to-image-flux-v2.json` completed with image-specific strategy:
  adjusted `0.441563`, raw `0.994105`.
- `dog-image-to-image-flux-v3.json` completed with same-medium residual
  adjustment:
  adjusted `0.915700`, total `0.947876`.

## 2026-06-07 03:55 PDT - Backrooms Image-to-Image Generality Check

Goal:

- Verify the same-medium Flux path on a second image target so the dog result is
  not mistaken for a dog-specific solution.

Changes:

- Added `backrooms-image-to-image` to the cold benchmark scenarios.
- Tightened image-to-image prompt strategy and agent instruction to preserve
  low-resolution/documentary camera quality, crop, wall/door geometry, and to
  avoid beautified stock-photo drift.

Runs:

- `backrooms-image-to-image-a9c434ac`
  - one Codex candidate, one Flux image, one local TRIBE score
  - raw `0.9506153325779538`
  - adjusted `0.4983757032799178`
  - total `0.5241022680094588`
  - generated image was plausible backrooms but too polished/detailed.
- `backrooms-image-to-image-748f00c9`
  - after prompt tightening
  - raw `0.978212141163511`
  - adjusted `0.5516443498118855`
  - total `0.5778119015972889`
  - generated image better matched the door/right-wall/fluorescent geometry, but
    still too high-resolution and richly detailed compared with the target.

Interpretation:

- The Flux image path is generic enough to run on multiple image targets.
- One-shot 90% is not guaranteed for harder geometry. The next improvement
  should be a small image population search (3-5 prompts/seeds) with visual
  prompt inheritance, not another single prompt tweak.
- For backrooms specifically, candidate prompts should emphasize low-res
  surveillance/documentary crop, sparse empty geometry, fewer ceiling details,
  and target-like open room depth.

Verification:

- `bun run check` passed before the backrooms v2 run.
- Backrooms v1 report: `.agent/benchmarks/backrooms-image-to-image-flux-v1.json`
- Backrooms v2 report: `.agent/benchmarks/backrooms-image-to-image-flux-v2.json`

## 2026-06-07 03:59 PDT - Backrooms 3-Candidate Population Check

Goal:

- Test whether a tiny Flux population improves the harder backrooms
  image-to-image target without a long run.

Run:

- `backrooms-image-to-image-0ba5857e`
- 3 Codex candidates, 1 iteration, serial Flux/TRIBE scoring.
- Result:
  - best candidate `candidate-a`
  - raw `0.9706166108391445`
  - adjusted `0.5598353008866586`
  - total `0.5858477722632702`
- Candidate C was nearly tied:
  - adjusted `0.5589308513390606`
  - raw `0.9754576990589982`

Interpretation:

- Simple prompt/seed diversity did not materially improve over the one-candidate
  backrooms v2 run (`0.551644` adjusted).
- The generated images are plausible backrooms-like interiors, but Flux keeps
  adding richer hallway/door geometry and cleaner high-detail composition than
  the target's small, sparse, low-resolution room crop.
- Next backrooms-specific architecture should use either:
  1. stronger visual prompt extraction from the target image,
  2. reference-conditioned image generation/editing instead of text-only Flux,
  3. a crop/low-resolution postprocess operator before TRIBE scoring, or
  4. a multi-iteration loop where the judge receives visual thumbnails and
     explicitly penalizes hallway/cinematic drift.

Verification:

- Report: `.agent/benchmarks/backrooms-image-to-image-flux-v3-pop3.json`

## 2026-06-07 04:15 PDT - Target-Style Image Rendering Fix

Goal:

- Move same-medium image matching toward legitimate high scores without
  hard-coding a target or using old states.

Finding:

- Generated Flux candidates were always rendered/scored as square 512x512 still
  videos, while image targets keep their source-style video geometry.
- The backrooms and dog targets both score as 250x188 videos. Postprocessing a
  candidate back to the target geometry materially improved TRIBE similarity,
  which means render-boundary style was a real generic mismatch, not just prompt
  noise.
- Score archive calibration also leaked prior same-target outputs when the
  target was rendered through a different path/sha. That could punish good
  candidates or contaminate contrast banks. The loader now skips archived score
  files whose source target activation is a near-duplicate of the current target,
  not just exact sha matches.

Change:

- Image-to-image Flux candidates now inherit the target rendered video geometry:
  the raw Flux PNG is preserved, a `*-target-style.png` is scaled/cropped to the
  target dimensions, and the scored 0.5s video is encoded at that same geometry.
- The candidate entropy records `targetStyle=<width>x<height>` so these runs are
  auditable.

Runs:

- `backrooms-image-to-image-dcb0831c`
  - one Codex candidate, one Flux image, one local TRIBE score
  - raw `0.9796106897102876`
  - adjusted `0.7060327167800182`
  - total `0.7315710974656411`
  - output: `.volta/benchmarks/runs/backrooms-image-to-image-dcb0831c/generated-assets/candidate-a/d2629fbeaf3fcc74-target-style.png`
  - prior best on the same scenario was `0.5598353008866586` adjusted with a
    3-candidate population, so this is a large one-turn improvement.
- `dog-image-to-image-54481a08`
  - one Codex candidate, one Flux image, one local TRIBE score
  - raw `0.9970680558909037`
  - adjusted `0.9652789874348456`
  - total `0.9948509124680877`
  - output: `.volta/benchmarks/runs/dog-image-to-image-54481a08/generated-assets/candidate-a/05342b58e050d601-target-style.png`

Cross-target audit:

- Real TRIBE target pairs still show high raw cosine across images, but
  residual-adjusted scoring suppresses the false positives:
  - Mona -> backrooms adjusted `0.04191216686716267`
  - Mona -> dog adjusted `0.00000046124201867109683`
  - Backrooms -> dog adjusted `0`
- Styled dog output:
  - vs dog adjusted `0.9591713892811988`, total `0.9863277677887478`
  - vs backrooms adjusted `0`, total `0`
  - vs Mona adjusted `0`, total `0`
- Styled backrooms output:
  - vs backrooms adjusted `0.5920127862880633`, total `0.614178336853687`
  - vs dog adjusted `0.20173755480755992`, total `0.20173755480755992`
  - vs Mona adjusted `0`, total `0`

Interpretation:

- This is a generic render-boundary fix, not a dog-specific optimization.
- Dog reached the 90% adjusted target in a single turn under the corrected
  scorer. Backrooms improved substantially but remains below target because Flux
  still beautifies/adds geometry; next work should add reference-aware image
  prompting/editing or score multiple postprocess operators rather than only
  increasing iterations.

Verification:

- `bun run check` passed.
- Reports:
  - `.agent/benchmarks/backrooms-image-to-image-style-v1.json`
  - `.agent/benchmarks/dog-image-to-image-style-v1.json`

## 2026-06-07 04:40 PDT - Image Fidelity Filter and Seed-Child GA Probe

Goal:

- Push same-medium image matching higher without target-specific cheating, then
  verify the gains against dog/backrooms cross-target controls.

Changes:

- Added a conservative target-fidelity postprocess for small target-style image
  outputs: after Flux generation and target-geometry scaling/cropping, the
  scored image is softened and slightly muted (`targetFidelity=soft-muted`).
  Raw Flux PNGs and target-style intermediates remain on disk for audit.
- Added an opt-in image genetic operator:
  `VOLTA_IMAGE_SEED_MUTATIONS=<n>` creates same-prompt Flux seed children from
  the best scored image parent. It is off by default.
- Fixed image seed-child parent selection so mutations use the original
  generated Flux URI instead of the already-materialized local PNG.

Offline probe:

- Applying `soft-muted` to an existing strong backrooms candidate improved its
  run-style adjusted score from about `0.697` to `0.7350629136532122`.
- Heavy low-res/coarse degradation hurt (`0.5181005972702428` and
  `0.47319865453330817` adjusted), so the useful operator is conservative
  softening/muting, not blanket degradation.
- Dog soft/muted probe stayed high and improved slightly:
  adjusted `0.9699466406512799`.

Real runs:

- `backrooms-image-to-image-b8382507`
  - one candidate, fidelity filter enabled
  - adjusted `0.5875286458688272`
  - interpretation: postprocess cannot rescue a weak generated composition.
- `backrooms-image-to-image-33cf8bc1`
  - one Codex prompt plus two Flux seed children
  - adjusted `0.6368204044715934`
  - seed children were scored, but neither beat the parent. Useful architecture
    knob, not currently the strongest operator for this Flux backend.
- `backrooms-image-to-image-fcfaf007`
  - three prompt-family candidates, one iteration, fidelity filter enabled
  - best candidate `candidate-c`
  - raw `0.992088157197358`
  - adjusted `0.7831973749206479`
  - total `0.8090943031725147`
  - output: `.volta/benchmarks/runs/backrooms-image-to-image-fcfaf007/generated-assets/candidate-c/d3eb69ba5a498019-target-fidelity.png`
  - this beats the prior backrooms best (`0.7060327167800182` adjusted) and the
    earlier 3-candidate style-only run (`0.6973838375005834` adjusted).
- `dog-image-to-image-0f2c017d`
  - one candidate, fidelity filter enabled
  - raw `0.9989522584332954`
  - adjusted `0.9924409428594287`
  - total `1.0223720034003638`
  - dog remains above 90% in one turn.

Cross-target audit:

- Dog fidelity output:
  - vs dog adjusted `0.9895345701504914`, total `1.0167254526173715`
  - vs Mona adjusted `0`, total `0`
  - vs backrooms adjusted `0.10436777712491818`, total `0.10436777712491818`
- Backrooms fidelity-population winner:
  - vs backrooms adjusted `0.81216244900834`, total `0.8362080469521576`
  - vs dog adjusted `0`, total `0`
  - vs Mona adjusted `0.2751004113629446`, total `0.2751004113629446`

Interpretation:

- The largest backrooms jump came from combining prompt-family population
  diversity with target-style/fidelity rendering, not from seed-only mutation.
- The seed-child genetic operator is now available as a knob, but the current
  evidence says it should not be the default expensive move.
- Backrooms still has a moderate Mona false-positive in audit scoring and is
  still below the 90% adjusted goal. Next improvement should use judge-informed
  second-turn refinement or reference-conditioned image generation/editing,
  because Flux text prompts still miss target geometry.

Verification:

- `bun run check` passed.
- Reports:
  - `.agent/benchmarks/backrooms-image-to-image-fidelity-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-seedmut-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-seedmut-v2.json`
  - `.agent/benchmarks/backrooms-image-to-image-fidelity-pop3-v1.json`
  - `.agent/benchmarks/dog-image-to-image-fidelity-v1.json`

## 2026-06-07 05:00 PDT - Image Refinement Attachment and Visual Strategy Pass

Goal:

- Test whether the image-to-image loop can keep climbing after the strong
  one-turn backrooms population result by giving refinement agents better visual
  context and image-specific operators.

Changes:

- Candidate refinement agents now attach the previous selected visual output in
  addition to the target image. Before this, judges could inspect candidate
  images, but next-turn candidate agents only received the target attachment and
  a JSON path for the previous seed.
- The refinement prompt now explicitly tells visual candidates to compare the
  target and previous output, preserve what worked, and correct one visible miss.
- Added image-to-image refinement strategies instead of routing image refinement
  through text-centric slot/crossover strategies. This exposed an important
  result: visual strategies are less wrong, but the current Flux backend still
  often regresses when asked to refine an already-good generated image.

Runs:

- `backrooms-image-to-image-f42a6a6b`
  - fresh run: 3 candidates, 2 iterations, real local TRIBE
  - iteration 1 best:
    - candidate `candidate-b`
    - adjusted `0.7692867610540317`
  - iteration 2 best / global elite:
    - candidate `candidate-b`
    - raw `0.9950067411446626`
    - adjusted `0.8566271777650765`
    - total `0.8823599576974804`
    - output: `.volta/benchmarks/runs/backrooms-image-to-image-f42a6a6b/generated-assets/candidate-b/c01482ad2fc8c8e7-target-fidelity.png`
- Resume iteration 3, before image-specific strategy routing:
  - best adjusted `0.7664577338001334`
  - global best remained iteration 2.
  - failure mode: candidates used text-centric entropy such as
    `slot-library exploit` and `slot-crossover exploit`.
- Resume iteration 4, with image-specific strategies:
  - best adjusted `0.8074342497833789`
  - global best remained iteration 2.
- Resume iteration 5, with prioritized visual strategies:
  - best adjusted `0.6585476451299261`
  - global best remained iteration 2.

Cross-target audit for the 0.856 elite:

- Backrooms elite:
  - vs backrooms adjusted `0.8681585985863489`, total
    `0.8923704671238818`
  - vs Mona adjusted `0`, total `0`
  - vs dog adjusted `0`, total `0`
- Dog fidelity sanity output still stays specific:
  - vs dog adjusted `0.9895345701504914`, total `1.0167254526173715`
  - vs Mona adjusted `0`, total `0`
  - vs backrooms adjusted `0.10436777712491818`, total
    `0.10436777712491818`

Interpretation:

- The system now reaches `0.8566` adjusted on the harder backrooms image in two
  turns, without direct target copying and with clean Mona/dog guardrails for the
  winning output.
- Later refinement turns do not currently help. The issue is no longer just
  missing visual attachment; the generator tends to drift or over-correct from a
  good image. The next high-impact move should be elitist image replay plus
  reference-conditioned/editing generation, or a stricter judge that can reject
  geometry drift before TRIBE scoring.
- We are close to 90 but not there on the hard case. Dog is already above 99%
  adjusted in one turn.

Verification:

- `bun run check` passed.
- Reports:
  - `.agent/benchmarks/backrooms-image-to-image-refine2-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-refine3-resume-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-refine4-resume-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-refine5-resume-v1.json`

## 2026-06-07 05:12 PDT - Target-Aspect Flux Generation

Goal:

- Remove another render/generation mismatch: Flux was generating square images
  and the materializer was cropping them down to the target aspect. The hosted
  Flux API supports `width` and `height`, so image-to-image runs can generate at
  the target aspect before target-style/fidelity scoring.

Change:

- For image-to-image candidates with a target render geometry, Flux generation
  now requests a target-aspect size up to 768 px on the long side. For the
  backrooms/dog 250x188 targets this becomes `768x576`.
- The generation size is part of the cache key, so old square generations are
  not reused accidentally.
- Candidate entropy records `fluxSize=<width>x<height>`.

Runs:

- `backrooms-image-to-image-cb8068ad`
  - 3 candidates, 1 iteration, real local TRIBE
  - best candidate `candidate-b`
  - raw `0.990592392604175`
  - adjusted `0.8222376890532574`
  - total `0.8478646348823649`
  - output: `.volta/benchmarks/runs/backrooms-image-to-image-cb8068ad/generated-assets/candidate-b/aedc0aee51daa8e0-target-fidelity.png`
  - raw Flux image was `768x576`; scored target-fidelity image was `250x188`.
- `backrooms-image-to-image-70009e94`
  - 3 candidates, 2 iterations, real local TRIBE
  - best adjusted `0.7027960540178082`
  - interpretation: target-aspect generation improved one-turn potential but
    does not guarantee a strong first population; this run started weaker and
    refinement did not recover.
- `dog-image-to-image-57dfe8fe`
  - one candidate, one iteration
  - raw `0.9980048695231954`
  - adjusted `0.9759573456741`
  - total `1.003348083095347`

Cross-target audit:

- Target-aspect backrooms winner:
  - vs backrooms adjusted `0.8390786598456733`, total
    `0.86241251710694`
  - vs Mona adjusted `0`, total `0`
  - vs dog adjusted `0`, total `0`
- Target-aspect dog winner:
  - vs dog adjusted `0.9660912372365351`, total `0.9932793246673197`
  - vs Mona adjusted `0`, total `0`
  - vs backrooms adjusted `0`, total `0`

Interpretation:

- Target-aspect Flux generation is a real generic render-boundary fix and gives
  a new one-turn backrooms high of `0.8222` adjusted.
- The current best overall backrooms result is still the earlier 2-turn elite at
  `0.8566` adjusted. The remaining bottleneck is not aspect alone; it is
  reliable first-population quality and avoiding drift in refinement.

Verification:

- `bun run check` passed.
- Reports:
  - `.agent/benchmarks/backrooms-image-to-image-aspect-pop3-v1.json`
  - `.agent/benchmarks/backrooms-image-to-image-aspect-refine2-v1.json`
  - `.agent/benchmarks/dog-image-to-image-aspect-v1.json`

## 2026-06-07 05:23 PDT - Mona Image-to-Image Crosses 90%

Goal:

- Test whether the current generic image pipeline transfers beyond dog and
  backrooms, especially on the original Mona Lisa image target with a portrait
  aspect ratio.

Runs:

- `mona-image-to-image-3cfc3df6`
  - 3 candidates, 1 iteration, real local TRIBE
  - best candidate `candidate-a`
  - raw `0.9916074730072918`
  - adjusted `0.8806289378573523`
  - total `0.9079646510321191`
  - target style `224x334`, Flux size `512x768`
- `mona-image-to-image-b589e7ab`
  - 3 candidates, 2 iterations, real local TRIBE
  - iteration 1 best adjusted `0.8794157095396233`
  - iteration 2 best / global best:
    - candidate `candidate-b`
    - raw `0.9969552321193252`
    - adjusted `0.924734450983557`
    - total `0.9518773390209511`
    - output: `.volta/benchmarks/runs/mona-image-to-image-b589e7ab/generated-assets/candidate-b/09faba95aeb00272-target-fidelity.png`

Cross-target audit:

- Mona winner:
  - vs Mona adjusted `0.9333990578812487`, total
    `0.9611737139436194`
  - vs backrooms adjusted `0.3586144489183148`, total
    `0.3586144489183148`
  - vs dog adjusted `0`, total `0`
- Backrooms target-aspect winner remains clean:
  - vs backrooms adjusted `0.8390786598456733`, total
    `0.86241251710694`
  - vs Mona adjusted `0`, total `0`
  - vs dog adjusted `0`, total `0`
- Dog target-aspect winner remains clean:
  - vs dog adjusted `0.9660912372365351`, total
    `0.9932793246673197`
  - vs Mona adjusted `0`, total `0`
  - vs backrooms adjusted `0`, total `0`

Interpretation:

- The generic image pipeline can now legitimately cross 90% adjusted similarity
  on a non-dog, non-backrooms image target in 2 turns.
- This is not just a universal attractor: the Mona winner has dog adjusted `0`,
  and the dog/backrooms winners are specific. The Mona winner does retain a
  moderate backrooms false-positive (`0.3586`), so guardrails still matter.
- Current bests:
  - dog: `0.9924` adjusted in 1 turn
  - Mona: `0.9247` adjusted in 2 turns
  - backrooms: `0.8566` adjusted in 2 turns

Verification:

- `bun run check` passed.
- Reports:
  - `.agent/benchmarks/mona-image-to-image-aspect-pop3-v1.json`
  - `.agent/benchmarks/mona-image-to-image-aspect-refine2-v1.json`

## 2026-06-07 05:55 PDT - Elitist Image Local Mutation

Goal:

- Move faster on the hard image-to-image case without reward hacking or burning
  unnecessary Flux calls while the hosted image service is unstable.

Changes:

- Added two generic image cold-start strategies:
  - `image low-fidelity target style`
  - `image absence and sparsity lock`
- Added retry handling for transient Flux `408`, `429`, and `5xx` responses.
- Isolated per-candidate scoring failures so one failed Flux/materialization
  candidate writes `<agentId>.error.json` instead of killing the whole
  population. The iteration still fails if every candidate fails.
- Exposed image mutation knobs in the benchmark harness:
  - `--image-seed-mutations`
  - `--image-local-mutations`
  - env: `VOLTA_IMAGE_LOCAL_MUTATIONS`
- Defaulted `imageLocalMutations` to `1`, so image-to-image runs get one
  cheap scored local postprocess child by default. This does not add Flux calls.
- Added an explicit `elite-replay` candidate on refinement turns so the
  previous selected elite participates in ranking, archive updates, judging, and
  local mutation. This makes the loop genuinely elitist instead of relying only
  on a post-hoc global-best override.
- Added local image-style mutations:
  - Flux prompt descendants can set `voltaStyle=<style>` and reuse a shared
    run-level raw Flux cache under `generated-assets/_raw`.
  - Local rendered image descendants can use internal
    `volta-style://image?src=...&style=...` URIs, so replayed elites can be
    postprocessed without Flux.
  - Local replay mutations use the unfiltered `*-target-style.png` sibling when
    available to avoid stacking filters on top of `*-target-fidelity.png`.
  - Empirical variant order now tries `crisp-neutral` first.

Runs and probes:

- Hosted Flux health check is still failing:
  - `https://images.bryanhu.com/health -> error code: 502`
- A 5-candidate backrooms run attempted before failure isolation could not
  complete because the image host returned Cloudflare `502`.
- Local ffmpeg filter smoke passed for `soft-muted-strong`, `flat-warm`,
  `flat-cool`, and `crisp-neutral`.
- Direct materializer smoke passed for a child image mutation:
  - `candidate-b-image-1`
  - output:
    `.volta/benchmarks/runs/backrooms-image-to-image-cb8068ad/generated-assets/candidate-b-image-1/aedc0aee51daa8e0-target-crisp-neutral.png`
  - no hosted Flux call after the shared raw cache existed.

Real local TRIBE probes:

- On cached backrooms parent
  `backrooms-image-to-image-cb8068ad` / `candidate-b`:
  - default `soft-muted`: adjusted `0.8299616970091929`, total
    `0.8506138112650937`
  - `style-only`: adjusted `0.7932027622395679`
  - `soft-muted-strong`: adjusted `0.6113269896215473`
  - `flat-warm`: adjusted `0.8294251141322622`
  - `flat-cool`: adjusted `0.8041630687048694`
  - `crisp-neutral`: adjusted `0.8484280146268046`, total
    `0.8692264422681254`
- On stronger backrooms elite
  `backrooms-image-to-image-f42a6a6b` / iteration 2 `candidate-b`:
  - previous stored adjusted `0.8566271777650765`, total
    `0.8823599576974804`
  - `crisp-neutral`: adjusted `0.8629998557657745`, total
    `0.8836278475705585`
  - `flat-warm`: adjusted `0.8300318100737368`
  - `style-only`: adjusted `0.8033783734044497`
  - `flat-cool`: adjusted `0.8469416035507983`

Interpretation:

- `crisp-neutral` is a real, generic low-cost local operator. It improved a
  cached backrooms parent by about `+0.0185` adjusted and the stronger elite by
  about `+0.0064` adjusted without copying the target or calling Flux.
- More muting is not generally good. `soft-muted-strong` was destructive, and
  `style-only` consistently lost score, so the operator should be scored, not
  assumed.
- This does not get backrooms to 90 yet, but it improves exploitation speed,
  makes refinement more elitist, and lets the pipeline keep making useful local
  progress even when image generation is flaky.

Verification:

- `bun run check` passed.
- `bun run smoke` passed; smoke now reports `candidateCount: 3` because
  refinement includes `elite-replay`.

## 2026-06-07 06:10 PDT - Cross-Modal Text Scoring Signal

Goal:

- Investigate why image-to-text matching stayed at adjusted `0` despite
  plausible captions, and restore a real optimization signal without pretending
  cross-modal text is near 90%.

Run:

- `backrooms-image-to-text-99b32f0f`
  - 3 candidates, 1 iteration, real local TRIBE, Codex backend
  - best before scorer fix:
    - `candidate-a`
    - raw `0.27045467076671204`
    - adjusted `0`
    - total `0.025`
  - best raw candidate was actually `candidate-b`:
    - text:
      `An empty fluorescent-lit room opens into beige carpeted corridors with pale patterned wallpaper.`
    - raw `0.3200514004023118`
    - adjusted `0`

Diagnosis:

- The adjusted scorer was hiding all image-to-text progress.
- Text candidates had raw image-target similarity around `0.27-0.32`, but the
  contrast bank included text outputs. Those text contrasts had similarity
  around `0.90+` against any text candidate, so target specificity and calibrated
  retrieval collapsed to `0`.
- Re-scoring the saved activations with raw adjusted similarity gives usable
  rankings:
  - `candidate-b`: adjusted `0.3200514004023118`
  - `candidate-c`: adjusted `0.30016405583244027`
  - `candidate-a-micro-1`: adjusted `0.29207848344665427`
  - `candidate-a`: adjusted `0.27045467076671204`

Raw prompt probe:

- Stopped early after enough signal to avoid wasting TRIBE compute.
- Best manual probe:
  - `An empty fluorescent room opens into yellow carpeted corridors with patterned walls.`
  - raw `0.36505096903429735`
- Other probes:
  - `A vacant yellow hallway opens into carpeted rooms under flat fluorescent ceiling lights.`
    raw `0.3430135039527386`
  - comma-fragment caption raw `0.29634674170639586`
  - `Empty yellow rooms recede...` raw `0.19995159694698894`
  - abstract fragment raw `0.2014979741385558`

Changes:

- Added `useRawAdjustedSimilarity` to `scoreActivations`.
- The orchestrator enables raw adjusted similarity when input and output
  modalities differ. Same-medium runs still use the calibrated/residual path.
- `probe-texts.ts` now uses raw adjusted similarity for non-text targets.
- Added an image-to-text `spatial relation caption` strategy and tightened the
  perceptual-caption instruction around visible openings/relations.

Interpretation:

- Cross-modal image-to-text is not close to 90; the honest current raw range is
  more like `0.32-0.37` on backrooms.
- The important fix is that the loop now has a nonzero, monotonic signal for
  text evolution instead of choosing among all-zero adjusted scores.

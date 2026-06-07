# GA techniques & similarity metrics for the Volta loop (research synthesis)

Date: 2026-06-07. Source: volta-research-ga-metrics workflow (7 agents).

I now have all the grounding I need. The findings are accurate: `behaviorDescriptor`/`behaviorKey`/`bestPerBehavior` already exist in archive.ts (lines 82, 140-189, 309-316), `operatorStats` uses a cumulative mean (line 363), the loop forwards only `seedFromElite({ elite: bestAfter })` from rank-0, and `score.diversity` is the hardcoded `0.75 ? 0.5` placeholder feeding a 0.05 weight. Let me write the synthesis.

# Volta Loop — Prioritized Action Plan

Verified against the codebase: every integration point cited below exists as the findings describe. Key confirmations: `archive.ts` already computes `behaviorDescriptor`/`behaviorKey` and `bestPerBehavior()` (lines 82, 140–189, 309–316); `operatorStats()` credit is a cumulative mean over ALL entries (line 363); the loop forwards only `seedFromElite({ elite: rankedOutputs[0] })` (run.ts:273–275) so all N descend from one champion; `score.diversity` is a hardcoded `entropy ? 0.75 : 0.5` placeholder (run.ts:727) at 0.05 weight (activation.ts:54); `neuralTrajectorySimilarity` is reusable on any two traces (so candidate-vs-candidate distance is free).

---

## (1) The 3–5 highest-leverage changes, ranked by impact/cost

### #1 — Per-slot deterministic crowding + clearing-by-niche, replacing single-elite seeding. (impact: HIGH, cost: CHEAP)

This is the single root-cause fix. Six independent research tracks (diversity-preservation, quality-diversity, llm-evolution, surrogate-and-budget, neural-metrics) all converge on the same diagnosis: **`seedFromElite` makes the whole population `[elite, mutate(elite)×N]`, so every candidate orbits one point and any regressing-but-promising child is discarded.** That IS the observed "fresh mutations regress below the elite and get thrown away" plateau.

Concrete steps in `services/orchestrator/src/run.ts`:
- Stop forwarding a single global seed. Keep **N persistent lineage slots**; the `candidateSpecs` loop (run.ts:243) already gives you N stable slot IDs to hang incumbents on.
- Each iteration, candidate-`i` mutates **slot-`i`'s own incumbent** (not the global elite). After `scoreActivations`, do per-slot replacement: keep the child iff `child.score.total >= parent.score.total`. The parent is an already-scored `EvaluatedOutput` — **zero extra TRIBE calls**.
- Layer clearing on top using machinery that already exists: the niche key is `operatorFromEntropy(output.entropy)` (run.ts:1038) or `entry.behaviorKey` from archive.ts. Forward the **best candidate per distinct niche** as that lineage's seed, so N=4 slots hold up to 4 different basins instead of 4 paraphrases of one.
- Keep `bestOverallOutput(iterations)` (run.ts:312) carried **separately** purely for the reported final answer and the stop condition. This preserves `best(N+1) >= best(N)` while letting the slots diverge.

Expected effect: the regressing child now survives as its own basin's stepping stone instead of vanishing. Directly converts the plateau into continued climbing because the bandit stops re-mutating one champion. This is parameter-free (no `sigma_share`), the textbook fix for tiny-population + expensive-oracle.

### #2 — Fix operator credit assignment: sliding-window MAX-improvement + rank, not cumulative mean. (impact: HIGH, cost: CHEAP)

`operatorStats()` credits each operator by `totalNeuralSimilarity / count` over ALL archive entries (archive.ts:363). This is **stale** (an operator good at iter 2 keeps a high mean after it stops helping the now-stronger elite — that re-pull is itself a convergence driver) and **improvement-blind** (averaging buries the rare big jumps that break plateaus; near convergence everything is a near-tie around the elite, so the mean can't discriminate).

Concrete steps in `archive.ts` `operatorStats()` + `run.ts` `planOperators()`:
- Credit each entry with `delta = entry.neuralSimilarity − eliteSimilarityAtThatIteration`, clamped at 0 (improvement over the seed it mutated). You already persist per-entry `neuralSimilarity` + `entropy`, so this is pure post-processing.
- Replace `meanNeuralSimilarity` with **max(delta) over the last W entries** per operator (W≈6–10). Feed the **rank** of those windowed improvements into the UCB exploitation term (run.ts:1007), not the raw delta.

Why rank matters specifically for us: gains compress to +0.001–0.01/iter and `(raw+1)/2` squashes everything near 1, so raw-difference credit goes numerically tiny and `explorationWeight`-sensitive exactly at the plateau. Rank credit is invariant to monotone fitness transforms — it keeps discriminating operators when absolute deltas vanish. This also makes the hand-tuned 0.6/1.5 `explorationWeight` far less brittle. Zero new TRIBE/Codex calls.

### #3 — Make `score.diversity` REAL (Promptbreeder-style near-duplicate guard). (impact: MED-HIGH, cost: CHEAP)

`score.diversity` is a hardcoded `0.75 : 0.5` placeholder (run.ts:727) contributing a token 0.05. The plumbing is already wired — make it carry signal.

Concrete steps in `run.ts evaluateCandidate`:
- Compute `diversity = 1 − max neuralTrajectorySimilarity` from this candidate's activation to recent archive candidates (reuse `neuralTrajectorySimilarity` on two CANDIDATE traces — both cached, zero TRIBE calls; loadable via `loadCandidateArchive`, already imported).
- Add a **hard near-duplicate filter**: penalize/reject a child whose activation cosine to the current elite exceeds ~0.97. This forces the LLM operator to actually move instead of paraphrasing — directly attacks the +0.001/iter refinement-paraphrase regime.
- Keep `neuralSimilarity` dominant (quality-diversity, not pure novelty). Raising the `diversity` weight a little (0.05 → ~0.15) and keeping `neuralSimilarity` at 0.7-ish is enough.

Expected effect: penalizes the monoculture before it forms; complements #1's structural fix with a per-candidate pressure.

### #4 — Stagnation-triggered partial restart (inject a fresh cold-start lineage). (impact: MED, cost: CHEAP)

We already DETECT stagnation (`isEliteStalled`, run.ts:1051) but the response is weak — it only bumps `explorationWeight` 0.6→1.5 while still drawing from `refinementStrategies` around the same elite. Because TRIBE is deterministic, re-running the same elite **can never** escape the basin; only genuinely new material can.

Concrete steps in `run.ts`:
- Track `consecutiveStallIters`. When `isEliteStalled` holds for ≥2 iterations (k=2, not the literature's 10–20 — our M≈6 budget is tiny), replace 1–2 of the N slots' seeds with `type:"fresh"` drawn from `coldStartStrategies` (the diverse-register pool, run.ts:805) instead of `refinementStrategies`. Reset the counter on any elite gain.
- This composes cleanly with #1: the fresh lineage becomes a new niche/slot; the global elite is still carried for the final answer, so a restart can never lose ground.

### #5 (optional, do AFTER #1–#3 land) — FunSearch worst→best 2-parent prompting. (impact: MED, cost: CHEAP)

Change the candidate prompt from "mutate the elite" to showing **two parents sorted by ascending neuralSimilarity** ("here are two attempts scored X then Y; write a third that continues the improvement"). `archive.ts` already exposes `byScore()` + per-entry `neuralSimilarity` to pick the pair. Turns the LLM from a paraphraser into a directional improvement operator. Cheap, but it's a prompt-shape change whose effect is harder to measure than #1–#3, so it's a second wave.

---

## (2) Prototype FIRST — the two cheapest decisive experiments

**ONE metric change to prototype first: Linear CKA** (vertices-as-rows, timesteps-as-columns) replacing the resample-based `TRAJECTORY_WEIGHT` block in `activation.ts`.

Why this one over Procrustes/soft-DTW/RSA: it is the **cheapest** (no SVD dependency, no DP; cross-products are tiny `[T,T]` since T≈2–23, ~one cosine's cost) AND **decisive** because it natively handles T1≠T2 with no `resampleFrames()` lossy hack — which is the exact cross-modal pain (image ~2 frames vs text ~23). It's invariant to orthogonal rotation/isotropic scaling of the vertex basis, so it scores co-activation geometry rather than magnitude, making it harder to reward-hack than full-vector cosine (your documented `reward-hacking-in-tribe-score` concern). Implementation: transpose to `[V,T]`, **column-center**, `score = ‖Yᵀ·X‖²_F / (‖Xᵀ·X‖_F · ‖Yᵀ·Y‖_F)` — already in [0,1], no `(raw+1)/2` remap. Caveat is benign here: CKA trends to 1.0 at high feature:sample ratio, but V=20484 ≫ T is the *safe* orientation (many rows, few columns); keep column-centering and winsorize extreme vertices, and **keep the POOLED_WEIGHT=0.4 anchor** as the non-gameable floor.

The decisive test is **already built**: re-run the exp-2 probe set + Starry-Night image→text + the 8-persona sweep documented in the activation.ts header. Acceptance gate (unchanged): true vibe-match ranks #1, repetition hack scores below it, flat description ranks last. If CKA passes the gate AND widens the cross-modal gradient over resample-only, swap it in. This is a contained change behind an existing acceptance test — you'll know in one probe run whether it's better.

**ONE search-algorithm change to prototype first: #1, per-slot deterministic crowding** (stop `seedFromElite`-to-all; keep N lineages, replace child-vs-its-own-parent).

Why this over MAP-Elites or islands: same root cause, strictly less machinery. MAP-Elites needs grid-binning + cell-selection policy; islands needs split archives + reset scheduling. Deterministic crowding is **parameter-free, zero extra TRIBE calls** (parents cached), a localized diff in run.ts, and it cures the *named* failure mode directly. Run `bun run smoke:tribe` (or `smoke:image:tribe` on Starry Night) before/after and read `evolution-journal.json`'s `operatorFitness.perIteration` curve: the win condition is the best-neural-similarity curve continuing to climb past the iteration where it currently plateaus, AND the per-iteration candidates showing divergent `behaviorKey`s instead of collapsing to one. If crowding alone lifts the plateau, you may not need the heavier QD archive at all.

Do these two in parallel — they touch disjoint files (`activation.ts` vs `run.ts`) and have independent acceptance tests.

---

## (3) Theoretically appealing but BAD FIT for our constraints

**Dynamic Thompson Sampling for operator selection (DTS, Beta-Bernoulli arms).** Strong literature fit on paper, but it's **stochastic**, which breaks the load-bearing "deterministic given the archive, smokes stay stable" property (run.ts:964 comment, no `Math.random`). The proposed fix (seed RNG from archive hash) adds fragile reproducibility machinery for a marginal gain over the cheaper, deterministic windowed-rank credit in change #2 — which captures the same non-stationarity benefit (recency-weighted credit) without the stochasticity. **Skip it**; #2 dominates it on impact/cost.

**Full MAP-Elites grid as the population container.** Appealing and QDAIF-validated, but for **N=4 / M≈6** a binned grid is mostly empty — you can't fill or meaningfully select across cells with 4 candidates × ~6 iters. You'd pay the binning/bounds/cell-selection complexity for a grid that never populates. Deterministic crowding + clearing-by-operator-family (#1) gives ~90% of the anti-monoculture benefit with N lineages and **no grid bounds to hand-tune**. Revisit MAP-Elites only if you can afford a much larger N.

**CMA-ME's covariance machinery, soft-DTW, and Procrustes/SVD as the primary metric.** CMA-ME's Gaussian covariance update does not transfer to discrete text (adopt only the cheap emitter-mix *idea*, already covered by clearing-by-niche). Soft-DTW and Procrustes are more principled than CKA but each adds real cost (a DP pass / an SVD dependency) for a gain CKA already captures on T1≠T2 — premature given that CKA is the cheapest decisive option and the metric isn't yet your proven bottleneck. **Defer** all three until CKA has been gated.

**Self-referential operator evolution (Promptbreeder hypermutation) and per-candidate over-generate-then-surrogate-preselect.** Both are real wins at larger scale but spend **extra Codex calls** (rate-limited/expensive for us) and add a surrogate to train/calibrate. The surrogate's archive is also thin early in a 6-iteration run, when you most need it. Park both behind the cheap structural fixes (#1–#4) — only reach for over-generation if, after crowding, TRIBE-call budget (not diversity) becomes the binding constraint. One free sub-win worth grabbing regardless: a **content-hash dedup cache** on candidate text → cached score (TRIBE is deterministic, so exact repeats cost zero) — trivial, immediate, no downside.

**Relevant file paths:** `/Users/bryanhu/Developer/Hackathons/WeaveHacks2026/project-volta/services/orchestrator/src/run.ts` (seeding/elitism: 256–305; `evaluateCandidate` diversity placeholder: 667–738; `planOperators` UCB: 965–1036; `isEliteStalled`: 1051–1066; `seedFromElite`: 1223), `/Users/bryanhu/Developer/Hackathons/WeaveHacks2026/project-volta/services/orchestrator/src/archive.ts` (`operatorStats` cumulative mean: 332–368; `behaviorDescriptor`/`bestPerBehavior`/`byScore`: 172–189, 309–316, 389), `/Users/bryanhu/Developer/Hackathons/WeaveHacks2026/project-volta/packages/core/src/scoring/activation.ts` (metric blend + weights: 22–96; reusable `neuralTrajectorySimilarity`: 73; acceptance-test notes in header: 1–21).
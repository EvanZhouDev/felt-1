# Principled TRIBE similarity methodology (research synthesis)

Date: 2026-06-07. Source: 7-agent methodology workflow.

I have full grounding now. Here is the methodology.

---

# Recommended Methodology for Volta's TRIBE Similarity Function

## TL;DR — what's actually wrong and the one-line fix

Six independent angles converged on the *same* root cause and the *same* cure, which is the strongest signal in this whole report: **the 0.85–0.97 floor is a shared additive SPATIAL pattern across the 20484 vertices (TRIBE's mean predicted response), and it can only be removed by subtracting a per-vertex mean estimated from an INDEPENDENT reference corpus.** Your current code does *not* do this. It calls `centerInPlace`, which subtracts each vector's *own scalar mean over vertices* (Pearson centering) — that removes a per-stimulus DC offset but leaves the shared spatial common-mode fully intact. This is exactly why the exp-2 memo shows centered/z-scored pooled cosine *still ranks the calm-sky counterfactual #1*.

**The single cheapest decisive change (do this now): build a per-vertex reference mean `mu[20484]` (and `sigma[20484]`) from ~200 cached TRIBE queries, subtract `mu` / divide by `sigma` per frame as the *first* operation in `neuralTrajectorySimilarity`, before any existing term runs.** Everything else in this report is a refinement on top of that one move.

---

## (1) Reference data to collect — to estimate common-mode without circularity

**What:** A frozen, cached reference corpus `R`. TRIBE is deterministic (your memory confirms bit-identical repeats), so you query each reference stimulus exactly once, ever.

**How much / how composed:**
- **Size:** R ≈ 200–300 stimuli is the consensus floor. 200 is enough for a stable per-vertex `mu`/`sigma` (the high-impact stats). It is *not* enough for a 20484×20484 covariance — don't attempt full whitening at this scale.
- **Diversity over count:** span all three modalities (images, 30s audio clips, paragraphs) and many vibes (calm/turbulent, warm/cold, sparse/dense). Diversity matters more than N because the per-vertex mean must represent "a generic TRIBE response," not "a generic landscape."
- **Modality- and timestep-stratified stats.** This is non-negotiable and is the subtle point three angles raised: an image is 2 frames, audio 30, text ~23, and the common-mode is conditioned on modality. **Compute a separate `mu`/`sigma` per modality** (`mu_image`, `mu_audio`, `mu_text`), each as a per-vertex mean over that modality's reference frames. When you score a cross-modal pair, de-baseline the image trace with `mu_image` and the text trace with `mu_text`. A single global `mu` will mis-center cross-modal comparisons and silently re-inject a modality confound.

**The anti-circularity invariant (the whole point):** `mu`, `sigma`, and any PCs are computed **once from R, cached as a versioned read-only artifact, and never recomputed from the {target, candidate} pair under test.** This is the line between the principled NSD-style fix and the Garrido-2013 cocktail-blank failure (subtracting an in-set mean over n=5 mechanically manufactures anti-correlations and reorders similarities). The pair you are scoring must never appear in R.

**Honest gap:** you don't have this corpus yet. But you have a cheap down-payment already cached: the 14 exp-2 prediction files in `experiments/exp-2/cache/preds/`. A `mu` from 14 text traces is too small and too text-skewed to ship, but it is enough to *prototype and validate the transform offline today* before spending query budget on the full 200.

---

## (2) Exact preprocessing of a `[T,20484]` trace — order and what's fit where

Fit on R (cached, frozen): `mu_modality[20484]`, `sigma_modality[20484]`, top-D PCs `U_D` of the centered reference matrix. Fit on the test pair: **nothing** except the existing per-frame cosine.

Per trace, per timestep `t` (do these in this order):

1. **Per-vertex de-baseline (THE fix):** `x'[t] = x[t] − mu_modality`. Removes the shared spatial common-mode. *This is the step your code is missing.*
2. **Per-vertex standardization:** `z[t] = x'[t] / (sigma_modality + ε)`, ε ≈ 1e-6. Equalizes always-on high-variance vertices (language/DMN) so a few channels stop dominating cosine. NSD/himalaya standard.
3. **All-But-The-Top (ABTT), optional, D≈3–8:** `z''[t] = z[t] − Σ_i (u_i·z[t]) u_i`. Strips the *structured* nuisance directions that survive mean removal (your documented ~0.22 "generic-fluency" reward-hack). Choose D from the reference eigenspectrum elbow (a handful of top dirs sitting above the power-law line), **not** by tuning on the exp-2 probes. Start D=0 (skip), add it only if validation says the fluency hack survives steps 1–2.
4. **Then run your existing temporal machinery on `z''` frames** — pooled meanFrame cosine, resampled temporal+dynamics, best-match. Keep `centerInPlace` inside those terms; it's now harmless and slightly helpful (it's a second-order Pearson step on already-de-baselined data).

**Do NOT do at R≈200:** full 20484×20484 Mahalanobis whitening or crossnobis. The covariance is wildly under-determined (P=20484 ≫ R); even with Ledoit-Wolf shrinkage it's approximate and expensive, and the power-law-spectrum finding warns that over-whitening the long signal-bearing tail *deletes vibe signal*. Mark it "needs data we don't have" (R in the low thousands + per-Yeo-network covariance) and revisit only if steps 1–3 under-clean.

**Per-Yeo-network:** apply steps 1–2 with each network's own `mu`/`sigma` sub-vector. But heed your own prior result: pooled Yeo-7 reweighting *cannot* rank the match #1 because the signal is temporal. So use networks only (a) to de-baseline per-network before the temporal terms, and (b) as an interpretability read-out (which networks agree), **never** as a replacement for the temporal metric. Do not hand-up-weight Limbic for "emotion" — it's the lowest-SNR, thinnest-coverage network; if anything weight DMN + ventral-attention, and only if a held-out fit says so.

---

## (3) The similarity metric itself — and why

**Keep your temporal blend; change only its inputs.** The metric stays:

```
0.4·pooled-cosine + 0.3·(temporal+dynamics) + 0.3·best-match,  on z''-frames,  mapped (raw+1)/2
```

Rationale, ranked:
- **Raw cosine: rejected.** It's the disease (0.97 floor).
- **Pearson / per-vector centered cosine (what you have): necessary but insufficient.** Confirmed empirically by your own memo — it leaves the shared spatial pattern and ranks calm-sky #1. The fix is to feed it de-baselined inputs, not to change the metric shape.
- **Your temporal+dynamics+best-match blend: keep it.** It is the *only* thing the exp-2 work found that ranks the true match #1, because the discriminative signal (turbulence vs stillness) lives in the trajectory that pooling destroys. The six-angle report is about *cleaning the inputs*, and it composes cleanly with your temporal terms ("apply mu/sigma per-frame, then your trajectory metric runs on the de-baselined frames" — stated verbatim by two angles).
- **Second-order RSA against an anchor bank: the strong upgrade, not the day-1 move.** RSA discards the additive baseline *by construction* (second-order isomorphism) and is cross-modal-native. But it needs a curated 30–100-stimulus anchor bank per medium that you don't have, the margins on short anchor-row Spearman vectors are noisy, and it's strictly more machinery. Adopt it *after* de-baselining, as the path to a baseline-free, deconfoundable metric (then layer partial-correlation RSA to kill the fluency/length hacks). **Whitened-unbiased RDM (WUC) and crossnobis are last** — power refinements once rankings are already correct.

---

## (4) Validation — measuring real similarity, not artifact (using your paintings/songs)

You already have the harness: `experiments/exp-2/` with `probes/starrynight.json` (14 labeled probes: high/mid/low buckets + repetition + loop hack families) and 14 cached predictions. The acceptance gate is concrete:

1. **Ranking gate (primary):** the true vibe-MATCH (`vibe-rich`/`vibe-sensory`, `expect:high`) must rank #1, above the calm/wrong/neutral `low` probes AND above the `repetition`/`loop` hack families. high > mid > low ordering preserved. This is the exact test your memo already runs — the new transform must *keep* it passing, with the MATCH−HACK margin (currently ≈ +0.037–0.076) **wider**, not just intact.
2. **Common-mode collapse gate:** two *random* reference stimuli (held out of R) must have mean cosine ≈ 0 after the transform, vs ≈ 0.9 raw. If random pairs still sit at 0.9, de-baselining failed.
3. **Double-dip / permutation gate (the honesty check):** split R into estimate/validate halves; fit `mu`/`sigma`/PCs on the estimate half only. Then **shuffle stimulus labels in R, rebuild the stats, and confirm random held-out pairs do NOT separate.** If masking/centering suddenly makes *everything* separate cleanly on n=5, that's the double-dip tell — fail.
4. **Cross-modal gate (your real product):** the Starry-Night *image* → matching *text* score must rise (the memo's image→elite 0.571→0.609 headroom should widen further), while image→calm-text stays low.

Run exp-2 **once** at the end with frozen D/ε; do not tune those on the reported probes (tune on the held-out R half). The 14 cached preds let you do gates 1, 3, 4 *today* with zero new queries.

---

## (5) The single cheapest decisive change RIGHT NOW

**Add reference per-vertex de-baselining (steps 1–2) as the first transform in `neuralTrajectorySimilarity`, before the existing pooled/temporal/best-match terms.** Concretely in `packages/core/src/scoring/activation.ts`:

- Load a cached `mu[20484]`, `sigma[20484]` artifact (per modality) — bootstrap it *now* from the 14 cached exp-2 text preds as `mu_text` to validate the wiring, then regenerate from a proper 200-stimulus R before shipping.
- Map each frame `x → (x − mu)/(sigma+ε)` once, up front, then feed those frames into the *unchanged* pooled/temporal/dynamics/best-match code.
- Keep `centerInPlace` where it is (now a harmless second-order step).

This is one transform, ~20 lines, pure linear algebra, no gradients, TRIBE stays frozen. It attacks the documented root cause that all six angles agree on, and it's the one thing your current `centerInPlace` provably fails to do (Pearson centering removes the per-vector scalar mean, not the shared spatial pattern). Validate with the exp-2 harness before/after: expect random-pair cosine to collapse toward 0 and the MATCH−HACK margin to widen.

---

## Ranked roadmap (impact / cost)

| Rank | Change | Impact | Cost | Status |
|---|---|---|---|---|
| 1 | Per-vertex reference de-baseline `(x−mu)/sigma`, per modality, fed into existing temporal blend | **Decisive** — removes the actual common-mode | Cheap (200 cached queries + ~20 LOC) | Do now; bootstrap `mu` from 14 cached preds, then build R=200 |
| 2 | Per-modality/timestep-stratified `mu`/`sigma` (not one global) | High — kills cross-modal modality confound | Cheap (same queries, sliced) | With #1 |
| 3 | ABTT: project out top D≈3–8 reference PCs | Medium — kills residual generic-fluency hack | Cheap | Only if validation shows fluency hack survives #1 |
| 4 | Per-Yeo-network de-baseline as interpretability read-out | Medium (diagnosis, not score) | Cheap | After #1 |
| 5 | Second-order RSA vs independent anchor bank (+ partial-corr deconfounding) | High — baseline-free by construction, cross-modal-native | Medium (needs 30–100-stim anchor bank we don't have) | Phase 2 |
| 6 | Mahalanobis/ZCA whitening (per-network, Ledoit-Wolf), crossnobis, WUC | Low marginal here, real over-whitening risk | Expensive (needs R≫thousands; under-determined at 200) | Defer / likely skip |
| — | SRM / hyperalignment | N/A | — | **Reject** (single frozen model = no multi-subject shared subspace) |

**Honest gaps:** (a) the R=200 corpus doesn't exist yet — #1 is blocked on ~200 cached queries (cheap, one-time, deterministic); (b) anything covariance-based (#6) needs an order of magnitude more data than you'll have and risks deleting tail signal — don't ship it at R=200; (c) per-network affective weighting needs a labeled pair set bigger than n=5 to fit without overfitting — keep weights uniform until you have ≥20 labeled pairs.

**Key files:** metric `/Users/bryanhu/Developer/Hackathons/WeaveHacks2026/project-volta/packages/core/src/scoring/activation.ts` (`neuralTrajectorySimilarity`, line 73; the `centerInPlace`-only gap is lines 80–96); validation harness `/Users/bryanhu/Developer/Hackathons/WeaveHacks2026/project-volta/experiments/exp-2/` (`run.ts`, `scorers.ts`, `probes/starrynight.json`, 14 cached preds in `cache/preds/`); the temporal-metric rationale you must not regress is in memory `temporal-similarity-metric.md`.
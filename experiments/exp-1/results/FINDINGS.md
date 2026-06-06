# exp-1 findings (text↔image, v1)

## Verdict: 🔴 RED (improved, but brain metric still loses to CLIP)

| metric | AUC | perm p |
|---|---|---|
| raw cosine (full vector) | 0.71 | 0.054 |
| anatomical mask (drop Visual+Somatomotor) | 0.76 | 0.023 |
| data-driven mask (leave-one-pair-out CV) | 0.67 | 0.110 |
| **best swept mask — Limbic only (1220v)** | **0.80** | 0.008 |
| **CLIP ViT-B/32 (laion2b) baseline** | **0.90** | 0.0006 |

Gate (§6): the anatomical/brain metric must **at least match CLIP** to justify its
complexity. Best brain metric = 0.80 < CLIP 0.90 → **RED** on text↔image.

## What the cheap sweep showed (normalization × mask, on cached vectors, $0)

- **Z-scoring is essential.** L2-only normalization collapses every condition to
  ~0.5 (chance). Per-vertex z-score across the item set carries the signal.
  (`zscore` == `zscore_then_l2` for cosine — the final L2 is a no-op.)
- **Tighter masks help, monotonically toward the affective core:**
  full 0.71 → drop-sensory 0.76 → DMN+Limbic 0.76 → **Limbic-only 0.80**.
  This is the spec's thesis confirmed in direction: vibe concentrates in affective
  cortex; stripping sensory + association noise sharpens it. The spec's worry about
  over-pruning did NOT bite here — tighter won.

## Exhaustive subset check (06_all_subsets.py) — the 0.80 is optimistic

Swept ALL 127 non-empty Yeo-7 subsets, not just 6:
- **In-sample winner: Limbic-only, 0.80** — genuinely the best of all 127 (next best
  0.77; worst is Somatomotor-only 0.59). So "Limbic is best" is real, not an artifact
  of a small hand-picked set. Affective-network story holds.
- **Honest (leave-one-pair-out subset SELECTION): AUC 0.65, p=0.13 (n.s.).** When the
  mask is chosen without seeing the test pair, performance drops below even raw cosine
  (0.71) and loses significance. Limbic was chosen in 16/20 folds (consistent), but
  even the genuinely-best mask only generalizes to ~0.65.

=> The 0.80 must NOT be quoted as TRIBE's score; it's selection-optimism on 20 pairs.
The honest masked-TRIBE number is ~0.65. We have now tried EVERY brain-region subset:
none fixes it. Masking is exhausted as a strategy. (Consistent with the modality probe:
the fingerprint is entangled in every network.)

## Caveats (small-N honesty)

- 20 pairs — enough to spot a strong effect, not a fragile one. The headline masked
  number is the cross-validated 0.65, not the in-sample 0.80.
- Ground-truth labels visually confirmed clean by a human, so the ceiling is NOT
  label noise — it's the metric/geometry.
- Time-aggregation `max` (vs `mean`) was NOT swept (needs re-fetching per-timestep
  preds; only affects the 7-timestep text items, images are 1 timestep).

## Modality probe — the key diagnostic (05_modality_probe.py)

Tested directly whether the "TRIBE over-screams modality" worry is the right model:

- **Modality separability AUC = 1.000** — text vs image vectors are perfectly
  distinguishable. Modality IS loudly encoded.
- **Modality = 55% of total variance** — over half the variation is just text-vs-image.
- **BUT modality is NOT in sensory cortex.** The text-vs-image effect is spread almost
  evenly across all 7 Yeo networks (Visual 0.0119 barely tops; Somatomotor 0.0087 is
  the LOWEST; Frontoparietal/Attention/Limbic/DMN are all comparable). The spec's
  assumption — that modality lives in Visual+Somatomotor and can be masked out — is
  FALSE.

Why this matters: masking never could have been the fix. It strips a sliver of an
evenly-distributed signal (hence 0.71→0.80 nudge, not a rescue). You can't isolate a
modality-free vertex subset because every region carries the fingerprint. A *linear
mask* can't separate entangled modality/vibe directions — a *learned projection* can.
This is the strongest argument yet for an alignment head and against masking, and it
explains why the CV data-driven mask only hit 0.67.

## Implication

Direction of the bet is right (masking helps, affective core best) but TRIBE's raw
geometry still underperforms a weak off-the-shelf CLIP on the *easy* slice. Next
honest steps, cheapest first: (a) more/cleaner pairs to test if 0.80 is real or
small-N luck; (b) `max` time-agg on text (cheap re-encode of 10 texts); (c) the
audio→text slice where CLIP can't compete (TRIBE's real advantage, untested); only
then (d) a learned alignment head.

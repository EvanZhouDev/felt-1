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

## Caveats (small-N honesty)

- 20 pairs. 0.80 comes from picking the best of 6 hand-chosen masks, so it's a
  promising **upper bound**, not a proven number — selection over masks on 20 pairs
  can flatter. The cross-validated data-driven mask only hit 0.67, so a fairly
  *learned* mask does not yet reach 0.80.
- Ground-truth labels visually confirmed clean by a human, so the ceiling is NOT
  label noise — it's the metric/geometry.
- Time-aggregation `max` (vs `mean`) was NOT swept (needs re-fetching per-timestep
  preds; only affects the 7-timestep text items, images are 1 timestep).

## Implication

Direction of the bet is right (masking helps, affective core best) but TRIBE's raw
geometry still underperforms a weak off-the-shelf CLIP on the *easy* slice. Next
honest steps, cheapest first: (a) more/cleaner pairs to test if 0.80 is real or
small-N luck; (b) `max` time-agg on text (cheap re-encode of 10 texts); (c) the
audio→text slice where CLIP can't compete (TRIBE's real advantage, untested); only
then (d) a learned alignment head.

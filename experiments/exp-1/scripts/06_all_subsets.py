"""Exhaustive sweep over ALL 127 non-empty Yeo-7 network subsets.

Two numbers per question:
  - in-sample AUC: best subset scored on all 20 pairs (OPTIMISTIC — with 127
    tries something wins by luck; this is the ceiling, not a claim).
  - honest AUC: leave-one-pair-out — for each held-out pair, pick the best subset
    on the OTHER 19 pairs, score the held-out pair with it. No subset is chosen
    on the pair it's scored on, so this is the trustworthy generalization number.
"""
from __future__ import annotations

import csv
import sys
from itertools import combinations
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from vibe import config, masks, metrics  # noqa: E402

NETS = config.YEO7_NETWORKS


def load():
    enc = np.load(config.CACHE / "encoded.npz", allow_pickle=True)
    R = metrics.normalize_matrix(enc["R"])
    keys = [str(k) for k in enc["keys"]]
    k2i = {k: i for i, k in enumerate(keys)}
    rows = list(csv.DictReader(open(config.PAIRS_CSV)))
    pairs, matched = [], []
    for r in rows:
        pairs.append((k2i[f"{r['modality_a']}::{r['item_a']}"],
                      k2i[f"{r['modality_b']}::{r['item_b']}"]))
        matched.append(r["label"] == "matched")
    return R, pairs, np.array(matched)


def all_subsets():
    subs = []
    for k in range(1, len(NETS) + 1):
        for combo in combinations(NETS, k):
            subs.append(combo)
    return subs  # 127


def main():
    R, pairs, matched = load()
    subs = all_subsets()
    # precompute mask + distances per subset
    masks_by_sub = {s: masks.network_mask(s) for s in subs}
    dist_by_sub = {s: metrics.condition_distances(R, pairs, masks_by_sub[s])
                   for s in subs}

    # --- in-sample: best subset on all pairs ---
    scored = [(s, metrics.separation_auc(dist_by_sub[s], matched)) for s in subs]
    scored.sort(key=lambda x: -x[1])
    print("=== in-sample (OPTIMISTIC — best of 127 on the same pairs) ===")
    for s, a in scored[:8]:
        kept = int(masks_by_sub[s].sum())
        print(f"  {a:.3f}  ({kept:5d}v)  {'+'.join(s)}")
    best_sub, best_auc = scored[0]
    print(f"  ... worst: {scored[-1][1]:.3f}  ({'+'.join(scored[-1][0])})")

    # --- honest: leave-one-pair-out subset selection ---
    n = len(pairs)
    held_d = np.zeros(n)
    chosen = []
    for h in range(n):
        train = [k for k in range(n) if k != h]
        tr_matched = matched[train]
        # pick subset with best AUC on the training pairs
        bs, ba = None, -1
        for s in subs:
            d = dist_by_sub[s][train]
            a = metrics.separation_auc(d, tr_matched)
            if a > ba:
                ba, bs = a, s
        chosen.append(bs)
        held_d[h] = dist_by_sub[bs][h]
    honest_auc, honest_p, _ = metrics.permutation_pvalue(held_d, matched, n=5000)
    print("\n=== honest (leave-one-pair-out subset selection) ===")
    print(f"  CV AUC = {honest_auc:.3f}   perm_p = {honest_p:.4f}")
    # which subsets got chosen across folds?
    from collections import Counter
    cnt = Counter('+'.join(s) for s in chosen)
    print("  subsets chosen across folds:")
    for name, c in cnt.most_common(5):
        print(f"    {c:2d}x  {name}")

    print(f"\nCLIP baseline = 0.90. in-sample ceiling = {best_auc:.3f}; "
          f"honest = {honest_auc:.3f}")


if __name__ == "__main__":
    main()

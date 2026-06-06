"""Cheap sweep over metric knobs on the CACHED vectors (no re-encoding, $0).

Sweeps the free knobs — normalization x mask scope — and reports AUC + permutation
p for each. (Time-aggregation is NOT free: encoded.npz already baked in `mean`;
trying `max` needs re-fetching per-timestep preds, so it's not in this script.)

Goal: find out whether the RED 0.76 was just an untuned config before any ML build.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from vibe import config, masks, metrics  # noqa: E402

# normalization variants
NORMS = ["zscore_then_l2", "l2", "zscore"]

# mask scopes (Yeo-7 network keep-sets), from generous -> tight
MASK_SCOPES = {
    "full (no mask)": None,
    "anat-5 (drop Vis+SomMot)": ["Dorsal Attention", "Ventral Attention",
                                  "Limbic", "Frontoparietal", "Default Mode"],
    "assoc-3 (FP+DMN+Limbic)": ["Frontoparietal", "Default Mode", "Limbic"],
    "affective (DMN+Limbic)": ["Default Mode", "Limbic"],
    "limbic only": ["Limbic"],
    "DMN only": ["Default Mode"],
}


def normalize_with(R_raw, mode):
    saved = config.NORMALIZATION
    config.NORMALIZATION = mode
    try:
        return metrics.normalize_matrix(R_raw)
    finally:
        config.NORMALIZATION = saved


def main():
    enc = np.load(config.CACHE / "encoded.npz", allow_pickle=True)
    R_raw, keys = enc["R"], list(enc["keys"])
    k2i = {k: i for i, k in enumerate(keys)}
    rows = list(csv.DictReader(open(config.PAIRS_CSV)))
    pairs, matched = [], []
    for r in rows:
        ka = f"{r['modality_a']}::{r['item_a']}"
        kb = f"{r['modality_b']}::{r['item_b']}"
        pairs.append((k2i[ka], k2i[kb]))
        matched.append(r["label"] == "matched")
    matched = np.array(matched)

    # precompute masks
    scope_masks = {name: (masks.network_mask(nets) if nets else None)
                   for name, nets in MASK_SCOPES.items()}

    print(f"{'norm':16s} {'mask':28s} {'kept':>6s} {'AUC':>6s} {'perm_p':>7s}")
    print("-" * 70)
    best = (None, -1)
    results = []
    for norm in NORMS:
        R = normalize_with(R_raw, norm)
        for sname, m in scope_masks.items():
            kept = int(m.sum()) if m is not None else config.N_VERTICES
            d = metrics.condition_distances(R, pairs, m)
            auc, p, _ = metrics.permutation_pvalue(d, matched, n=2000)
            print(f"{norm:16s} {sname:28s} {kept:6d} {auc:6.3f} {p:7.4f}")
            results.append((norm, sname, kept, round(auc, 3), round(p, 4)))
            if auc > best[1]:
                best = ((norm, sname, kept, auc, p), auc)
    print("-" * 70)
    b = best[0]
    print(f"BEST: norm={b[0]}  mask={b[1]} ({b[2]}v)  AUC={b[3]:.3f}  p={b[4]:.4f}")
    print("(CLIP baseline from main run = 0.90; brain metric must beat that to matter.)")

    # write csv
    out = config.RESULTS / "sweep.csv"
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["norm", "mask", "kept_vertices", "auc", "perm_p"])
        w.writerows(results)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()

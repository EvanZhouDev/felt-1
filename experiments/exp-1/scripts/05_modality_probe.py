"""Is TRIBE 'over-screaming modality'? Measure it directly on cached vectors ($0).

Tests the hypothesis that the modality fingerprint (text vs image) dominates and
drowns out vibe. If it's loud, masking sensory cortex should be the fix; if it's
quiet, the low vibe-AUC is about weak vibe geometry everywhere, not modality.

Three direct measurements:
 1. Modality separability: how cleanly do the vectors split text vs image?
 2. Variance partition: fraction of total variance explained by modality
    (between-class) vs. within-modality (where vibe lives).
 3. Where modality lives: is the text-vs-image signal concentrated in
    Visual/Somatomotor (the worry) or spread across all Yeo-7 networks?
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from vibe import config, masks, metrics  # noqa: E402


def main():
    enc = np.load(config.CACHE / "encoded.npz", allow_pickle=True)
    R_raw, keys = enc["R"], [str(k) for k in enc["keys"]]
    is_text = np.array([k.startswith("text::") for k in keys])
    R = metrics.normalize_matrix(R_raw)  # zscore_then_l2, same as the real metric

    print(f"items: {len(keys)}  ({is_text.sum()} text, {(~is_text).sum()} image)\n")

    # --- 1. modality separability (centroid-distance ranking AUC) ---
    # For each item, is it closer to the text centroid or image centroid?
    # AUC of 'text items score higher on (text-affinity)'.
    from sklearn.metrics import roc_auc_score
    tc = R[is_text].mean(0); ic = R[~is_text].mean(0)
    affinity = R @ (tc - ic)  # high => looks more like text
    mod_auc = roc_auc_score(is_text.astype(int), affinity)
    print(f"1. modality separability AUC (text vs image): {mod_auc:.3f}")
    print("   (1.0 = trivially separable / 'screaming'; ~0.5 = invisible)\n")

    # --- 2. variance partition: between-modality vs within-modality ---
    grand = R.mean(0)
    between = (is_text.mean() * np.sum((R[is_text].mean(0) - grand) ** 2)
               + (~is_text).mean() * np.sum((R[~is_text].mean(0) - grand) ** 2))
    total = np.mean(np.sum((R - grand) ** 2, axis=1))
    # normalize between to per-item scale
    between_freq = (np.sum((R[is_text].mean(0) - grand) ** 2) * is_text.sum()
                    + np.sum((R[~is_text].mean(0) - grand) ** 2) * (~is_text).sum()
                    ) / len(keys)
    frac = between_freq / total
    print(f"2. variance from modality (between/total): {frac:.1%}")
    print("   (high => modality dominates; low => most variance is within-modality"
          " where vibe lives)\n")

    # --- 3. where does modality live? per-network text-vs-image effect size ---
    labels = masks.yeo7_vertex_labels()
    print("3. modality signal per Yeo-7 network (|mean_text - mean_image|, mean abs):")
    diff = np.abs(R[is_text].mean(0) - R[~is_text].mean(0))
    overall = diff.mean()
    rows = []
    for nid, name in enumerate(config.YEO7_NETWORKS, start=1):
        sel = labels == nid
        if sel.sum() == 0:
            continue
        rows.append((name, int(sel.sum()), float(diff[sel].mean())))
    for name, n, d in sorted(rows, key=lambda x: -x[2]):
        bar = "#" * int(40 * d / max(r[2] for r in rows))
        flag = "  <- 'sensory' (the worry)" if name in config.ANATOMICAL_DROP else ""
        print(f"   {name:18s} n={n:5d}  {d:.4f} {bar}{flag}")
    print(f"   overall mean |diff| = {overall:.4f}")
    print("   (if Visual/Somatomotor are NOT the biggest, modality isn't where the"
          " worry assumed — masking them can't be the main fix.)")


if __name__ == "__main__":
    main()

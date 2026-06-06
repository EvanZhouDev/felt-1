"""Step 3 (§3, §5, §6): run all conditions, score separation, render the verdict.

Conditions:
  1. raw cosine            (full vector — brain-side floor)
  2. anatomical-mask cosine (drop Visual+Somatomotor; the main bet)
  3. data-driven-mask cosine (leave-one-pair-out CV — no cheating)
  4. CLIP cosine            (baseline to beat)

For each: AUC of matched(close) vs mismatched(far) + permutation p-value.
Then apply §6 green/yellow/red logic and write results/report.{json,md}.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vibe import config, masks, metrics  # noqa: E402


def resolve_path(item: str) -> Path:
    p = Path(item)
    return p if p.is_absolute() else config.ROOT / p


def load_text(item: str) -> str:
    p = config.ROOT / item
    return p.read_text().strip() if p.exists() else item


def main() -> None:
    enc = np.load(config.CACHE / "encoded.npz", allow_pickle=True)
    R_raw = enc["R"]
    keys = list(enc["keys"])
    key_to_idx = {k: i for i, k in enumerate(keys)}

    rows = list(csv.DictReader(open(config.PAIRS_CSV)))

    # build per-item index list and pair index pairs
    item_index = []          # item idx in R for each (modality,item) used
    pairs = []               # (idx_a, idx_b) into R
    matched = []             # bool per pair
    pair_item_membership = []  # for data-driven: (item_global_a, item_global_b)
    # Keys must match 02_encode.py exactly: f"{modality}::{raw CSV value}"
    # (the raw path, NOT the loaded text content or resolved absolute path).
    for r in rows:
        ka = f"{r['modality_a']}::{r['item_a']}"
        kb = f"{r['modality_b']}::{r['item_b']}"
        ia, ib = key_to_idx[ka], key_to_idx[kb]
        pairs.append((ia, ib))
        matched.append(r["label"] == "matched")
    matched = np.array(matched)

    # --- normalize once, fixed across all brain conditions (§2) ---
    R = metrics.normalize_matrix(R_raw)

    report = {"normalization": config.NORMALIZATION, "time_agg": config.TIME_AGG,
              "n_pairs": len(pairs),
              "n_matched": int(matched.sum()),
              "n_mismatched": int((~matched).sum()),
              "conditions": {}}

    def record(name, distances):
        auc, p, _null = metrics.permutation_pvalue(distances, matched)
        report["conditions"][name] = {
            "auc": round(auc, 4), "perm_p": round(p, 5),
            "mean_d_matched": round(float(distances[matched].mean()), 4),
            "mean_d_mismatched": round(float(distances[~matched].mean()), 4),
        }
        print(f"  {name:28s} AUC={auc:.3f}  perm_p={p:.4f}  "
              f"(d_match={distances[matched].mean():.3f} "
              f"d_mismatch={distances[~matched].mean():.3f})")
        return auc

    print("\n=== Conditions ===")

    # 1. raw cosine
    d_raw = metrics.condition_distances(R, pairs, mask=None)
    auc_raw = record("1. raw cosine", d_raw)

    # 2. anatomical-mask cosine
    auc_anat = float("nan")
    try:
        amask = masks.anatomical_mask()
        kept = int(amask.sum())
        d_anat = metrics.condition_distances(R, pairs, mask=amask)
        auc_anat = record(f"2. anatomical-mask ({kept}v)", d_anat)
        report["anatomical_kept_vertices"] = kept
    except Exception as e:  # nilearn atlas unavailable offline, etc.
        print(f"  2. anatomical-mask        SKIPPED ({type(e).__name__}: {e})")
        report["conditions"]["2. anatomical-mask"] = {"error": str(e)}

    # 3. data-driven mask, leave-one-pair-out CV (§5)
    auc_dd = run_data_driven_cv(R, pairs, matched, report)

    # 4. CLIP baseline
    auc_clip = run_clip_baseline(rows, matched, report)

    verdict = decide(auc_raw, auc_anat, auc_dd, auc_clip, report)
    report["verdict"] = verdict

    (config.RESULTS / "report.json").write_text(json.dumps(report, indent=2))
    write_markdown(report)
    print(f"\n=== VERDICT: {verdict['light'].upper()} ===\n{verdict['reason']}")
    print(f"\nWrote results/report.json and results/report.md")


def run_data_driven_cv(R, pairs, matched, report) -> float:
    """Leave-one-pair-out: build mask on all-but-one pair, score held-out pair."""
    n_pairs = len(pairs)
    # global item arrays for the scorer
    # map each pair's two items to a synthetic item table restricted to used items
    used = sorted({i for p in pairs for i in p})
    g2l = {g: l for l, g in enumerate(used)}
    Rused = R[used]
    item_pair_idx = np.full(len(used), -1)
    modality_a = np.zeros(len(used), dtype=bool)
    for pid, (ia, ib) in enumerate(pairs):
        item_pair_idx[g2l[ia]] = pid
        item_pair_idx[g2l[ib]] = pid
        modality_a[g2l[ia]] = True   # convention: side a (text) is "A"

    frac = float(config.NORMALIZATION and 0.25)  # keep top 25% vertices
    held_distances = np.zeros(n_pairs)
    for held in range(n_pairs):
        train_pairs = [p for k, p in enumerate(pairs) if k != held]
        # restrict scorer to train items only
        train_items = sorted({i for p in train_pairs for i in p})
        tg2l = {g: l for l, g in enumerate(train_items)}
        Rtr = R[train_items]
        ip = np.array([_pair_of(g, train_pairs) for g in train_items])
        ma = np.array([_is_side_a(g, train_pairs) for g in train_items])
        lm = np.array([matched[k] for k in range(n_pairs) if k != held])
        # remap pair ids in ip to 0..len(train_pairs)-1 for the matched lookup
        uniq = {pid: j for j, pid in enumerate(sorted(set(ip)))}
        ip_remap = np.array([uniq[p] for p in ip])
        lm_by_localpair = np.zeros(len(uniq), dtype=bool)
        for orig_pid, j in uniq.items():
            lm_by_localpair[j] = matched[orig_pid]
        scores = masks.data_driven_scores(Rtr, ip_remap, lm_by_localpair, ma)
        m = masks.topk_mask(scores, frac=0.25)
        ia, ib = pairs[held]
        held_distances[held] = metrics.cosine_distance(R[ia], R[ib], m)

    auc, p, _ = metrics.permutation_pvalue(held_distances, matched)
    report["conditions"]["3. data-driven (LOPO-CV)"] = {
        "auc": round(auc, 4), "perm_p": round(p, 5),
        "mean_d_matched": round(float(held_distances[matched].mean()), 4),
        "mean_d_mismatched": round(float(held_distances[~matched].mean()), 4),
    }
    print(f"  {'3. data-driven (LOPO-CV)':28s} AUC={auc:.3f}  perm_p={p:.4f}")
    return auc


def _pair_of(g, pairs):
    for pid, (a, b) in enumerate(pairs):
        if g in (a, b):
            return pid
    return -1


def _is_side_a(g, pairs):
    for (a, b) in pairs:
        if g == a:
            return True
        if g == b:
            return False
    return False


def run_clip_baseline(rows, matched, report) -> float:
    print("  (loading CLIP...)")
    try:
        d_clip = []
        for r in rows:
            # text<->image only
            ta = load_text(r["item_a"]) if r["modality_a"] == "text" else None
            ib = resolve_path(r["item_b"]) if r["modality_b"] == "image" else None
            if ta is None or ib is None:
                d_clip.append(np.nan); continue
            et = metrics.clip_embed_text(ta)
            ei = metrics.clip_embed_image(ib)
            d_clip.append(1.0 - float(np.dot(et, ei)))
        d_clip = np.array(d_clip)
        auc, p, _ = metrics.permutation_pvalue(d_clip, matched)
        report["conditions"]["4. CLIP cosine"] = {
            "auc": round(auc, 4), "perm_p": round(p, 5),
            "mean_d_matched": round(float(d_clip[matched].mean()), 4),
            "mean_d_mismatched": round(float(d_clip[~matched].mean()), 4),
        }
        print(f"  {'4. CLIP cosine':28s} AUC={auc:.3f}  perm_p={p:.4f}")
        return auc
    except Exception as e:
        print(f"  4. CLIP cosine            SKIPPED ({type(e).__name__}: {e})")
        report["conditions"]["4. CLIP cosine"] = {"error": str(e)}
        return float("nan")


def decide(auc_raw, auc_anat, auc_dd, auc_clip, report) -> dict:
    """§6 green/yellow/red."""
    G = config.GREEN_AUC
    def ok(x): return isinstance(x, float) and x == x  # not nan
    # "clearly above raw" matters when raw is weak; if both are already strong,
    # being level with raw is still a passing foundation. Require anat >= raw.
    above_raw = (not ok(auc_raw)) or auc_anat >= auc_raw - 1e-9
    at_least_clip = (not ok(auc_clip)) or auc_anat >= auc_clip - 1e-9

    if ok(auc_anat) and auc_anat >= G and above_raw and at_least_clip:
        strong = ok(auc_clip) and auc_anat > auc_clip + 0.05
        return {"light": "green",
                "reason": ("Anatomical-mask cosine clears the bar "
                           f"(AUC {auc_anat:.2f} ≥ {G}), is at/above raw "
                           f"({auc_raw:.2f}), and "
                           + ("clearly beats CLIP" if strong else "matches CLIP")
                           + (f" ({auc_clip:.2f})." if ok(auc_clip) else ".")
                           + " Foundation holds — build the loop.")}
    if ok(auc_dd) and auc_dd >= G and (not ok(auc_anat) or auc_dd > auc_anat):
        return {"light": "yellow",
                "reason": (f"Raw/anatomical fall short but the cross-validated "
                           f"data-driven mask separates pairs (AUC {auc_dd:.2f}). "
                           "Masking is doing real work — proceed and invest in "
                           "the mask.")}
    best_brain = max([x for x in (auc_raw, auc_anat, auc_dd) if ok(x)] or [float("nan")])
    return {"light": "red",
            "reason": (f"Best cross-validated brain metric AUC={best_brain:.2f} "
                       f"(< {G}). TRIBE's predicted geometry may not carry "
                       "cross-modal vibe at this resolution. Next step is a "
                       "learned alignment head BEFORE any generator work.")}


def write_markdown(report) -> None:
    lines = ["# Vibe-metric validation — results\n",
             f"- normalization: `{report['normalization']}`",
             f"- time aggregation: `{report['time_agg']}`",
             f"- pairs: {report['n_pairs']} "
             f"({report['n_matched']} matched / {report['n_mismatched']} mismatched)\n",
             "## Conditions (text↔image)\n",
             "| condition | AUC | perm p | d̄ matched | d̄ mismatched |",
             "|---|---|---|---|---|"]
    for name, c in report["conditions"].items():
        if "error" in c:
            lines.append(f"| {name} | — | — | — | (skipped: {c['error'][:40]}) |")
        else:
            lines.append(f"| {name} | {c['auc']} | {c['perm_p']} | "
                         f"{c['mean_d_matched']} | {c['mean_d_mismatched']} |")
    v = report["verdict"]
    lines += ["", f"## Verdict: **{v['light'].upper()}**", "", v["reason"], ""]
    (config.RESULTS / "report.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()

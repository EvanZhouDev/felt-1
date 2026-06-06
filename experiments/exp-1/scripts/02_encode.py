"""Step 2 (§2): encode every unique item through TRIBE, cache raw r vectors.

Reads data/pairs.csv, encodes each distinct (modality, item) once, writes a
matrix cache/encoded.npz with the r vectors plus an index. Re-runnable: the
TRIBE client caches per-item, so re-encoding is free after the first pass.

Includes the §6 PRE-FLIGHT: confirm a still image yields a stable, non-degenerate
vector before trusting any image numbers.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vibe import config, tribe  # noqa: E402


def load_item_text(modality: str, item: str) -> str:
    """For text items the CSV stores a .txt path; return its contents."""
    if modality == "text":
        p = config.ROOT / item
        return p.read_text().strip() if p.exists() else item
    return item  # image/audio: a file path


def resolve_path(item: str) -> Path:
    p = Path(item)
    return p if p.is_absolute() else config.ROOT / p


def preflight_still_image() -> None:
    """§6: a static frame must give a sensible, reproducible vector.

    The vector is NOT stable across clip DURATIONS (measured r(0.5s,2s)~0.55), so
    the pipeline FIXES one duration (config.CLIP_SECONDS) for every image. This
    pre-flight checks the two things that still matter at a fixed duration:
    finite + non-degenerate, and reproducible (same clip encoded twice agrees)."""
    print("\n=== PRE-FLIGHT: still-image at fixed duration "
          f"({config.CLIP_SECONDS}s) ===")
    rows = list(csv.DictReader(open(config.PAIRS_CSV)))
    img = next((resolve_path(r["item_b"]) for r in rows
                if r["modality_b"] == "image"), None)
    if img is None or not img.exists():
        print("  no image available; skipping (generate pairs first)")
        return

    clip = tribe.image_to_clip(img)  # fixed duration/size from config
    ja = tribe._submit_file("predict/video", clip, "a.mp4")
    jb = tribe._submit_file("predict/video", clip, "b.mp4")
    tribe._poll(ja); tribe._poll(jb)
    ra = tribe._aggregate_time(tribe._fetch_preds(ja))
    rb = tribe._aggregate_time(tribe._fetch_preds(jb))

    finite = np.isfinite(ra).all() and np.isfinite(rb).all()
    nonconst = ra.std() > 1e-6 and rb.std() > 1e-6
    corr = float(np.corrcoef(ra, rb)[0, 1])
    print(f"  finite: {finite}   non-degenerate: {nonconst}   "
          f"reproducibility r = {corr:.3f}")
    if not (finite and nonconst):
        print("  !! DEGENERATE still-image output — fix feeding before trusting "
              "image numbers (§6).")
    elif corr < 0.95:
        print("  !! Non-deterministic at fixed duration — investigate before "
              "trusting image numbers.")
    else:
        print("  OK: still image gives a stable, reproducible vector.")


def main() -> None:
    if not config.PAIRS_CSV.exists():
        sys.exit("data/pairs.csv missing — run 01_generate_pairs.py first")

    rows = list(csv.DictReader(open(config.PAIRS_CSV)))

    # collect distinct items across both sides of all pairs
    items: dict[str, tuple[str, str]] = {}  # key -> (modality, payload)
    for r in rows:
        for side in ("a", "b"):
            mod = r[f"modality_{side}"]
            raw = r[f"item_{side}"]
            key = f"{mod}::{raw}"
            if key not in items:
                if mod == "text":
                    items[key] = (mod, load_item_text(mod, raw))
                else:
                    items[key] = (mod, str(resolve_path(raw)))

    print(f"Encoding {len(items)} distinct items...")
    keys = list(items)
    R = np.zeros((len(keys), config.N_VERTICES), dtype=np.float32)
    for i, key in enumerate(keys):
        mod, payload = items[key]
        print(f"  [{i+1}/{len(keys)}] {mod}: {key[:60]}")
        R[i] = tribe.encode_item(mod, payload)

    out = config.CACHE / "encoded.npz"
    np.savez(out, R=R, keys=np.array(keys))
    print(f"Saved {R.shape} -> {out}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--preflight-only", action="store_true")
    ap.add_argument("--skip-preflight", action="store_true")
    args = ap.parse_args()

    if not args.skip_preflight:
        preflight_still_image()
    if not args.preflight_only:
        main()

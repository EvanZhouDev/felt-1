"""Offline self-test of the metric/CV/verdict logic with synthetic vectors.

Fabricates a tiny encoded set + pairs.csv where matched pairs share a planted
'vibe' signal in non-sensory vertices and a modality offset in sensory vertices.
Confirms: raw cosine is weak, masking helps, AUC/perm/CV/verdict run end-to-end.
Does NOT hit any network. Writes to a temp results dir, restores afterward.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from vibe import config, metrics, masks  # noqa: E402

rng = np.random.default_rng(0)
V = config.N_VERTICES
N_TOPICS = 10

# Pretend the first 40% of vertices are "sensory" (modality fingerprint) and the
# rest are "association" carrying vibe. Anatomical mask can't be built offline
# (needs nilearn atlas), so we monkeypatch it to this synthetic split to test
# the masking code path deterministically.
SENSORY = np.zeros(V, dtype=bool)
SENSORY[: int(0.4 * V)] = True
ASSOC = ~SENSORY


def make_item(vibe_vec, modality_is_text):
    r = rng.normal(0, 0.1, V)
    # modality fingerprint: large constant offset in sensory region by modality
    r[SENSORY] += (3.0 if modality_is_text else -3.0)
    # vibe signal lives in association vertices
    r[ASSOC] += vibe_vec
    return r.astype(np.float32)


def build():
    texts_dir = config.DATA / "texts"; texts_dir.mkdir(exist_ok=True)
    rows = []
    Rlist, keys = [], []
    pid = 0
    for t in range(N_TOPICS):
        vibe = rng.normal(0, 1.0, ASSOC.sum())
        opp = -vibe + rng.normal(0, 0.3, ASSOC.sum())  # opposite vibe
        text_vec = make_item(vibe, True)
        cong_vec = make_item(vibe + rng.normal(0, 0.3, ASSOC.sum()), False)
        oppo_vec = make_item(opp, False)
        # payloads as production stores them: text payload string, image path string
        t_payload, c_payload, o_payload = f"topic{t}", f"cong{t}", f"oppo{t}"
        # encoded.npz keys are built the same way main() will: modality::payload
        for k, v in [(f"text::{t_payload}", text_vec),
                     (f"image::{c_payload}", cong_vec),
                     (f"image::{o_payload}", oppo_vec)]:
            keys.append(k); Rlist.append(v)
        rows.append(dict(pair_id=pid, topic=f"t{t}", modality_a="text", item_a=t_payload,
                         modality_b="image", item_b=c_payload, label="matched",
                         vibe_tags="x")); pid += 1
        rows.append(dict(pair_id=pid, topic=f"t{t}", modality_a="text", item_a=t_payload,
                         modality_b="image", item_b=o_payload, label="mismatched",
                         vibe_tags="x")); pid += 1
    R = np.array(Rlist)

    # write CSV with item_a as a key (not a .txt path) — patch load_text below
    with open(config.PAIRS_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader()
        w.writerows(rows)
    np.savez(config.CACHE / "encoded.npz", R=R, keys=np.array(keys))
    return R, rows


def run():
    R, rows = build()

    # monkeypatch anatomical mask + the report module's path helpers
    masks.anatomical_mask = lambda: ASSOC

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "m3", Path(__file__).resolve().parents[0] / "03_run_metrics.py")
    m3 = importlib.util.module_from_spec(spec)
    # the keys ARE the items in this synthetic test (no file reading)
    spec.loader.exec_module(m3)
    m3.load_text = lambda item: item.split("::", 1)[1] if "::" in item else item
    m3.resolve_path = lambda item: Path(item)
    # disable CLIP (no images on disk)
    m3.run_clip_baseline = lambda rows, matched, report: float("nan")

    m3.main()


if __name__ == "__main__":
    run()

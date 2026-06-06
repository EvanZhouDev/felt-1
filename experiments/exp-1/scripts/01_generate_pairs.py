"""Step 1 (§1): generate the labeled text<->image pair set.

For each topic spec: author the paragraph (DeepSeek), render a vibe-congruent
image and a vibe-opposite image (Flux). Emit:
  - data/texts/<topic>.txt
  - data/images/<topic>_congruent.png, <topic>_opposite.png
  - data/pairs.csv  (pair_id, modality_a, item_a, modality_b, item_b, label, vibe_tags)

The MATCHED pair is (text, congruent image); the MISMATCHED pair is
(text, opposite image) — same topic, opposite vibe.

Idempotent: skips items already on disk so it can resume.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vibe import config, deepseek, flux  # noqa: E402
from pair_specs import SPECS  # noqa: E402

TEXTS = config.DATA / "texts"
TEXTS.mkdir(exist_ok=True)

TEXT_SYSTEM = (
    "You are a precise prose writer. Write only the paragraph, no preamble, no "
    "title, no quotation marks. Evoke the requested feeling through concrete "
    "sensory detail, not by naming the emotion."
)


def slug(s: str) -> str:
    return s.replace(" ", "_")


def main() -> None:
    rows = []
    pair_id = 0
    for spec in SPECS:
        topic = spec["topic"]
        sg = slug(topic)

        # --- text (author once, cache to disk) ---
        text_path = TEXTS / f"{sg}.txt"
        if text_path.exists():
            text = text_path.read_text().strip()
            print(f"[text] {topic}: cached")
        else:
            print(f"[text] {topic}: generating...")
            text = deepseek.generate(spec["text_prompt"], system=TEXT_SYSTEM,
                                     temperature=1.0, max_tokens=400)
            text_path.write_text(text)
        # store the text inline in the CSV item_a (text modality wants the string)

        # --- images (congruent + opposite) ---
        cong = config.IMAGES / f"{sg}_congruent.png"
        oppo = config.IMAGES / f"{sg}_opposite.png"
        if not cong.exists():
            print(f"[img ] {topic}: congruent...")
            flux.generate(spec["img_congruent"], cong, seed=42)
        else:
            print(f"[img ] {topic}: congruent cached")
        if not oppo.exists():
            print(f"[img ] {topic}: opposite...")
            flux.generate(spec["img_opposite"], oppo, seed=42)
        else:
            print(f"[img ] {topic}: opposite cached")

        # --- matched pair: text + congruent image ---
        rows.append({
            "pair_id": pair_id,
            "topic": topic,
            "modality_a": "text",
            "item_a": str(text_path.relative_to(config.ROOT)),
            "modality_b": "image",
            "item_b": str(cong.relative_to(config.ROOT)),
            "label": "matched",
            "vibe_tags": spec["vibe_tags"],
        })
        pair_id += 1
        # --- mismatched pair: text + opposite image (same topic) ---
        rows.append({
            "pair_id": pair_id,
            "topic": topic,
            "modality_a": "text",
            "item_a": str(text_path.relative_to(config.ROOT)),
            "modality_b": "image",
            "item_b": str(oppo.relative_to(config.ROOT)),
            "label": "mismatched",
            "vibe_tags": f"{spec['vibe_tags']}  VS  {spec['opposite_vibe']}",
        })
        pair_id += 1

    with open(config.PAIRS_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    n_match = sum(r["label"] == "matched" for r in rows)
    print(f"\nWrote {len(rows)} pairs ({n_match} matched / {len(rows)-n_match} "
          f"mismatched) -> {config.PAIRS_CSV}")


if __name__ == "__main__":
    main()

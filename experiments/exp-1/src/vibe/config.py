"""Paths, endpoints, and fixed choices for the vibe-metric validation.

One place so every script shares the same constants. Keep normalization and
mesh facts here too — they are load-bearing for the metric.
"""
from __future__ import annotations

import os
from pathlib import Path

# --- repo paths ---------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
IMAGES = DATA / "images"
CACHE = ROOT / "cache"
PREDS_CACHE = CACHE / "preds"   # cached TRIBE r vectors (.npy), keyed by content hash
CLIP_CACHE = CACHE / "clip"     # cached CLIP embeddings
RESULTS = ROOT / "results"
PAIRS_CSV = DATA / "pairs.csv"

for _d in (DATA, IMAGES, CACHE, PREDS_CACHE, CLIP_CACHE, RESULTS):
    _d.mkdir(parents=True, exist_ok=True)

# --- external services --------------------------------------------------------
TRIBE_URL = os.environ.get("TRIBE_URL", "https://tribe.bryanhu.com")
FLUX_URL = os.environ.get("FLUX_URL", "https://images.bryanhu.com")
DEEPSEEK_URL = os.environ.get("DEEPSEEK_URL", "https://api.deepseek.com")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")

FLUX_MODEL = os.environ.get("FLUX_MODEL", "klein")
FLUX_STEPS = int(os.environ.get("FLUX_STEPS", "4"))
# Generate images at the clip size we feed TRIBE — no point rendering larger.
FLUX_WIDTH = int(os.environ.get("FLUX_WIDTH", "512"))
FLUX_HEIGHT = int(os.environ.get("FLUX_HEIGHT", "512"))

# Still image -> short-hold clip size for /predict/video. Capped at 600x400
# (smaller = much faster video inference on the MPS box).
CLIP_WIDTH = int(os.environ.get("CLIP_WIDTH", "600"))
CLIP_HEIGHT = int(os.environ.get("CLIP_HEIGHT", "400"))

# --- TRIBE output facts (from /metadata, confirmed empirically) ---------------
MESH = "fsaverage5"
N_VERTICES = 20484                       # 10242 per hemisphere
HEMI_VERTS = N_VERTICES // 2
# preds.norm.f16.bin is float16, shape [timesteps, N_VERTICES], ~per-vertex z-scored.

# Yeo-7 networks, in the order TRIBE's result.json `yeo7_means` reports them.
YEO7_NETWORKS = [
    "Visual",
    "Somatomotor",
    "Dorsal Attention",
    "Ventral Attention",
    "Limbic",
    "Frontoparietal",
    "Default Mode",
]
# Anatomical mask (§4 v1): DROP primary-sensory networks that carry the modality
# fingerprint; KEEP amodal / affective / higher-order association networks.
# Generous keep on purpose — vibe is whole-gestalt, not valence+arousal alone.
ANATOMICAL_DROP = {"Visual", "Somatomotor"}
ANATOMICAL_KEEP = [n for n in YEO7_NETWORKS if n not in ANATOMICAL_DROP]

# --- metric choices -----------------------------------------------------------
# Normalization applied to every r before any cosine. Held fixed across all
# conditions (§2). "zscore_then_l2": per-vertex z-score using stats over the
# whole item set, then L2-normalize.
NORMALIZATION = os.environ.get("VIBE_NORM", "zscore_then_l2")

# Time aggregation: collapse [timesteps, V] -> [V]. Mean is the default.
TIME_AGG = os.environ.get("VIBE_TIME_AGG", "mean")

# Pass/fail thresholds (§6).
GREEN_AUC = 0.75
N_PERMUTATIONS = 10000
RANDOM_SEED = 7

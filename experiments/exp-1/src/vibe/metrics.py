"""Distances, separation metrics, and baselines (§3, §5).

A "condition" is a function pair_distance(pair) -> float. For every pair we
compute the distance, then score separation as AUC of matched(=close, small d)
vs mismatched(=far, large d), plus a permutation test.
"""
from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score

from . import config


# --- normalization (§2: pick one, hold fixed) ---------------------------------
def normalize_matrix(R: np.ndarray) -> np.ndarray:
    """Apply config.NORMALIZATION to a [n_items, V] matrix of raw r vectors.

    zscore_then_l2: per-vertex z-score using stats over ALL items, then L2.
    l2: just L2-normalize each row.
    """
    R = R.astype(np.float64)
    mode = config.NORMALIZATION
    if mode in ("zscore_then_l2", "zscore"):
        mu = R.mean(axis=0, keepdims=True)
        sd = R.std(axis=0, keepdims=True)
        sd[sd == 0] = 1.0
        R = (R - mu) / sd
    if mode in ("zscore_then_l2", "l2"):
        norm = np.linalg.norm(R, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        R = R / norm
    return R


# --- distances ----------------------------------------------------------------
def cosine_distance(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None = None) -> float:
    if mask is not None:
        a, b = a[mask], b[mask]
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 1.0
    return 1.0 - float(np.dot(a, b) / (na * nb))


# --- separation scoring -------------------------------------------------------
def separation_auc(distances: np.ndarray, matched: np.ndarray) -> float:
    """AUC for matched-pairs-are-close. matched: bool[n_pairs].

    A perfect metric gives every matched pair a smaller distance than every
    mismatched pair. roc_auc_score expects higher score = positive class, so we
    score with -distance and treat matched as the positive class.
    """
    if matched.all() or (~matched).all():
        return float("nan")
    return float(roc_auc_score(matched.astype(int), -distances))


def permutation_pvalue(distances: np.ndarray, matched: np.ndarray,
                       n: int = config.N_PERMUTATIONS, seed: int = config.RANDOM_SEED
                       ) -> tuple[float, float, np.ndarray]:
    """Shuffle labels, recompute AUC n times. Returns (real_auc, p_value, null)."""
    rng = np.random.default_rng(seed)
    real = separation_auc(distances, matched)
    null = np.empty(n)
    lab = matched.copy()
    for i in range(n):
        rng.shuffle(lab)
        null[i] = separation_auc(distances, lab)
    # one-sided: how often shuffled AUC >= real
    p = (1 + np.sum(null >= real)) / (n + 1)
    return real, float(p), null


# --- condition runners --------------------------------------------------------
def condition_distances(R: np.ndarray, pairs: list[tuple[int, int]],
                        mask: np.ndarray | None) -> np.ndarray:
    """Distance per pair given normalized R and a vertex mask (or None=full)."""
    return np.array([cosine_distance(R[a], R[b], mask) for a, b in pairs])


# --- CLIP baseline (§3 cond. 4) -----------------------------------------------
_clip_state: dict = {}


def _clip_model():
    if "model" not in _clip_state:
        import open_clip
        import torch
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k"
        )
        model.eval()
        tokenizer = open_clip.get_tokenizer("ViT-B-32")
        _clip_state.update(
            model=model, preprocess=preprocess, tokenizer=tokenizer, torch=torch
        )
    return _clip_state


def clip_embed_text(text: str) -> np.ndarray:
    s = _clip_model()
    with s["torch"].no_grad():
        tok = s["tokenizer"]([text])
        emb = s["model"].encode_text(tok)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb[0].cpu().numpy()


def clip_embed_image(image_path) -> np.ndarray:
    from PIL import Image
    s = _clip_model()
    img = s["preprocess"](Image.open(image_path).convert("RGB")).unsqueeze(0)
    with s["torch"].no_grad():
        emb = s["model"].encode_image(img)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb[0].cpu().numpy()

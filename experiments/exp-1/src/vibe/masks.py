"""Vertex masks over the fsaverage5 mesh (§4).

The API's parcellation is fsaverage5 (20484 vertices) summarized by the Yeo-7
networks (TRIBE's result.json reports `yeo7_means` in that scheme). So the mask
is built on Yeo-7:

  anatomical (v1): keep amodal/affective/association networks, drop primary
    sensory (Visual, Somatomotor) which carry the modality fingerprint.
  data-driven (v2): per-vertex separation score from the pairs, cross-validated.

Per-vertex Yeo-7 labels for fsaverage5 come from nilearn's Yeo 2011 atlas
projected onto the fsaverage5 surface. If that download is unavailable offline,
we fall back to network-level masking computed from `yeo7_means` (coarser, still
valid) — controlled by the caller.
"""
from __future__ import annotations

import numpy as np

from . import config


# --- per-vertex Yeo-7 labels (fsaverage5) -------------------------------------
_LABELS_CACHE = config.CACHE / "yeo7_labels_fsaverage5.npy"


def yeo7_vertex_labels() -> np.ndarray:
    """Return int array [20484] of Yeo-7 network id per vertex.

    0 = medial wall / unassigned; 1..7 map to config.YEO7_NETWORKS in order.
    Cached to disk after first build.
    """
    if _LABELS_CACHE.exists():
        return np.load(_LABELS_CACHE)
    labels = _build_yeo7_labels_from_nilearn()
    np.save(_LABELS_CACHE, labels)
    return labels


def _build_yeo7_labels_from_nilearn() -> np.ndarray:
    """Project the Yeo-2011 7-network volumetric atlas onto fsaverage5 vertices.

    nilearn ships the Yeo atlas as a volume; we sample it at each fsaverage5
    vertex's MNI coordinate via nearest-neighbour. The volumetric Yeo network
    integer order matches Yeo's canonical order, which equals config.YEO7_NETWORKS.
    """
    from nilearn import datasets, surface
    from nilearn import image as nimg

    # nilearn >=0.13: fetch_atlas_yeo_2011(n_networks=7, thickness='thick') ->
    # `maps` is a single deterministic atlas with values 0 (background) and 1..7,
    # the 7 networks in Yeo's canonical order == config.YEO7_NETWORKS.
    yeo = datasets.fetch_atlas_yeo_2011(n_networks=7, thickness="thick")
    atlas_img = nimg.load_img(yeo["maps"])
    if atlas_img.ndim == 4:
        atlas_img = nimg.index_img(atlas_img, 0)

    fs = datasets.fetch_surf_fsaverage("fsaverage5")
    labels = []
    for hemi in ("left", "right"):
        coords, _ = surface.load_surf_mesh(fs[f"pial_{hemi}"])
        # sample atlas at vertex world coordinates (nearest neighbour)
        vals = _sample_volume_nn(atlas_img, coords)
        labels.append(vals.astype(np.int16))
    out = np.concatenate(labels)
    if out.size != config.N_VERTICES:
        raise RuntimeError(
            f"built {out.size} vertex labels, expected {config.N_VERTICES}"
        )
    return out


def _sample_volume_nn(img, coords_world: np.ndarray) -> np.ndarray:
    """Nearest-neighbour sample a 3D nifti at Nx3 world coordinates."""
    import numpy.linalg as la

    data = np.asarray(img.get_fdata())
    inv = la.inv(img.affine)
    homog = np.c_[coords_world, np.ones(len(coords_world))]
    vox = (inv @ homog.T).T[:, :3]
    vox = np.rint(vox).astype(int)
    out = np.zeros(len(coords_world), dtype=np.int32)
    shape = data.shape
    inside = (
        (vox[:, 0] >= 0) & (vox[:, 0] < shape[0])
        & (vox[:, 1] >= 0) & (vox[:, 1] < shape[1])
        & (vox[:, 2] >= 0) & (vox[:, 2] < shape[2])
    )
    vi = vox[inside]
    out[inside] = data[vi[:, 0], vi[:, 1], vi[:, 2]].astype(np.int32)
    return out


# --- anatomical mask ----------------------------------------------------------
def network_mask(keep_networks) -> np.ndarray:
    """Boolean [20484]: True for vertices in any of `keep_networks` (Yeo-7 names)."""
    labels = yeo7_vertex_labels()
    keep = set(keep_networks)
    keep_ids = [i + 1 for i, name in enumerate(config.YEO7_NETWORKS) if name in keep]
    return np.isin(labels, keep_ids)


def anatomical_mask() -> np.ndarray:
    """Boolean [20484]: True for KEPT vertices (amodal/affective/association)."""
    return network_mask(config.ANATOMICAL_KEEP)


# --- data-driven mask (§4 v2, cross-validated) --------------------------------
def data_driven_scores(R: np.ndarray, item_pair_idx: np.ndarray,
                       labels_matched: np.ndarray,
                       modality_a: np.ndarray) -> np.ndarray:
    """Per-vertex score: separates matched from mismatched, penalizes modality.

    R: [n_items, V] normalized vectors.
    item_pair_idx: [n_items] pair id each item belongs to.
    labels_matched: [n_pairs] bool, True if that pair is MATCHED.
    modality_a: [n_items] bool, True if item is modality A (text), else B (image).

    Returns score[V]; higher = more vibe-discriminative, less modality-driven.
    Intended to be called on a TRAIN subset only (CV done by caller).
    """
    V = R.shape[1]
    # modality signal per vertex: |mean_A - mean_B| over all items (to penalize)
    mod_signal = np.abs(R[modality_a].mean(0) - R[~modality_a].mean(0))

    # vibe signal: per-pair within-pair agreement (product of the two items'
    # values), averaged over matched pairs minus over mismatched pairs. A vertex
    # that lights up together for matched pairs but not mismatched is vibe-useful.
    pair_ids = np.unique(item_pair_idx)
    agree = np.zeros((len(pair_ids), V), dtype=np.float64)
    is_matched = np.zeros(len(pair_ids), dtype=bool)
    for k, pid in enumerate(pair_ids):
        items = np.where(item_pair_idx == pid)[0]
        if len(items) != 2:
            continue
        a, b = items
        agree[k] = R[a] * R[b]
        is_matched[k] = labels_matched[pid]
    vibe_signal = agree[is_matched].mean(0) - agree[~is_matched].mean(0)

    eps = 1e-8
    return vibe_signal / (mod_signal + eps)


def topk_mask(scores: np.ndarray, frac: float = 0.25) -> np.ndarray:
    """Keep the top `frac` vertices by score. Boolean [V]."""
    V = scores.shape[0]
    k = max(1, int(round(frac * V)))
    thresh = np.partition(scores, V - k)[V - k]
    return scores >= thresh

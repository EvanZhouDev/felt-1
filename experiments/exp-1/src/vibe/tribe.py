"""TRIBE v2 encode step (§2): item -> predicted brain-response vector r ∈ R^20484.

Async job API on tribe.bryanhu.com:
  POST /predict/text   {"text": ...}                 -> {job_id}
  POST /predict/video  multipart file=<mp4>          -> {job_id}   (used for still images)
  POST /predict/audio  multipart file=<audio>        -> {job_id}
  GET  /jobs/{id}                                    -> {status, ...}
  GET  /jobs/{id}/preds.norm.f16.bin                 -> float16 [T, 20484]

/predict/image is broken server-side ("Unknown input type: image"), so a still
image is fed as a degenerate short-hold clip via /predict/video (spec §0/§2).

Raw r vectors are cached to disk keyed by (modality, content-hash) so conditions
can be re-run without re-encoding (spec: keep encode separate from metric).
"""
from __future__ import annotations

import hashlib
import io
import subprocess
import time
from pathlib import Path

import numpy as np
import requests

from . import config

POLL_INTERVAL_S = 3.0
POLL_TIMEOUT_S = 600.0
HTTP_TIMEOUT_S = 60.0


class TribeError(RuntimeError):
    pass


# --- caching ------------------------------------------------------------------
def _hash(*parts: bytes) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
        h.update(b"\x00")
    return h.hexdigest()[:16]


def _cache_path(modality: str, key: str) -> Path:
    return config.PREDS_CACHE / f"{modality}_{key}.npy"


def _load_cached(path: Path) -> np.ndarray | None:
    if path.exists():
        return np.load(path)
    return None


# --- job lifecycle ------------------------------------------------------------
def _submit_text(text: str) -> str:
    r = requests.post(
        f"{config.TRIBE_URL}/predict/text",
        json={"text": text},
        timeout=HTTP_TIMEOUT_S,
    )
    r.raise_for_status()
    return r.json()["job_id"]


def _submit_file(endpoint: str, data: bytes, filename: str) -> str:
    r = requests.post(
        f"{config.TRIBE_URL}/{endpoint}",
        files={"file": (filename, data)},
        timeout=HTTP_TIMEOUT_S,
    )
    r.raise_for_status()
    return r.json()["job_id"]


def _poll(job_id: str, *, timeout_s: float = POLL_TIMEOUT_S) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = requests.get(f"{config.TRIBE_URL}/jobs/{job_id}", timeout=HTTP_TIMEOUT_S)
        r.raise_for_status()
        body = r.json()
        status = body.get("status")
        if status == "completed":
            return body
        if status == "failed":
            raise TribeError(f"job {job_id} failed: {body.get('error')}")
        time.sleep(POLL_INTERVAL_S)
    raise TribeError(f"job {job_id} timed out after {timeout_s}s")


def _fetch_preds(job_id: str) -> np.ndarray:
    """Return [T, N_VERTICES] float32."""
    r = requests.get(
        f"{config.TRIBE_URL}/jobs/{job_id}/preds.norm.f16.bin", timeout=HTTP_TIMEOUT_S
    )
    r.raise_for_status()
    flat = np.frombuffer(r.content, dtype=np.float16)
    if flat.size % config.N_VERTICES != 0:
        raise TribeError(
            f"preds size {flat.size} not divisible by {config.N_VERTICES}"
        )
    t = flat.size // config.N_VERTICES
    return flat.reshape(t, config.N_VERTICES).astype(np.float32)


def _aggregate_time(preds: np.ndarray) -> np.ndarray:
    """[T, V] -> [V]. Collapse the time axis per config.TIME_AGG."""
    if config.TIME_AGG == "mean":
        return preds.mean(axis=0)
    if config.TIME_AGG == "max":
        return preds.max(axis=0)
    raise ValueError(f"unknown TIME_AGG {config.TIME_AGG}")


# --- still image -> short-hold clip -------------------------------------------
def image_to_clip(image_path: Path, *, seconds: float = config.CLIP_SECONDS,
                  fps: int = config.CLIP_FPS,
                  width: int = config.CLIP_WIDTH, height: int = config.CLIP_HEIGHT
                  ) -> bytes:
    """Render a still image as a degenerate held video (mp4 bytes) via ffmpeg.

    Capped at config.CLIP_WIDTH x CLIP_HEIGHT (default 600x400) — keeps the
    still's aspect ratio (scale-to-fit + pad) and keeps video inference fast.
    """
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-i", str(image_path),
        "-t", str(seconds), "-r", str(fps),
        "-vf", (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"),
        "-pix_fmt", "yuv420p",
        "-f", "mp4", "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise TribeError(f"ffmpeg failed: {proc.stderr.decode()[:400]}")
    return proc.stdout


# --- public encode API --------------------------------------------------------
def encode_text(text: str, *, use_cache: bool = True) -> np.ndarray:
    key = _hash(text.encode("utf-8"))
    path = _cache_path("text", key)
    if use_cache and (cached := _load_cached(path)) is not None:
        return cached
    job = _submit_text(text)
    _poll(job)
    r = _aggregate_time(_fetch_preds(job))
    np.save(path, r)
    return r


def encode_image(image_path: Path, *, use_cache: bool = True) -> np.ndarray:
    image_path = Path(image_path)
    key = _hash(image_path.read_bytes())
    path = _cache_path("image", key)
    if use_cache and (cached := _load_cached(path)) is not None:
        return cached
    clip = image_to_clip(image_path)
    job = _submit_file("predict/video", clip, "image_clip.mp4")
    _poll(job)
    r = _aggregate_time(_fetch_preds(job))
    np.save(path, r)
    return r


def encode_audio(audio_path: Path, *, use_cache: bool = True) -> np.ndarray:
    audio_path = Path(audio_path)
    key = _hash(audio_path.read_bytes())
    path = _cache_path("audio", key)
    if use_cache and (cached := _load_cached(path)) is not None:
        return cached
    job = _submit_file("predict/audio", audio_path.read_bytes(), audio_path.name)
    _poll(job)
    r = _aggregate_time(_fetch_preds(job))
    np.save(path, r)
    return r


def encode_item(modality: str, item: str, *, use_cache: bool = True) -> np.ndarray:
    """Dispatch by modality. `item` is text for text, else a file path."""
    if modality == "text":
        return encode_text(item, use_cache=use_cache)
    if modality == "image":
        return encode_image(Path(item), use_cache=use_cache)
    if modality == "audio":
        return encode_audio(Path(item), use_cache=use_cache)
    raise ValueError(f"unknown modality {modality}")


def metadata() -> dict:
    r = requests.get(f"{config.TRIBE_URL}/metadata", timeout=HTTP_TIMEOUT_S)
    r.raise_for_status()
    return r.json()


def health() -> dict:
    r = requests.get(f"{config.TRIBE_URL}/health", timeout=HTTP_TIMEOUT_S)
    r.raise_for_status()
    return r.json()

"""Image generation via the Flux API at images.bryanhu.com.

  GET /generate?prompt=...&model=klein&steps=4&seed=N  -> PNG bytes
"""
from __future__ import annotations

from pathlib import Path

import requests

from . import config


def generate(prompt: str, out_path: Path, *, seed: int = 42,
             model: str | None = None, steps: int | None = None,
             width: int | None = None, height: int | None = None) -> Path:
    out_path = Path(out_path)
    r = requests.get(
        f"{config.FLUX_URL}/generate",
        params={
            "prompt": prompt,
            "model": model or config.FLUX_MODEL,
            "steps": steps or config.FLUX_STEPS,
            "seed": seed,
            "width": width or config.FLUX_WIDTH,
            "height": height or config.FLUX_HEIGHT,
        },
        timeout=180,
    )
    r.raise_for_status()
    ct = r.headers.get("Content-Type", "")
    if "image" not in ct and not r.content[:8].startswith(b"\x89PNG"):
        raise RuntimeError(f"flux did not return an image (Content-Type={ct})")
    out_path.write_bytes(r.content)
    return out_path

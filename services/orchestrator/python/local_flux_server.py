from __future__ import annotations

import hashlib
import json
import os
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import torch
from diffusers import Flux2KleinPipeline


MODEL_ALIASES = {
    "klein": "black-forest-labs/FLUX.2-klein-4B",
    "flux2-klein": "black-forest-labs/FLUX.2-klein-4B",
}

HOST = os.environ.get("VOLTA_LOCAL_FLUX_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOLTA_LOCAL_FLUX_PORT", "8799"))
CACHE_ROOT = Path(
    os.environ.get(
        "VOLTA_LOCAL_FLUX_CACHE",
        str(Path.cwd() / ".volta" / "local-flux-cache"),
    )
)
DEFAULT_MODEL = os.environ.get(
    "VOLTA_LOCAL_FLUX_MODEL",
    "black-forest-labs/FLUX.2-klein-4B",
)
DEFAULT_STEPS = int(os.environ.get("VOLTA_LOCAL_FLUX_STEPS", "2"))
MAX_STEPS = int(os.environ.get("VOLTA_LOCAL_FLUX_MAX_STEPS", "2"))
MAX_DIMENSION = int(os.environ.get("VOLTA_LOCAL_FLUX_MAX_DIMENSION", "768"))

_pipe: Flux2KleinPipeline | None = None
_model_id: str | None = None
_device: str | None = None


def main() -> None:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        json.dumps(
            {
                "event": "local-flux-server-started",
                "host": HOST,
                "port": PORT,
                "cacheRoot": str(CACHE_ROOT),
                "model": DEFAULT_MODEL,
            }
        ),
        flush=True,
    )
    server.serve_forever()


class Handler(BaseHTTPRequestHandler):
    server_version = "VoltaLocalFlux/0.1"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.write_json({"ok": True})
            return
        if parsed.path != "/generate":
            self.write_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return

        params = parse_qs(parsed.query)
        prompt = first(params, "prompt").strip()
        if not prompt:
            self.write_json(
                {"error": "missing prompt"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        try:
            image_path, metadata = generate(
                prompt=prompt,
                model=resolve_model(first(params, "model") or DEFAULT_MODEL),
                seed=int(first(params, "seed") or stable_seed(prompt)),
                width=bounded_dimension(first(params, "width"), 512),
                height=bounded_dimension(first(params, "height"), 512),
                steps=bounded_steps(first(params, "steps")),
            )
        except Exception as error:  # pragma: no cover - surfaced to pipeline
            self.write_json(
                {
                    "error": str(error),
                    "type": type(error).__name__,
                },
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("X-Volta-Local-Flux", "true")
        self.send_header("X-Volta-Local-Flux-Metadata", json.dumps(metadata))
        self.send_header("Content-Length", str(image_path.stat().st_size))
        self.end_headers()
        with image_path.open("rb") as file:
            self.wfile.write(file.read())

    def log_message(self, format: str, *args: object) -> None:
        print(
            json.dumps(
                {
                    "event": "request",
                    "client": self.client_address[0],
                    "message": format % args,
                }
            ),
            flush=True,
        )

    def write_json(
        self,
        value: object,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        payload = json.dumps(value, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def generate(
    *,
    prompt: str,
    model: str,
    seed: int,
    width: int,
    height: int,
    steps: int,
) -> tuple[Path, dict[str, object]]:
    key = hashlib.sha256(
        json.dumps(
            {
                "prompt": prompt,
                "model": model,
                "seed": seed,
                "width": width,
                "height": height,
                "steps": steps,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:20]
    image_path = CACHE_ROOT / f"{key}.png"
    metadata_path = CACHE_ROOT / f"{key}.json"
    if image_path.exists():
        metadata = json.loads(metadata_path.read_text("utf-8"))
        metadata["cacheHit"] = True
        return image_path, metadata

    pipe = load_pipe(model)
    generator = torch.Generator(device="cpu").manual_seed(seed)
    start = time.monotonic()
    with torch.inference_mode():
        image = pipe(
            prompt=prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            generator=generator,
        ).images[0].convert("RGB")
    seconds = time.monotonic() - start
    image.save(image_path)
    metadata = {
        "prompt": prompt,
        "model": model,
        "seed": seed,
        "width": width,
        "height": height,
        "steps": steps,
        "seconds": round(seconds, 3),
        "device": _device,
        "cacheHit": False,
    }
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=True) + "\n",
        "utf-8",
    )
    return image_path, metadata


def load_pipe(model: str) -> Flux2KleinPipeline:
    global _pipe
    global _model_id
    global _device
    if _pipe is not None and _model_id == model:
        return _pipe

    _device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.bfloat16 if _device == "mps" else torch.float32
    load_start = time.monotonic()
    pipe = Flux2KleinPipeline.from_pretrained(
        model,
        torch_dtype=dtype,
        local_files_only=True,
    )
    pipe = pipe.to(_device)
    pipe.set_progress_bar_config(disable=True)
    _pipe = pipe
    _model_id = model
    print(
        json.dumps(
            {
                "event": "model-loaded",
                "model": model,
                "device": _device,
                "dtype": str(dtype),
                "seconds": round(time.monotonic() - load_start, 3),
            }
        ),
        flush=True,
    )
    return pipe


def resolve_model(value: str) -> str:
    return MODEL_ALIASES.get(value, value)


def bounded_dimension(value: str, fallback: int) -> int:
    try:
        dimension = int(value)
    except ValueError:
        dimension = fallback
    dimension = max(64, min(MAX_DIMENSION, dimension))
    return max(8, round(dimension / 8) * 8)


def bounded_steps(value: str) -> int:
    try:
        steps = int(value)
    except ValueError:
        steps = DEFAULT_STEPS
    return max(1, min(MAX_STEPS, steps))


def first(params: dict[str, list[str]], key: str) -> str:
    values = params.get(key)
    return values[0] if values else ""


def stable_seed(prompt: str) -> int:
    return int(hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8], 16)


if __name__ == "__main__":
    main()

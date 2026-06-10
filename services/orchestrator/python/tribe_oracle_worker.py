#!/usr/bin/env python3
import json
import math
import os
import sys
import traceback
from typing import Any
from urllib.parse import unquote, urlparse

import pandas as pd
from tribev2 import TribeModel


class TribeOracleWorker:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.model_key: tuple[str, str, str] | None = None

    def encode(self, payload: dict[str, Any]) -> dict[str, Any]:
        stimulus = payload["stimulus"]
        model = self.get_model(payload)
        events = self.build_events(model, stimulus)
        preds, _segments = model.predict(events=events, verbose=False)
        pooled = preds.mean(axis=0, keepdims=True)

        return {
            "model": "tribev2",
            "shape": list(pooled.shape),
            "values": pooled.tolist(),
            "summary": {
                "mean": float(pooled.mean()),
                "std": float(pooled.std()),
                "norm": float(math.sqrt(float((pooled * pooled).sum()))),
            },
        }

    def build_events(self, model: Any, stimulus: dict[str, Any]) -> pd.DataFrame:
        # Audio stimuli carry the file by path, not pre-built events: TRIBE
        # natively ingests audio via get_events_dataframe(audio_path=...), which
        # runs the full audio→words transform chain. (TS only emits a single
        # placeholder Audio event; the real frame must be built here.)
        kind = stimulus.get("kind")
        if kind == "audio":
            audio_path = _local_path(stimulus.get("artifactPath"))
            if not audio_path:
                raise ValueError("audio stimulus has no artifactPath to load.")
            return model.get_events_dataframe(audio_path=audio_path)
        # Image / code stimuli render to kind "video" with a single asset event.
        # TRIBE only ingests video by path (.mp4...), so a still must first become
        # a held clip. We convert the image to a short silent mp4 and feed the
        # native get_events_dataframe(video_path=...) — the audio/text stages
        # no-op for a silent painting, leaving the visual feature extractor.
        if kind == "video":
            video_path = _video_path_for(stimulus.get("artifactPath"))
            return model.get_events_dataframe(video_path=video_path)
        return pd.DataFrame(_with_word_context(stimulus["events"]))

    def get_model(self, payload: dict[str, Any]) -> Any:
        cache_folder = payload.get("cacheFolder", "cache")
        text_feature_model = payload.get(
            "textFeatureModel", "unsloth/Llama-3.2-3B-bnb-4bit"
        )
        device = payload.get("device") or os.environ.get("VOLTA_TRIBE_DEVICE", "cpu")
        model_key = (cache_folder, text_feature_model, device)
        if self.model is not None and self.model_key == model_key:
            return self.model

        self.model = TribeModel.from_pretrained(
            "facebook/tribev2",
            cache_folder=cache_folder,
            device=device,
            config_update={
                "data.num_workers": 0,
                "data.batch_size": 1,
                "data.text_feature.model_name": text_feature_model,
                "data.text_feature.device": "cpu",
                "data.text_feature.batch_size": 1,
            },
        )
        self.model_key = model_key
        return self.model


def _with_word_context(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # TRIBE's text feature extractor is contextualized by default: every Word
    # event must carry the surrounding sentence as `context` (and `sentence`),
    # or it raises "Empty text or context". The native audio path fills these
    # from WhisperX; our TS-built text events don't, so inject them here. Each
    # word's context is the full text of the Text event on its timeline.
    sentence_by_timeline: dict[str, str] = {}
    for event in events:
        if event.get("type") == "Text" and event.get("text"):
            sentence_by_timeline[event.get("timeline", "main")] = event["text"]
    full_text = next(iter(sentence_by_timeline.values()), "")

    enriched: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") == "Word":
            context = sentence_by_timeline.get(
                event.get("timeline", "main"), full_text
            )
            event = {
                **event,
                "context": event.get("context") or context,
                "sentence": event.get("sentence") or context,
            }
        enriched.append(event)
    return enriched


_VIDEO_SUFFIXES = {".mp4", ".avi", ".mkv", ".mov", ".webm"}
_STILL_CLIP_SECONDS = 3.0
_STILL_CLIP_FPS = 8


def _video_path_for(uri: str | None) -> str:
    # A real video/code clip is passed through; a still image is converted to a
    # short silent held clip so TRIBE's video_path entry accepts it.
    path = _local_path(uri)
    if not path:
        raise ValueError("video stimulus has no artifactPath to load.")
    import os

    suffix = os.path.splitext(path)[1].lower()
    if suffix in _VIDEO_SUFFIXES:
        return path

    import tempfile

    from moviepy import ImageClip

    out = os.path.join(tempfile.mkdtemp(prefix="volta-still-"), "still.mp4")
    clip = ImageClip(path, duration=_STILL_CLIP_SECONDS).with_fps(_STILL_CLIP_FPS)
    clip.write_videofile(out, audio=False, logger=None)
    return out


def _local_path(uri: str | None) -> str | None:
    if not uri:
        return None
    if uri.startswith("file://"):
        return unquote(urlparse(uri).path)
    if "://" in uri:
        raise ValueError(
            f"local TRIBE worker cannot fetch remote audio: {uri}. "
            "Use VOLTA_ORACLE=http for remote artifacts."
        )
    return uri


def main() -> None:
    worker = TribeOracleWorker()
    for line in sys.stdin:
        if not line.strip():
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload["id"]
            response = {
                "id": request_id,
                "ok": True,
                "trace": worker.encode(payload),
            }
        except Exception as error:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(error),
                "traceback": traceback.format_exc(limit=20),
            }

        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import json
import math
import sys
import traceback
from typing import Any

import pandas as pd
from tribev2 import TribeModel


class TribeOracleWorker:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.model_key: tuple[str, str] | None = None

    def encode(self, payload: dict[str, Any]) -> dict[str, Any]:
        stimulus = payload["stimulus"]
        events = pd.DataFrame(stimulus["events"])
        model = self.get_model(payload)
        preds, _segments = model.predict(events=events, verbose=False)

        return {
            "model": "tribev2",
            "shape": list(preds.shape),
            "summary": {
                "mean": float(preds.mean()),
                "std": float(preds.std()),
                "norm": float(math.sqrt(float((preds * preds).sum()))),
            },
        }

    def get_model(self, payload: dict[str, Any]) -> Any:
        cache_folder = payload.get("cacheFolder", "cache")
        text_feature_model = payload.get(
            "textFeatureModel", "unsloth/Llama-3.2-3B-bnb-4bit"
        )
        model_key = (cache_folder, text_feature_model)
        if self.model is not None and self.model_key == model_key:
            return self.model

        self.model = TribeModel.from_pretrained(
            "facebook/tribev2",
            cache_folder=cache_folder,
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

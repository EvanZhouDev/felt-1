# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

"""Named config overrides to apply on top of default_config."""

import copy

from exca import ConfDict

from .defaults import default_config

mini_config = ConfDict(copy.deepcopy(default_config))
mini_config.update(
    {
        "data": {
            "layers_to_use": None,
            "layer_aggregation": "mean",
            "text_feature": {
                "model_name": "Qwen/Qwen3-0.6B",
                "layers": 2 / 3,
            },
            "video_feature": {
                "image": {
                    "model_name": "facebook/vjepa2-vitl-fpc64-256",
                    "layers": 2 / 3,
                },
            },
            "audio_feature": {
                "layers": 2 / 3,
            },
        },
    }
)

base_config = ConfDict(copy.deepcopy(default_config))
base_config.update(
    {
        "data": {
            "text_feature": {
                "cache_n_layers": 20,
            },
            "image_feature": {
                "image": {
                    "cache_n_layers": 20,
                },
            },
            "video_feature": {
                "image": {
                    "cache_n_layers": 20,
                },
            },
            "audio_feature": {
                "cache_n_layers": 20,
            },
        },
    }
)

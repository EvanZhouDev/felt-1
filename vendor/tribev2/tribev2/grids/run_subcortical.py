# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

from exca import ConfDict
from neuraltrain.utils import run_grid

from ..main import TribeExperiment  # type: ignore
from .configs import mini_config

GRID_NAME = "subcortical"

update = {
    "wandb_config.group": GRID_NAME,
    "data.neuro": {
        "projection": {
            "name": "MaskProjector",
            "mask": "subcortical",
            "=replace=": True,
        },
        "fwhm": 6.0,
    },
}

grid = {
    "data.study.names": [
        "Algonauts2025Bold",
        "Lahner2024Bold",
        "Lebel2023Bold",
        "Wen2017",
        ["Algonauts2025Bold", "Lahner2024Bold", "Lebel2023Bold", "Wen2017"],
    ],
}


if __name__ == "__main__":
    updated_config = ConfDict(mini_config)
    updated_config.update(update)

    out = run_grid(
        TribeExperiment,
        GRID_NAME,
        updated_config,
        grid,
        job_name_keys=["wandb_config.name", "infra.job_name"],
        combinatorial=True,
        overwrite=False,
        dry_run=False,
        infra_mode="force",
    )

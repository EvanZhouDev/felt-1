# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

"""Quick test run on reduced data and number of epochs for CI.
"""

import os

from exca import ConfDict

from ..main import TribeExperiment  # type: ignore
from .configs import mini_config

update = {
    "data.num_workers": 0,
    "infra.cluster": None,
    "infra.workdir": None,
    "wandb_config": None,
    "save_checkpoints": False,
    "n_epochs": 3,
    "infra.gpus_per_node": 1,
    "infra.mode": "force",
    "data.study.names": "Algonauts2025Bold",
    "data.study.transforms.query.query": "subject_timeline_index<3",
}

updated_config = ConfDict(mini_config)
updated_config.update(update)


def test_run(config: dict) -> None:
    task = TribeExperiment(**config)
    task.infra.clear_job()
    task.run()


if __name__ == "__main__":
    folder = os.path.join(updated_config["infra"]["folder"], "test")
    updated_config["infra"]["folder"] = folder
    if os.path.exists(folder):
        import shutil

        shutil.rmtree(folder)
    test_run(updated_config)

# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

"""Default configuration dictionary for TRIBE v2 experiments."""
import os
from pathlib import Path

PROJECT_NAME = "tribe_release"

SLURM_PARTITION = os.getenv("SLURM_PARTITION", "")
SLURM_CONSTRAINT = os.getenv("SLURM_CONSTRAINT", "")
WANDB_ENTITY = os.getenv("WANDB_ENTITY", "")
DATADIR = os.getenv("DATAPATH")
BASEDIR = os.getenv("SAVEPATH")
CACHEDIR = os.path.join(BASEDIR, "cache", PROJECT_NAME)
SAVEDIR = os.path.join(BASEDIR, "results", PROJECT_NAME)
N_CPUS = 20

for path in [CACHEDIR, SAVEDIR, DATADIR]:
    Path(path).mkdir(parents=True, exist_ok=True)

text_feature = {
    "name": "HuggingFaceText",
    "event_types": "Word",
    "model_name": "meta-llama/Llama-3.2-3B",
    "aggregation": "sum",
    "frequency": 2,
    "contextualized": True,
    "layers": [0, 0.2, 0.4, 0.6, 0.8, 1.0],
    "batch_size": 4,
}
image_feature = {
    "name": "HuggingFaceVideo",
    "frequency": 2,
    "event_types": "Video",
    "aggregation": "sum",
    "image": {
        "name": "HuggingFaceImage",
        "model_name": "facebook/dinov2-large",
        "layers": 2 / 3,
        "infra": {"keep_in_ram": False},
        "batch_size": 4,
    },
}
video_feature = image_feature | {
    "clip_duration": 4,
    "image": {
        "name": "HuggingFaceImage",
        "model_name": "facebook/vjepa2-vitg-fpc64-256",
        "infra": {"keep_in_ram": False},
        "layers": [0.75, 1.0],
    },
}
audio_feature = {
    "name": "Wav2VecBert",
    "frequency": 2,
    "layers": [0.75, 1.0],
    "event_types": "Audio",
    "aggregation": "sum",
}
neuro_extractor = {
    "name": "FmriExtractor",
    "allow_missing": True,
    "offset": 5,
    "frequency": 1,
    "projection": {
        "name": "SurfaceProjector",
        "mesh": "fsaverage5",
        "kind": "ball",
        "radius": 3,
    },
}
for extractor in [
    text_feature,
    image_feature,
    video_feature,
    audio_feature,
    neuro_extractor,
]:
    extractor["infra"] = {
        "cluster": "slurm",
        "cpus_per_task": 10,
        "folder": CACHEDIR,
        "keep_in_ram": True,
        "mode": "cached",
        "min_samples_per_job": 1,
        "max_jobs": 256,
        "timeout_min": 60 * 12,
        "slurm_partition": SLURM_PARTITION,
    }
    extractor["infra"]["version"] = "release"
    if extractor["name"] == "FmriExtractor":
        extractor["infra"]["max_jobs"] = 1024
    else:
        extractor["infra"]["gpus_per_node"] = 1
        extractor["infra"]["slurm_constraint"] = SLURM_CONSTRAINT
    if extractor["name"] == "HuggingFaceVideo":
        extractor["infra"]["min_samples_per_job"] = 1
        extractor["infra"]["max_jobs"] = 1024
        extractor["infra"]["timeout_min"] = 60 * 24
    if extractor["name"] == "HuggingFaceText":
        extractor["infra"]["min_samples_per_job"] = 32
    extractor["allow_missing"] = True
    extractor["=replace="] = True

default_config = {
    "infra": {
        "cluster": "slurm",
        "slurm_partition": SLURM_PARTITION,
        "folder": SAVEDIR,
        "gpus_per_node": 1,
        "cpus_per_task": N_CPUS,
        "mem_gb": 128,
        "timeout_min": 60 * 24 * 3,
        "mode": "retry",
        "slurm_constraint": SLURM_CONSTRAINT,
        "workdir": {
            "copied": ["neuralset", "neuraltrain", "tribev2"],
            "includes": ["*.py", "*.txt"],
        },
    },
    "data": {
        "frequency": 2,
        "duration_trs": 100,
        "overlap_trs_train": 0,
        "overlap_trs_val": 0,
        "shuffle_val": True,
        "num_workers": N_CPUS,
        "layers_to_use": [0.5, 0.75, 1.0],
        "layer_aggregation": "group_mean",
        "study": {
            "names": [
                "Algonauts2025Bold",
                "Wen2017",
                "Lahner2024Bold",
                "Lebel2023Bold",
            ],
            "path": DATADIR,
            "query": None,
            "infra_timelines": {
                "folder": CACHEDIR,
                "timeout_min": 60 * 12,
                "min_samples_per_job": 4,
                "max_jobs": 1024,
                "version": "final",
            },
            "transforms": {
                "extractaudio": {"name": "ExtractAudioFromVideo"},
                "extractwords": {"name": "ExtractWordsFromAudio"},
                "addtext": {"name": "AddText"},
                "addsentence": {
                    "name": "AddSentenceToWords",
                    "max_unmatched_ratio": 0.05,
                },
                "addcontext": {
                    "name": "AddContextToWords",
                    "sentence_only": False,
                    "max_context_len": 1024,
                    "split_field": "",
                },
                "removemissing": {"name": "RemoveMissing"},
                "chunksounds": {
                    "name": "ChunkEvents",
                    "event_type_to_chunk": "Audio",
                    "max_duration": 60,
                    "min_duration": 30,
                },
                "chunkvideos": {
                    "name": "ChunkEvents",
                    "event_type_to_chunk": "Video",
                    "max_duration": 60,
                    "min_duration": 30,
                    "infra": {"backend": "Cached", "folder": CACHEDIR},
                },
                "query": {"name": "QueryEvents", "query": None},
                "split": {"name": "SplitEvents", "val_ratio": 0.1},
            },
        },
        "neuro": neuro_extractor,
        "features_to_use": ["text", "audio", "video"],
        "text_feature": text_feature,
        "video_feature": video_feature,
        "audio_feature": audio_feature,
        "image_feature": image_feature,
        "batch_size": 8,
    },
    "wandb_config": {
        "log_model": False,
        "entity": WANDB_ENTITY,
        "project": PROJECT_NAME,
        "group": "default",
    },
    "brain_model_config": {
        "name": "FmriEncoder",
        "low_rank_head": 2048,
        "hidden": 1152,
        "extractor_aggregation": "cat",
        "layer_aggregation": "cat",
        "combiner": None,
        "encoder": {
            "depth": 8,
        },
        "subject_layers": {"subject_dropout": 0.1},
        "subject_embedding": False,
        "modality_dropout": 0.3,
    },
    "metrics": [
        {
            "log_name": "pearson",
            "name": "OnlinePearsonCorr",
            "dim": 0,
        },
        {
            "log_name": "subj_pearson",
            "name": "GroupedMetric",
            "metric_name": "OnlinePearsonCorr",
            "kwargs": {"dim": 0},
        },
        {
            "log_name": "retrieval_top1",
            "name": "TopkAcc",
            "topk": 1,
        },
    ],
    "loss": {"name": "MSELoss", "kwargs": {"reduction": "none"}},
    "optim": {
        "name": "LightningOptimizer",
        "optimizer": {
            "name": "Adam",
            "lr": 1e-4,
            "kwargs": {
                "weight_decay": 0.0,
            },
        },
        "scheduler": {
            "name": "OneCycleLR",
            "kwargs": {
                "max_lr": 1e-4,
                "pct_start": 0.1,
            },
        },
    },
    "n_epochs": 15,
    "limit_train_batches": None,
    "patience": None,
    "enable_progress_bar": True,
    "log_every_n_steps": 5,
    "fast_dev_run": False,
    "seed": 33,
}


if __name__ == "__main__":
    # The following can be used for local debugging/quick tests.

    from ..main import TribeExperiment

    exp = TribeExperiment(
        **default_config,
    )

    exp.infra.clear_job()
    out = exp.run()
    print(out)

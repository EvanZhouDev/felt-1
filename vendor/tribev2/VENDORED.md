# Vendored TRIBE v2

This directory is a vendored source snapshot of Meta TRIBE v2.

- Upstream: `https://github.com/facebookresearch/tribev2.git`
- Upstream commit: `34f52344e5ba96660fac877393e1954e399d3ef3`
- Vendored for: Project Volta TRIBE oracle bridge

The nested upstream `.git` directory is intentionally removed. Volta owns this
snapshot so users can clone one repository and run the scaffold without Git
submodule setup.

Python environments and downloaded model weights are intentionally not vendored.
Run `bun run setup:tribe` from the Volta root to create
`vendor/tribev2/.venv`; runtime caches live under `vendor/tribev2/cache`.

## Local Patches

Volta currently carries two runtime compatibility patches:

- `tribev2/demo_utils.py`: allows `"auto"` device selection to choose MPS while
  keeping feature extractors on CPU when needed.
- `tribev2/eventstransforms.py`: uses WhisperX `int8` compute on non-CUDA
  devices instead of forcing `float16`.

When refreshing TRIBE, reapply these patches or replace them with upstream
equivalent behavior.

# exp-1 — Does a TRIBE distance separate vibe-matched cross-modal pairs?

## The point

Project Volta bets on **vibe transfer across any format** — carry the *feeling* of
a song into a paragraph, of an image into a UI, of text into a picture. The whole
product rests on one shared "vibe space": Meta's **TRIBE v2** brain-response model,
which predicts how the brain responds to text, image, and audio. The plan is to
capture an input's vibe as a target point in that space, then run generator agents
that propose cross-modal outputs and a scorer that keeps the ones landing near the
target.

That plan only works **if** one assumption is true:

> A song and a paragraph that *feel the same* land near each other in TRIBE space.

This is plausible (the brain has supramodal affective regions) but **unproven for
TRIBE's predicted geometry**. TRIBE was trained to predict brain responses to
movies, not to be a vibe-similarity metric. The obvious failure mode: a paragraph
and an image drive *different sensory cortices* (TRIBE turns text → speech → audio,
so text hits **auditory** cortex; images hit **visual** cortex). A naive full-vector
distance would then mostly measure *"different modality,"* drowning out *"same vibe."*

**This experiment is the gate.** It is a measurement, not a generation, experiment —
no agents, no diffusion, no LLM-in-the-loop. Just: encode hand-labeled cross-modal
pairs → compute distances → check whether matched pairs come out closer than
mismatched ones.

- **Green** → the foundation holds; build the generate→score→refine loop.
- **Yellow** → masking is doing the work; proceed but invest in the mask.
- **Red** → TRIBE's geometry doesn't carry cross-modal vibe at this resolution;
  the next step is a *learned alignment head*, **not** a generator swarm.

**Do not build the agent loop until this is green.**

## Why masking is the core idea

The full TRIBE vector is dominated by *which sensory cortex lit up* — a signal that
is roughly **constant across every pair** and tells you nothing about vibe. So we
mask it out. TRIBE predicts onto the `fsaverage5` surface (20,484 vertices),
summarized by the **Yeo-7 networks**. The mask:

- **Drops** Visual + Somatomotor — the primary-sensory modality fingerprint.
- **Keeps** Limbic, Default Mode, Frontoparietal, and Attention networks — the
  amodal / affective / higher-order association regions where a paragraph and an
  image that *feel* the same can actually be near each other.

A generous keep on purpose: vibe is the whole gestalt, not just valence+arousal, so
this is *not* an amygdala-only mask.

## What it tests (the conditions)

Each condition is a distance over the same cached vectors; we score separation as
**AUC** of matched(close) vs mismatched(far), with a **permutation test** for luck.

| # | condition | role |
|---|---|---|
| 1 | raw cosine (full vector) | brain-side floor; expected to fail |
| 2 | anatomical-mask cosine | **the main bet** |
| 3 | data-driven-mask cosine (leave-one-pair-out CV) | learns the mask from the pairs, honestly |
| 4 | CLIP cosine | off-the-shelf baseline the brain metric must beat to justify itself |

**Pass:** cond. 2 reaches **AUC ≥ ~0.75**, sits at/above raw, and at least matches
CLIP. Beating CLIP clearly is the strong win.

## The pair set (§1)

20 text↔image pairs (10 matched / 10 mismatched). v1 is **text↔image only**; the
audio→text inspiration slice (and CLAP baseline) is deferred. Critically,
**mismatched = same topic, opposite vibe** — for each topic we write one paragraph
and generate two images of that topic, one vibe-congruent (matched) and one
vibe-opposite (mismatched). That isolates *vibe* from *subject matter*. Topics span
calm, urgent, eerie, joyful, melancholy, awe, cozy, lonely, playful, nostalgic so the
only consistent signal across the set is vibe.

## How to run

Requires `DEEPSEEK_API_KEY` (text), the Flux image API, the TRIBE API, and `ffmpeg`.

```bash
uv run python scripts/01_generate_pairs.py   # author texts + render images -> data/pairs.csv
uv run python scripts/02_encode.py           # pre-flight + encode every item -> cache/encoded.npz
uv run python scripts/03_run_metrics.py      # conditions 1-4, AUC, permutation, verdict -> results/
```

Encoding is **cached and separate** from scoring (spec §2): re-run step 3 to try
new masks/metrics without re-encoding.

### Pre-flight (blocks everything)

`02_encode.py` first confirms a still image gives a stable, non-degenerate vector.
`/predict/image` is broken server-side, so a still image is fed as a degenerate
short-hold video clip (per spec). If that output is degenerate or duration-sensitive,
fix image feeding before trusting any image numbers.

### Image sizing

Images are rendered by Flux at `FLUX_WIDTH`×`FLUX_HEIGHT` (default 512×512) and the
still→clip step caps the fed video at `CLIP_WIDTH`×`CLIP_HEIGHT` (default **600×400**,
aspect-preserved with padding). Smaller clips keep TRIBE's video inference fast — it
is the slow path (minutes per image on the MPS box, vs ~17 s for text). All four are
env-overridable.

## Layout

```
src/vibe/
  config.py     paths, endpoints, mesh facts, normalization, Yeo-7 mask choice
  tribe.py      encode step: submit -> poll -> fetch preds.f16.bin, cache r vectors
  deepseek.py   paragraph generation
  flux.py       image generation
  masks.py      anatomical (Yeo-7) + data-driven (CV) vertex masks over fsaverage5
  metrics.py    normalization, cosine, AUC, permutation, CLIP baseline
scripts/
  pair_specs.py        hand-designed topic x vibe specs
  01_generate_pairs.py 02_encode.py 03_run_metrics.py
```

## TRIBE API facts (confirmed)

- `fsaverage5` mesh, **20,484 vertices**; `/predict/{text,image,audio,video}` are
  async jobs (`POST` → `job_id`, poll `GET /jobs/{id}`).
- Raw vector at `GET /jobs/{id}/preds.norm.f16.bin` = float16 `[timesteps, 20484]`,
  ~per-vertex z-scored. We mean over time → one `r ∈ R^20484` per item.
- `result.json` reports `yeo7_means` over the 7 networks — the parcellation basis
  for the mask.

## Status

- Text path confirmed end-to-end (encodes in ~17 s → `[7, 20484]`).
- Anatomical Yeo-7 mask builds from real fsaverage5 geometry (11,820 kept vertices).
- Metric / CV / verdict logic validated offline on synthetic data (all green/yellow/red
  boundaries correct).
- Image path implemented (still → 600×400 short-hold clip → `/predict/video`); video
  inference is slow and being re-verified after an endpoint glitch.
- Pending: a clean still-image-as-video confirmation, then a full `01 → 02 → 03` run
  on the real pairs.

# Felt-1

We're introducing **Felt-1**, the world's first Isoneural Converter.

The Felt-1 self-improving multi-agentic system is capable of converting between
any two formats while triggering the same fMRI neural response. From creating
captions for images that allow the viewer to experience the same feeling as
seeing the image itself, to creating a UI interface that evokes the vibes of a
song you listened to weeks ago, Felt-1 has applications across numerous
disciplines including product design, accessibility, and more.

## How it works

The trick is a shared "vibe space." Felt-1 uses Meta's **TRIBE v2** — a neural
model that predicts how the brain responds to sights, sounds, and language — as a
frozen oracle. Run any text, image, or audio through TRIBE and you get a
predicted brain-activation trajectory. Two artifacts in *different* media become
comparable in *one* space, so you can measure how alike two things *feel* even
across a change of format.

Felt-1 never trains TRIBE. It **searches** over output states to maximize how
closely a candidate's predicted activation matches the target's:

```
target (song/image/text)  ──render──►  TRIBE  ──►  target activation

   ┌──────────────── one round (repeats) ────────────────┐
   │  ranked past attempts + judge critique               │
   │        ──►  N agent candidates                        │
   │        ──render──►  TRIBE  ──►  score vs. target       │
   │        ──►  re-rank, judge critiques the new best      │
   └──────────────────────────────────────────────────────┘

           ──►  best output whose vibe matches the target
```

The search is **Ranked-Reflect** — an [OPRO](https://arxiv.org/abs/2309.03409)
"LLM as optimizer" loop with [Reflexion](https://arxiv.org/abs/2303.11366)
verbal feedback. Each round, the candidate agents see the *ranked* history of
past attempts (sorted by brain-similarity) plus a one-line critique of the
current best, and are asked to beat it. The ranked, critiqued history is the
entire steering mechanism — no hand-coded mutation operators, no genetic
algorithm. A text-novelty guard keeps the search from gaming the metric with
repetition. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Audio** is special: agents can't hear a song, so a tiered describer
([docs/AUDIO_INPUT.md](docs/AUDIO_INPUT.md)) gives them perceptual context — a
hosted Qwen2.5-Omni caption plus a local DSP pass (tempo, energy, brightness,
key) that catches the musical structure the caption misses, and that keeps audio
working when the hosted model is offline.

## Layout

Bun monorepo:

- `packages/core` — TypeScript contracts (nodes, payloads, activation traces) and
  the scoring algorithm (`src/scoring/activation.ts`).
- `packages/agent-sdk` — candidate/judge prompt templates and the Codex CLI agent
  backend.
- `services/orchestrator` — the Bun service: the search loop, TRIBE oracle
  (mock / local Python / hosted HTTP), audio describer, SQLite run index, and
  readable per-run JSON artifacts.
- `apps/web` — Next.js shell for the input/output workflow.
- `vendor/tribev2` — vendored Meta TRIBE v2 (frozen oracle; do not edit beyond
  the documented Mac-MPS patches).

## Quick start

```bash
bun install
bun run check          # biome lint + typecheck

# Fast, offline, mock oracle — proves the wiring end-to-end:
bun run smoke          # text → text
bun run smoke:audio    # audio → text
bun run smoke:image    # image → text

# Real TRIBE (downloads weights on first local run; or use the hosted oracle):
bun run setup:tribe
bun run smoke:tribe
```

Run Felt-1 on your own input — the loop is medium-agnostic, so it's the same run
with a different input node:

```bash
# Image → text, scored by real hosted TRIBE:
VOLTA_ORACLE=http VOLTA_SMOKE_IMAGE=path/to/photo.jpg bun run smoke:image

# Audio → image, real TRIBE + audio description:
VOLTA_ORACLE=http VOLTA_DESCRIBE_AUDIO=true \
  VOLTA_SMOKE_AUDIO=path/to/song.mp3 VOLTA_SMOKE_OUTPUT=image bun run smoke:audio
```

Each run writes inspectable artifacts (target, per-iteration trajectory, scores,
judge critique, score curve) under the printed run root. Config knobs are
documented in [CLAUDE.md](CLAUDE.md).

TRIBE weights stay frozen. Felt-1 owns the agentic search layer around it.

# Project Volta

Project Volta is a TRIBE-backed activation-matching workbench.

Vibe transfer across any format. Our system takes the "vibe" of one artifact and carries it into a completely different medium — the feeling of a song becomes a piece of text, the mood of an image becomes a UI, a paragraph's tone becomes a visual. Any format in, any format out, with the vibe preserved.

The inspiration: someone built a system that generates text matching the feel of a specific song. We're generalizing that idea — any-to-any vibe transfer, not just song-to-text.

How it works (at a high level): We use a neural-response model (Meta's TRIBE) as a shared "vibe space" — it predicts how the brain responds to sights, sounds, and language, which gives us one common representation across modalities. We capture the vibe of the input in that space, then run a loop of generator agents (LLMs, image, UI) that produce candidates and a scorer that keeps the ones whose vibe matches, refining over successive rounds.

That's the core: a common neural representation that lets "vibe" become portable between text, images, and UI.
Want a one-line pitch version of this too?



The active codebase is the new monorepo scaffold:

- `apps/web` - Next.js shell for the input/output module workflow.
- `packages/core` - TypeScript contracts for modules, render outputs, activation traces, scoring, and search.
- `services/orchestrator` - Bun service that coordinates runs and bridges to TRIBE through Python.
- `vendor/tribev2` - vendored Meta TRIBE v2 source used as the neural oracle.

## Commands

```bash
bun install
bun run setup:tribe
bun run check
bun run smoke
bun run smoke:tribe
```

`bun run smoke` uses the fast mock oracle. `bun run smoke:tribe` uses the
vendored TRIBE environment at `vendor/tribev2/.venv/bin/python`. The first real
TRIBE run downloads model weights into the ignored `vendor/tribev2/cache`
directory.

## Pipeline

```text
input module -> render -> TRIBE activation
seeded output module -> render -> TRIBE activation
agent loop -> score -> critique -> revise
```

TRIBE weights remain frozen. Volta owns the agentic layer around renderable
input and output modules.

# Project Volta

Project Volta is a TRIBE-backed activation-matching workbench.

Vibe transfer across any format. Our system takes the "vibe" of one artifact and carries it into a completely different medium — the feeling of a song becomes a piece of text, the mood of an image becomes a UI, a paragraph's tone becomes a visual. Any format in, any format out, with the vibe preserved.

The inspiration: someone built a system that generates text matching the feel of a specific song. We're generalizing that idea — any-to-any vibe transfer, not just song-to-text.

How it works (at a high level): We use a neural-response model (Meta's TRIBE) as a shared "vibe space" — it predicts how the brain responds to sights, sounds, and language, which gives us one common representation across modalities. We capture the vibe of the input in that space, then run a loop of generator agents that produce media payloads. A renderer turns each payload into a TRIBE-compatible artifact, the scorer ranks candidates by neural similarity, and a judge carries useful reasoning into the next iteration.

That's the core: a common neural representation that lets "vibe" become portable between text, images, and UI.
Want a one-line pitch version of this too?



The active codebase is the new monorepo scaffold:

- `apps/web` - Next.js shell for the input/output workflow.
- `packages/core` - TypeScript contracts for payloads, nodes, render outputs, activation traces, agents, judging, and scoring.
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

`bun run smoke` currently verifies the scaffold entrypoint. `bun run smoke:tribe`
will need to be rewired after the new renderer pipeline is implemented. The
vendored TRIBE environment lives at `vendor/tribev2/.venv/bin/python`; first
real TRIBE runs download model weights into the ignored `vendor/tribev2/cache`
directory.

## Pipeline

```text
InputObj.inputNode.payload -> render -> TRIBE activation
OutputObj -> agents -> AgentOutput.outputNode.payload
agent output -> render -> score -> judge -> next iteration seed
```

TRIBE weights remain frozen. Volta owns the agentic layer around renderable
media payloads.

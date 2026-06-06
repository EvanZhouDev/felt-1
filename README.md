# Project Volta

Project Volta is a TRIBE-backed activation-matching workbench.

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

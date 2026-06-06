# Project Volta Architecture

Project Volta is an agentic neural-activation translation workbench.

The system does not train TRIBE or optimize model weights. It searches over
renderable output states. TRIBE stays frozen and acts as a neural oracle.

## Core Loop

```text
input state -> input module render -> target activation

seed -> output state -> output module render -> candidate activation

agent loop:
  propose -> render -> encode -> score -> critique -> revise
```

The invariant is predicted neural activation, not literal text or pixels.
The seed constrains what the output is about.

## Boundaries

- TypeScript owns the app, modules, scoring, job state, and agent orchestration.
- Python owns the TRIBE bridge because TRIBE is a Python/PyTorch package.
- The oracle is pluggable: `mock` for fast development, `tribe` for real runs.

## MVP

Start with `TextInputModule -> TextOutputModule`.

This avoids image/video generation costs while proving the core contract:
both sides render stimuli, both are encoded by the same oracle, and the agent
layer revises output content toward neural similarity.

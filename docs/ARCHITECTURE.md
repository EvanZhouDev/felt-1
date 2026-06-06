# Project Volta Architecture

Project Volta is an agentic neural-activation translation workbench.

TRIBE stays frozen and acts as the neural oracle. Volta owns the agentic layer
around media payloads, renderers, scoring, and iteration.

See [IO Modules](./IO_MODULES.md) for the concrete payload and node schema.

## Core Loop

```text
InputObj.inputNode.payload -> render -> target activation

InputObj + OutputObj + entropy -> agent outputs
AgentOutput.outputNode.payload -> render -> candidate activation

candidate activations -> score/rank -> judge reasoning -> next iteration seed
```

The invariant is predicted neural activation, not literal text or pixels. The
optional seed constrains what the output should be about.

## Boundaries

- TypeScript owns schemas, render contracts, scoring, job state, and agent
  orchestration.
- Python owns the TRIBE bridge because TRIBE is a Python/PyTorch package.
- Nodes are thin `{ type, payload }` envelopes.
- Render functions consume payloads directly.
- Text and audio render directly to TRIBE artifacts.
- Image and code render through short visual artifacts for TRIBE.

## Current Scaffold

The repo currently defines contracts and structure only. The new renderers,
agents, judge, audio describer, and genetic loop are intentionally unimplemented
until the next pass.

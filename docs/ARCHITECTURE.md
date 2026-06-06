# Project Volta Architecture

Project Volta is an agentic neural-activation translation workbench — a
**vibe-transfer** system. It takes the "vibe" of one artifact and carries it
into a different medium: the feeling of a song becomes text, the mood of an
image becomes a UI, a paragraph's tone becomes a visual. Any format in, any
format out, with the vibe preserved.

The trick is a shared "vibe space." We use Meta's **TRIBE v2** — a model that
predicts how the brain responds to sights, sounds, and language — to map text,
audio, image, and video into one predicted-activation representation. Two
artifacts in *different* media become comparable in *one* space, so we can match
how something *feels* across a change of format.

TRIBE stays frozen and acts as the neural oracle. We never train it or touch
weights — Volta owns the agentic layer around media payloads, renderers,
scoring, and iteration. The invariant we preserve is predicted neural
activation, not literal text or pixels.

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

## The Iteration

The loop behaves like a genetic algorithm over output states, repeating until a
fixed number of iterations or a similarity threshold (~90%). Layer A agents see
only the input node and seed; later layers may also receive the previous best
output and the judge's reasoning. Each agent carries a source of entropy (a
random word, a Wikipedia page) so candidates vary.

```mermaid
flowchart TD
    subgraph InputNode["Input Node (object)"]
        Target["Target — required<br>code / image / audio / text<br>the vibe to match"]
        Seed["Seed — optional<br>directs the output"]
    end
    InputNode --> Agents
    subgraph Iteration["One iteration (repeats up to N times)"]
        Agents["Layer A agents<br>take input node (incl. seed)<br>generate output in target medium"]
        Entropy["Entropy source<br>random word / Wikipedia page"]
        Entropy -.-> Agents
        Agents --> Payload["Output payload"]
        Payload --> Render["Render function"]
        Render --> Tribe["TRIBE v2<br>brain-similarity vs. target"]
        Tribe --> Rank["Rankings + scores"]
        Rank --> Judge["Judge LLM<br>reasons why the best worked"]
    end
    Judge --> Terminate{"N iterations OR similarity >= 90%?"}
    Terminate -->|Yes| Final["Final output"]
    Terminate -->|No| NextGen{"What carries forward?"}
    NextGen -->|"Nothing — fresh"| Agents
    NextGen -->|"Best output only"| Agents
    NextGen -->|"Best output + judge reasoning"| Agents
```

The judge sees only rankings/scores plus the seed and input; its reasoning is
carried forward via `NextIterationSeed` to preserve context the next generation
would otherwise lose.

## Current Scaffold

The repo currently defines contracts and structure only. The new renderers,
agents, judge, audio describer, and genetic loop are intentionally unimplemented
until the next pass. See [IO Modules](./IO_MODULES.md#scaffold-status) for the
open implementation checklist.

# Isoneural Converter

An **isoneural converter** is a system that changes an artifact's format while
trying to preserve the neural activation it evokes. In Volta, that means the
output does not need to copy the target's words, pixels, or objects. It needs to
land close to the target in a shared predicted-activation space.

The term is intentionally narrower than "vibe transfer." Vibe transfer is the
product-level intuition: carry the feeling of one thing into another medium.
Isoneural conversion is the technical claim: optimize for a similar predicted
brain-response vector across media.

## What It Preserves

Volta preserves **TRIBE-predicted neural activation**, not measured brain data.
TRIBE v2 is frozen and acts as the oracle. We render both the input target and
each candidate output into TRIBE-compatible stimuli, ask TRIBE for activations,
then compare those vectors with the scorer.

This makes different media comparable:

```text
target artifact -> render -> TRIBE activation
candidate output -> render -> TRIBE activation
activations -> similarity score
```

The converter is successful when a candidate in the requested output medium
scores close to the target activation. A text output may therefore be a compact
activation code, a UI may preserve the same calm or tension as an image, and an
image may preserve the affective structure of a paragraph.

## What It Does Not Claim

An isoneural converter does not claim that two artifacts are literally the same,
semantically equivalent, or guaranteed to produce identical human experience.
The current implementation preserves the activation predicted by one frozen
model. That is useful because it gives us a cross-modal objective, but it is
still an optimization target, not ground truth.

It also does not train TRIBE. Volta searches over output states around a fixed
oracle. All learning happens in the search loop, prompt strategy, archive, and
candidate-selection policy.

## Volta Implementation

Project Volta implements this as an evolutionary loop over node outputs:

1. The input is wrapped as an `InputObj` with an `inputNode` and optional seed.
2. The output request declares the desired output node type: text, image, or
   code.
3. The renderer turns target and candidate nodes into TRIBE artifacts.
4. The TRIBE oracle returns activation vectors.
5. The scorer ranks candidates by neural similarity.
6. The judge selects the best candidate and writes reasoning for the next turn.
7. The next generation mutates, crosses over, preserves, or resets candidates
   based on the selected output, archive, and judge feedback.

The same node envelope is used across formats:

```text
{ type: "text" | "audio" | "image" | "code", payload: ... }
```

Text renders directly to TRIBE text input. Audio renders as audio input. Images
and code render through short visual artifacts so TRIBE can score them in the
same activation space.

## Current Status

The current system is an MVP isoneural converter. It can run candidate
generation, render, score with mock, hosted, or local TRIBE oracles, preserve run
artifacts, resume completed or failed runs, and maintain candidate archives for
evolutionary search. Recent work is pushing the loop from target-specific
caption tuning toward a generic genetic algorithm that can cold-start from many
input/output combinations.

The main open problem is convergence speed and ceiling. The goal is not just to
match the Mona Lisa benchmark, but to build a generic converter that can reach
high activation similarity from scratch in roughly 10 turns for arbitrary
targets and output formats.

# IO Modules

IO modules are media payloads that can be rendered for TRIBE. Input nodes and
output nodes use the same node envelope. The system decides whether a node is
used as the target, seed context, or an agent output by where it appears in the
pipeline.

Nodes do not ingest raw files, expand seeds, revise candidates, score
activations, or call TRIBE. They provide structured payloads that render
functions turn into TRIBE-compatible artifacts.

```
Node -> render(node.payload) -> Text | Audio | Video artifact -> TRIBE oracle
```

## Core Types

```tsx
type NodeType = "text" | "audio" | "image" | "code";

type AssetRef = {
  uri: string;
  mime?: string;
  sha256?: string;
};

type RenderTiming = {
  durationSec?: number;
  fps?: number;
  startSec?: number;
  endSec?: number;
};

type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
};
```

## Payload Types

Payloads are discriminated unions. Render functions consume payloads directly.

```tsx
type TextPayload = {
  type: "text";
  text: string;
};

type AudioPayload = {
  type: "audio";
  source: AssetRef;
  timing?: RenderTiming;
};

type ImagePayload = {
  type: "image";
  source: AssetRef;
  timing?: RenderTiming;
  fit?: "contain" | "cover";
  background?: string;
  cachedVideo?: AssetRef;
};

type CodeFramework = "html" | "react";

type CodePayload = {
  type: "code";
  files: Record<string, string>;
  entrypoint: string;
  framework: CodeFramework;
  viewport: Viewport;
  timing?: RenderTiming;
  screenshots?: AssetRef[];
  stitchedScreenshot?: AssetRef;
  cachedVideo?: AssetRef;
};

type Payload = TextPayload | AudioPayload | ImagePayload | CodePayload;
```

## Node Types

Every node has the same outer shape: `{ type, payload }`. The outer `type`
mirrors `payload.type` and gives the pipeline a cheap discriminator without
opening the payload.

```tsx
type BaseNode<TPayload extends Payload> = {
  type: TPayload["type"];
  payload: TPayload;
};

type TextNode = BaseNode<TextPayload>;
type AudioNode = BaseNode<AudioPayload>;
type ImageNode = BaseNode<ImagePayload>;
type CodeNode = BaseNode<CodePayload>;

type Node = TextNode | AudioNode | ImageNode | CodeNode;
```

Input and output nodes are aliases over the same node union. They are not
different schemas.

```tsx
type InputNode = TextNode | AudioNode | ImageNode | CodeNode;
type OutputNode = TextNode | ImageNode | CodeNode;
```

Audio is input-only for the hackathon scope because we are not generating audio
yet.

## Pipeline Objects

The input object contains the target node plus an optional seed. The target node
is what we match emotionally/sentimentally through TRIBE. The seed directs what
the output should be about.

```tsx
type SeedPayload = {
  prompt: string;
};

type InputObj = {
  inputNode: InputNode;
  seed?: SeedPayload;
};
```

The output object specifies what kind of node agents should generate.

```tsx
type OutputObj<T extends OutputNode = OutputNode> = {
  outputType: T["type"];
};
```

Each agent produces an output node.

```tsx
type AgentOutput = {
  agentId: string;
  outputNode: OutputNode;
  entropy?: string;
};
```

After rendering and scoring, the loop tracks evaluated outputs.

```tsx
type EvaluatedOutput = AgentOutput & {
  rendered: RenderedStimulus;
  activation: ActivationTrace;
  score: ScoreBundle;
};
```

The judge summarizes why the selected output worked. For the next iteration, the
system can pass nothing, pass only the selected node, or pass the selected node
plus judge reasoning.

```tsx
type JudgeDecision = {
  selectedAgentId: string;
  selectedNode: OutputNode;
  reasoning: string;
};

type NextIterationSeed =
  | { type: "fresh" }
  | { type: "selected-output"; node: OutputNode }
  | {
      type: "selected-output-with-reasoning";
      node: OutputNode;
      reasoning: string;
    };
```

## Render Boundary

TRIBE accepts text, audio, and video. Image and code payloads render through
video.

```tsx
type TribeArtifact =
  | { kind: "text"; text: string; path?: string }
  | { kind: "audio"; source: AssetRef; timing?: RenderTiming }
  | { kind: "video"; source: AssetRef; timing?: RenderTiming };

type RenderedStimulus = {
  id: string;
  kind: "text" | "audio" | "video";
  artifact: TribeArtifact;
  preview: string;
  encoderInput: EncoderStimulus;
  sha256: string;
  metadata: Record<string, unknown>;
};
```

Renderer contract:

```tsx
type Render = (payload: Payload) => Promise<RenderedStimulus>;

const render: Render = async (payload) => {
  if (payload.type === "text") {
    return renderText(payload);
  }
  if (payload.type === "audio") {
    return renderAudio(payload);
  }
  if (payload.type === "image") {
    return renderImage(payload);
  }
  return renderCode(payload);
};
```

Render paths:

```
text  -> text artifact
audio -> audio artifact
image -> still video -> video artifact
code  -> screenshot(s) -> still video -> video artifact
```

## External Input Formats

Text:

- Raw text string
- `.txt`
- Markdown converted to plain text before node creation

Audio:

- `.wav`
- `.mp3`
- `.flac`
- `.ogg`

Image:

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`

Code:

- Single HTML file
- HTML + CSS file pair
- React JSX/TSX file map

## Code Payload Notes

Code payloads keep source files and rendered screenshots. Screenshots are the
visual payload used by downstream render/scoring. Multiple screenshots can be
stitched or rendered as a short still-video sequence.

If the code fails to render, that is not hidden inside the schema. The agent
loop should repair the code and produce a new output node.

Animations are out of scope for now. For compute reasons, visual nodes render as
short still videos.

## External Systems

Raw payload loaders:

```
user/file/API input -> InputNode
```

Audio describer:

```
AudioNode -> structured audio description -> agent context
```

Initial agent generation:

```
InputObj + OutputObj + entropy -> AgentOutput[]
```

Rendering and scoring:

```
AgentOutput.outputNode.payload -> render -> TRIBE activation -> score
```

Judge:

```
ranked EvaluatedOutput[] + InputObj -> JudgeDecision
```

Next iteration:

```
InputObj + OutputObj + NextIterationSeed + entropy -> AgentOutput[]
```

### API integration notes (verified live 2026-06-06)

- **Do not batch TRIBE text scoring.** `tribe.bryanhu.com` has a
  `POST /predict/text/batch` (≤64 texts) endpoint, but its result omits the raw
  per-vertex predictions: the batch job's `preds.norm.f16.bin` is empty and there
  is no per-item binary route (all 404). `result.json` exposes only the 7
  `yeo7_means` per item. Our cosine (`scoring/activation.ts`) runs over the full
  pooled `R^20484` vector, so batching would silently collapse scoring to 7
  dimensions. The N-candidate scoring loop therefore issues N single
  `POST /predict/text` jobs. `loop.scoringConcurrency` controls how many
  candidate evaluations can be in flight at once; keep it low for hosted TRIBE
  and raise it only for deliberate throughput experiments.
- **Flux has no batch endpoint.** `images.bryanhu.com` is one prompt per request
  (`GET/POST /generate?prompt=...&model=klein&steps=4&seed=N`). When the agent
  backend generates N image candidates, vary `seed`/`prompt`; concurrency should
  be controlled separately from population size for the same reason TRIBE
  scoring is throttled.

## Hackathon Defaults

```tsx
const DEFAULT_TIMING: Required<Pick<RenderTiming, "durationSec" | "fps">> = {
  durationSec: 0.5,
  fps: 10,
};

const DEFAULT_VIEWPORT: Viewport = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
};
```

## Scaffold Status

Current scaffold:

- Core schema lives in `packages/core/src/types.ts`.
- Render contracts live in `packages/core/src/renderers`.
- Agent contracts live in `packages/core/src/agents`.
- Judge contracts live in `packages/core/src/judges`.
- Audio description contracts live in `packages/core/src/describers`.
- Pipeline iteration types live in `packages/core/src/pipeline`.
- Orchestrator run, storage, server, and smoke entrypoints are shaped around
  `InputObj` and `OutputObj`.

Open implementation work:

- Implement `render(payload)` dispatch.
- Implement text, audio, image, and code renderers.
- Implement code screenshot capture and still-video conversion.
- Implement audio description for instrumental targets.
- Implement agent generation and entropy injection.
- Implement TRIBE scoring/ranking over `AgentOutput`.
- Implement judge reasoning and next-iteration seed selection.
- Add database migration handling for existing local old-schema run tables.

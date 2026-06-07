export type NodeType = "text" | "audio" | "image" | "code";

export type AssetRef = {
  uri: string;
  mime?: string;
  sha256?: string;
};

export type RenderTiming = {
  durationSec?: number;
  fps?: number;
  startSec?: number;
  endSec?: number;
};

export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
};

export type TextPayload = {
  type: "text";
  text: string;
};

export type AudioPayload = {
  type: "audio";
  source: AssetRef;
  timing?: RenderTiming;
};

export type ImagePayload = {
  type: "image";
  source: AssetRef;
  timing?: RenderTiming;
  fit?: "contain" | "cover";
  background?: string;
  cachedVideo?: AssetRef;
};

export type CodeFramework = "html" | "react";

export type CodePayload = {
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

export type Payload = TextPayload | AudioPayload | ImagePayload | CodePayload;

export type BaseNode<TPayload extends Payload> = {
  type: TPayload["type"];
  payload: TPayload;
};

export type TextNode = BaseNode<TextPayload>;
export type AudioNode = BaseNode<AudioPayload>;
export type ImageNode = BaseNode<ImagePayload>;
export type CodeNode = BaseNode<CodePayload>;

export type Node = TextNode | AudioNode | ImageNode | CodeNode;
export type InputNode = TextNode | AudioNode | ImageNode | CodeNode;
export type OutputNode = TextNode | ImageNode | CodeNode;

export type SeedPayload = {
  prompt: string;
};

export type InputObj = {
  inputNode: InputNode;
  seed?: SeedPayload;
};

export type OutputObj<T extends OutputNode = OutputNode> = {
  outputType: T["type"];
};

export type StimulusEvent = {
  type: "Word" | "Text" | "Image" | "Audio" | "Video";
  start: number;
  duration: number;
  timeline: string;
  subject: string;
  text?: string;
  context?: string;
  sentence?: string;
  language?: string;
  modality?: "heard" | "read" | "imagined" | "typed" | "caption";
  filepath?: string;
};

export type EncoderStimulusKind = "text" | "audio" | "video";

export type EncoderStimulus = {
  kind: EncoderStimulusKind;
  events: StimulusEvent[];
  text?: string;
  artifactPath?: string;
};

export type TribeArtifact =
  | {
      kind: "text";
      text: string;
      path?: string;
    }
  | {
      kind: "audio";
      source: AssetRef;
      timing?: RenderTiming;
    }
  | {
      kind: "video";
      source: AssetRef;
      timing?: RenderTiming;
    };

export type RenderedStimulus = {
  id: string;
  kind: EncoderStimulusKind;
  artifact: TribeArtifact;
  preview: string;
  encoderInput: EncoderStimulus;
  sha256: string;
  metadata: Record<string, unknown>;
};

export type Render = (payload: Payload) => Promise<RenderedStimulus>;

export type ActivationTrace = {
  model: string;
  shape: [number, number];
  artifactPath?: string;
  values?: number[][];
  diagnostics?: {
    yeo7Means?: Record<string, number>;
    yeo7DeltaFromTarget?: Record<string, number>;
  };
  summary: {
    mean: number;
    std: number;
    norm: number;
  };
};

export type ScoreBundle = {
  neuralSimilarity: number;
  adjustedSimilarity: number;
  calibratedSimilarity?: number;
  rawAdjustedSimilarity?: number;
  contrastSimilarity?: number;
  discriminativeSimilarity?: number;
  residualSimilarity?: number;
  residualAdjustedSimilarity?: number;
  retrievalMargin?: number;
  nearMissSimilarity?: number;
  cslsSimilarity?: number;
  hubnessPenalty?: number;
  searchProgressSignal?: number;
  calibrationTargetCount?: number;
  calibrationVertexCount?: number;
  targetSpecificity?: number;
  penalty?: number;
  seedAdherence: number;
  coherence: number;
  diversity: number;
  total: number;
};

export type AgentOutput = {
  agentId: string;
  outputNode: OutputNode;
  entropy?: string;
};

export type EvaluatedOutput = AgentOutput & {
  rendered: RenderedStimulus;
  activation: ActivationTrace;
  score: ScoreBundle;
};

export type JudgeDecision = {
  selectedAgentId: string;
  selectedNode: OutputNode;
  reasoning: string;
};

export type NextIterationSeed =
  | {
      type: "fresh";
    }
  | {
      type: "selected-output";
      node: OutputNode;
    }
  | {
      type: "selected-output-with-reasoning";
      node: OutputNode;
      reasoning: string;
    };

export type NeuralOracle = {
  model?: string;
  encode(stimulus: EncoderStimulus): Promise<ActivationTrace>;
  shutdown?(): Promise<void> | void;
};

export type RunStatus =
  | "queued"
  | "loading_model"
  | "building_events"
  | "extracting_features"
  | "predicting"
  | "scoring"
  | "judging"
  | "completed"
  | "failed"
  | "cancelled";

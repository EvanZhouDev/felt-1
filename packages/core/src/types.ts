export type ModuleKind = "text" | "image" | "audio" | "video" | "mixed";

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

export type EncoderStimulus = {
  kind: ModuleKind;
  events: StimulusEvent[];
  text?: string;
  artifactPath?: string;
};

export type RenderedStimulus = {
  id: string;
  kind: ModuleKind;
  preview: string;
  encoderInput: EncoderStimulus;
  hash: string;
  metadata: Record<string, unknown>;
};

export type ActivationTrace = {
  model: string;
  shape: [number, number];
  artifactPath?: string;
  values?: number[][];
  summary: {
    mean: number;
    std: number;
    norm: number;
  };
};

export type ScoreBundle = {
  neuralSimilarity: number;
  seedAdherence: number;
  coherence: number;
  diversity: number;
  total: number;
};

export type Critique = {
  summary: string;
  directions: string[];
  scores: ScoreBundle;
};

export interface InputModule<TState, TPayload> {
  ingest(payload: TPayload): Promise<TState>;
  render(state: TState): Promise<RenderedStimulus>;
}

export interface OutputModule<TState, TSeed> {
  initialize(seed: TSeed): Promise<TState>;
  render(state: TState): Promise<RenderedStimulus>;
  revise(state: TState, critique: Critique): Promise<TState[]>;
}

export interface NeuralOracle {
  encode(stimulus: EncoderStimulus): Promise<ActivationTrace>;
  shutdown?(): Promise<void> | void;
}

export type Candidate<TState> = {
  id: string;
  state: TState;
  rendered?: RenderedStimulus;
  activation?: ActivationTrace;
  scores?: ScoreBundle;
};

export type RunStatus =
  | "queued"
  | "loading_model"
  | "building_events"
  | "extracting_features"
  | "predicting"
  | "scoring"
  | "completed"
  | "failed"
  | "cancelled";

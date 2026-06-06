import type {
  Critique,
  InputModule,
  OutputModule,
  RenderedStimulus,
  StimulusEvent,
} from "../types.ts";

export type TextInputState = {
  text: string;
  timeline: string;
  subject: string;
};

export type TextOutputState = {
  seed: string;
  text: string;
  revision: number;
};

export type TextPayload = {
  text: string;
};

export type TextSeed = {
  prompt: string;
};

export class TextInputModule
  implements InputModule<TextInputState, TextPayload>
{
  async ingest(payload: TextPayload): Promise<TextInputState> {
    const text = payload.text.trim();
    if (!text) {
      throw new Error("Text input cannot be empty.");
    }
    return {
      text,
      timeline: "input-text",
      subject: "default",
    };
  }

  async render(state: TextInputState): Promise<RenderedStimulus> {
    return renderTextStimulus({
      idPrefix: "input",
      text: state.text,
      timeline: state.timeline,
      subject: state.subject,
    });
  }
}

export class TextOutputModule
  implements OutputModule<TextOutputState, TextSeed>
{
  async initialize(seed: TextSeed): Promise<TextOutputState> {
    const prompt = seed.prompt.trim();
    if (!prompt) {
      throw new Error("Output seed cannot be empty.");
    }
    return {
      seed: prompt,
      text: `A vivid scene about ${prompt}.`,
      revision: 0,
    };
  }

  async render(state: TextOutputState): Promise<RenderedStimulus> {
    return renderTextStimulus({
      idPrefix: "output",
      text: state.text,
      timeline: "output-text",
      subject: "default",
      metadata: {
        seed: state.seed,
        revision: state.revision,
      },
    });
  }

  async revise(
    state: TextOutputState,
    critique: Critique,
  ): Promise<TextOutputState[]> {
    const direction =
      critique.directions[0] ?? "preserve the seed more clearly";
    return [
      {
        ...state,
        text: `${state.text} ${direction}.`,
        revision: state.revision + 1,
      },
    ];
  }
}

export function buildWordEvents(args: {
  text: string;
  timeline: string;
  subject: string;
}): StimulusEvent[] {
  const words = args.text.match(/\S+/g) ?? [];
  const context = args.text;
  let cursor = 0;

  return words.map((word) => {
    const duration = Math.max(0.16, Math.min(0.7, word.length * 0.07));
    const event: StimulusEvent = {
      type: "Word",
      text: word,
      context,
      sentence: context,
      language: "en",
      modality: "heard",
      start: Number(cursor.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      timeline: args.timeline,
      subject: args.subject,
    };
    cursor += duration + 0.08;
    return event;
  });
}

async function renderTextStimulus(args: {
  idPrefix: string;
  text: string;
  timeline: string;
  subject: string;
  metadata?: Record<string, unknown>;
}): Promise<RenderedStimulus> {
  const events = buildWordEvents(args);
  const hash = await hashText(`${args.timeline}:${args.text}`);

  return {
    id: `${args.idPrefix}-${hash.slice(0, 12)}`,
    kind: "text",
    preview: args.text,
    encoderInput: {
      kind: "text",
      text: args.text,
      events,
    },
    hash,
    metadata: args.metadata ?? {},
  };
}

async function hashText(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

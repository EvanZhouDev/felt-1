# Audio Input Vibe Transfer

Audio (a song, an instrumental, any clip) can be the **target vibe**, and the
system produces output in any medium (`text`, `image`, `code`) whose predicted
neural activation matches it.

The reframe that makes this cheap: **the loop is medium-agnostic.** `executeRun`
never branches on input or output type — audio is just a different input `Node`.
The only audio-specific pieces are (1) the loader that turns a file into an
`AudioNode`, and (2) the **describer** that gives the agents perceptual context,
since they cannot "hear" an audio node the way they can read a text node.

## The path

```
executeRun()  ──┬── audio loader: file/URL → AudioNode (loaders.ts)
  (unchanged)   ├── describe target: AudioNode → AudioDescription (describer.ts)
                ├── http oracle: POST /predict/audio → real TRIBE activation (oracle.ts)
                ├── candidate agents: input + AudioDescription → N output nodes
                ├── render + encode + score (all medium-agnostic) → pick best
                └── output medium is just OutputObj.outputType — a free parameter
```

Everything except the loader and describer is the exact same code the image→text
and text→text paths use.

## Two signals, two roles

Audio contributes two independent things to a run:

1. **The neural vibe (scoring).** TRIBE's `/predict/audio` endpoint ingests the
   waveform (internally audio → words via WhisperX → predicted brain activation)
   and returns the `[timesteps, 20484]` trajectory the scorer compares against.
   This is the signal that actually drives the search.

2. **The perceptual description (steering).** Agents generate the output, but
   they can't hear the audio — its node payload is just an asset URI (and the URI
   is anonymized so a filename like `clair_de_lune.wav` can't leak the title).
   The describer gives them a textual handle on what it *sounds like*.

## The tiered describer

A single audio-LLM is unreliable on *music* specifically — in testing, Qwen
called a clear C-major arpeggio a "computer beep." So the describer
(`describer.ts`) has two tiers and merges them into one `AudioDescription`:

1. **Hosted Qwen2.5-Omni** (`VOLTA_AUDIO_URL`, default `https://qwen.bryanhu.com`,
   `POST /describe`) writes a fluent perceptual **caption** — mood, texture,
   atmosphere.

2. **Local DSP** (`python/audio_features.py`: numpy + soundfile, CPU,
   sub-second) adds the objective **musical structure** the caption misses —
   tempo (BPM + slow/medium/fast), energy, brightness (dark/warm/bright), and a
   rough key from a Krumhansl-Schmuckler chroma match.

Both tiers fail soft and independently: if the hosted service is down you still
get the local features (and an offline run); if local DSP is unavailable you
still get the caption. Only when both fail is there no description, and the run
proceeds on neural similarity alone. The merged description is injected into the
candidate and judge prompts as a "what the input sounds like" block; it steers
generation but is never the scoring signal.

## Config

- `VOLTA_AUDIO_URL` — hosted describer base URL (default `https://qwen.bryanhu.com`).
- `VOLTA_DESCRIBE_AUDIO` — `true`/`false` (default `true`; set `false` to skip,
  e.g. for fast mock smokes).
- `VOLTA_PYTHON` — interpreter used for the local DSP pass (default the TRIBE
  venv, which has numpy + soundfile).

## Try it

```bash
# Audio → text, mock oracle, real describer (hosted Qwen + local DSP):
VOLTA_DESCRIBE_AUDIO=true VOLTA_SMOKE_AUDIO=path/to/song.mp3 bun run smoke:audio

# Audio → image, scored by real TRIBE:
VOLTA_ORACLE=http VOLTA_DESCRIBE_AUDIO=true \
  VOLTA_SMOKE_AUDIO=path/to/song.mp3 VOLTA_SMOKE_OUTPUT=image bun run smoke:audio
```

Supported input formats: `.wav`, `.mp3`, `.flac`, `.ogg` (local path or http(s)
URL). The fixture is `services/orchestrator/fixtures/tone.wav`.

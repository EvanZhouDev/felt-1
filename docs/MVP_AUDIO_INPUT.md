# MVP Plan: Audio Input Vibe Transfer

Goal: a single end-to-end run where **audio** (a song / instrumental) is the
target vibe and the system produces output in **any medium** (`text`, `image`,
`code`) whose predicted neural activation matches it, scored by **real TRIBE**.

The key reframe: **the loop is medium-agnostic.** `executeRun` does not branch on
input or output type. The only things that differ for audio are (1) the **Node**
(how a file becomes an `AudioNode`) and (2) the fact that agents cannot "hear" an
audio node the way they can read a text node — so we add an **audio describer**
to give them context. Everything else — render, encode, score, judge, iterate —
is the exact same code the image→text path already uses.

## TL;DR — the critical path

```
executeRun()  ──┬── audio loader: file → AudioNode (already-working render @ render.ts:35)
  (unchanged)   ├── describe target: AudioNode → AudioDescription (Qwen2.5-Omni-3B)
                ├── http oracle: POST /predict/audio → REAL VALUES (already works @ oracle.ts:107)
                ├── candidate agents: input + AudioDescription → N output nodes
                ├── render + encode + score (all exist) → pick best → store
                └── (output medium is just OutputObj.outputType — a free parameter)
```

## What already works (do not rebuild)

- **The whole loop.** `executeRun` / `executeIteration` (`run.ts`) render, encode,
  score, judge, and iterate without caring about medium. Resume works.
- **Audio render branch.** `render.ts:35` emits an `audio` artifact + an `Audio`
  stimulus event with `artifactPath = payload.source.uri`. Complete.
- **Audio encode (http oracle).** `oracle.ts:107` uploads the artifact to
  `POST /predict/audio`, polls the job, downloads `preds.norm.f16.bin`, and
  mean-pools to one `R^20484` vector. Complete and identical in shape to the text
  / video paths, so cosine is comparable across media.
- **Scoring** — `scoring/activation.ts`. Cosine over the pooled vector. Real.
- **Type contracts** — `AudioPayload` (`types.ts:27`), `AudioRenderer`
  (`renderers/audio.ts`), `AudioDescription` + `AudioDescriber`
  (`describers/audio.ts`). Defined; the describer is currently dead code.

## Gaps, in priority order

### Gap 1 — Audio loader (file → AudioNode) 🟢 small
There is no helper that turns a `.wav/.mp3/.flac/.ogg` path or URL into an
`AudioNode`. Inputs today are hardcoded JSON in `smoke.ts` or posted to
`POST /runs`. Add a tiny loader (orchestrator) that resolves a local path or
http(s) URL into an `AssetRef` and wraps it with default timing
(`DEFAULT_TIMING`: 0.5s, fps 10). No transcoding — the http oracle uploads the
file as-is. Effort: **S**.

### Gap 2 — Audio describer impl (hosted audio service) 🟡
`describers/audio.ts` defines `AudioDescriber` but nothing implements or calls it.
Implement a `HostedAudioDescriber` (orchestrator) that multipart-uploads the
audio to the hosted audio-understanding service at `audio.ai.bryanhu.com` and
parses a JSON `AudioDescription { caption, mood?, tempo?, energy?, instruments?,
structure? }`. The service ingests the waveform, so unlike the Codex backend it
describes what the audio *sounds like*, not its filename.

> Ollama does **not** support audio input, so the describer targets the dedicated
> audio service rather than an Ollama model. The service was offline at
> implementation time, so the request/response mapping is isolated in
> `requestDescription` / `parseDescription` (POST `/describe`, multipart `file`
> field → JSON) and tolerates several response shapes — adjust those two if the
> live API differs.

Config (`VOLTA_` prefix, `config.ts`):
- `VOLTA_AUDIO_URL` — default `https://audio.ai.bryanhu.com`
- `VOLTA_DESCRIBE_AUDIO` — `true`/`false` (default true; off ⇒ skip, for mock smokes)

Effort: **M**.

### Gap 3 — Wire the description into agent context 🟡
The describer output must reach the candidate prompt. The loop stays
medium-agnostic: describe the target **once** in `buildTarget()`, then attach the
`AudioDescription` to the candidate (and judge) invocations as a new optional
field — exactly like `entropy` / `previous` are already carried. The prompt
builder (`prompts.ts`) renders it as an extra context block. Backends are
untouched because both already call `buildCandidatePrompt(invocation)`.

- `agent-sdk/types.ts`: add `inputDescription?: AudioDescription` to
  `BaseAgentInvocation` (visible to candidate + judge).
- `prompts.ts`: if present, append a "What the input audio sounds like" block.
- `run.ts`: compute the description in `buildTarget`, thread it through
  `executeIteration` → invocations. Persist as `describe-target.json` is optional
  but cheap observability.

Effort: **M**.

### Gap 4 — Smoke + fixture 🟢
Add `smoke:audio` (mirror `smoke.ts`) driving the *same* `executeRun` with an
`AudioNode` target. Output type is a parameter (defaults to `text` — cheapest to
verify, renders directly, no Flux/screenshot step). Use the `http` oracle for
real activations; mock works for pure wiring. Commit a short audio fixture under
`services/orchestrator/fixtures/` or point at a hosted URL. Add the script to
root `package.json`. Effort: **S**.

## Suggested build order

1. **Gap 1** (loader) — unblocks everything, trivially testable.
2. **Gap 4 wiring** with the **mock** oracle — prove an `AudioNode` flows through
   the unchanged loop end-to-end (no Qwen, no real TRIBE yet).
3. **Gap 2** (describer) in isolation — audio in → `AudioDescription` out.
4. **Gap 3** — thread the description into the prompt; confirm both backends see it.
5. Flip smoke to **http** oracle + **describe on** for a real run.

## Open risks to watch

- **Local `tribe` oracle now supports audio (landed).** TRIBE is natively
  multimodal — audio is one of its three input streams. The vendored model
  exposes `model.get_events_dataframe(audio_path=...)`
  (`vendor/tribev2/tribev2/demo_utils.py:258`) that builds the `Audio` event and
  runs the full `get_audio_and_text_events` chain (including
  `ExtractWordsFromAudio` for vocals). `tribe_oracle_worker.py` previously only
  did `pd.DataFrame(stimulus["events"]) → predict` and never touched the file;
  it now branches on `stimulus.kind == "audio"` and calls
  `get_events_dataframe(audio_path=...)` (no vendor patch — glue only). The local
  worker rejects remote (`http(s)://`) audio URIs since it can't fetch them — use
  the hosted oracle for those.
  - The **hosted oracle** is the other working audio path:
    `VOLTA_ORACLE=http` → `tribe.bryanhu.com` `POST /predict/audio`
    (`oracle.ts:107`). The *server* runs the same chain and accepts remote URLs.
- **Qwen-Omni availability.** `ollama.bryanhu.com` may be down; the describer must
  fail soft (skip description, log) so a run still completes on neural similarity
  alone. `VOLTA_DESCRIBE_AUDIO=false` disables it outright.
- **Audio file upload size.** `/predict/audio` takes a multipart file; large
  songs may be slow. Default timing trims nothing — consider clipping long inputs
  if latency bites (not a code gap for v1).
- **No tests.** Verification is the `smoke` path only.
</content>
</invoke>

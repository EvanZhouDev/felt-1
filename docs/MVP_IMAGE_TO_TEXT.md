# MVP Plan: Image → Text Vibe Transfer

Goal: a single end-to-end run where an **image** is the target vibe and the
system produces **text** whose predicted neural activation matches it, scored by
**real TRIBE** (not mock). Plan only — no code yet.

Decisions locked: real TRIBE end-to-end; the generation agent is a vision model
(exact model TBD); loop can be simple (no genetic refinement required for v1).

## TL;DR — the critical path

```
executeRun()  ──┬── render input image  → Image event (filepath + duration)
  (the spine)   ├── Python worker: Image → moviepy video → events → predict → REAL VALUES
                ├── vision agent: image → N text candidates
                ├── render text  → Word events  (restore from git cc76498)
                └── score (exists) → pick best → store result
```

Five real gaps, ordered by risk: **(1) the empty `executeRun` loop**,
**(2) the Python video/values path**, **(3) the vision agent**, **(4) the text
renderer — nearly free**, **(5) wiring + smoke**.

## What already works (do not rebuild)

- Node/payload schema — `packages/core/src/types.ts`. Complete.
- HTTP server + SQLite storage — `services/orchestrator/src/{server,storage}.ts`.
  Real, already keyed on `InputObj`/`OutputObj`.
- Oracle plumbing — `services/orchestrator/src/oracle.ts`. The mock oracle and
  the Python IPC bridge (spawn, line-delimited JSON, timeouts, error capture)
  are real and working.
- Python worker for **pre-built text events** — `python/tribe_oracle_worker.py`.
  Loads `facebook/tribev2`, runs `model.predict(events)`.
- Scoring — `packages/core/src/scoring/activation.ts`. `scoreActivations` +
  cosine are real.
- TRIBE vendored + `bun run setup:tribe`.

## Key findings from the TRIBE source (these shape the plan)

1. **TRIBE ingests an image as a video, and it has a built-in image→video
   transform.** `CreateVideosFromImages` (`vendor/tribev2/tribev2/eventstransforms.py:215`)
   takes an `Image` event (`filepath`, `duration`), uses moviepy `ImageClip` to
   write a silent `libx264` mp4 at `fps=10`, and yields a `Video` event.
   **Consequence:** the image→video conversion belongs in **Python**, not in a
   TS ffmpeg renderer. The TS image renderer only needs to emit an `Image`
   event (filepath + duration); the worker does the rest. This deletes most of
   the perceived difficulty.

2. **The standard `get_audio_and_text_events` pipeline does NOT include
   `CreateVideosFromImages`.** It starts at `ExtractAudioFromVideo`. So for an
   image the worker must run a custom chain:
   `CreateVideosFromImages → (standard video/audio/text transforms)`.

3. **A silent still-video is safe.** `ExtractWordsFromAudio._run`
   (`eventstransforms.py:161`) logs `"No transcripts found, skipping"` and
   returns when there's no speech — it does **not** crash. So an image yields a
   **Video event with zero Word events**. Image→text vibe matching therefore
   rests on TRIBE's **visual feature stream**; the input's text stream is empty.
   That is correct for "the vibe of an image," but it is a real modeling
   constraint to be aware of.

4. **The worker currently returns only `summary` (mean/std/norm), never
   `values`.** `flattenTrace` then falls back to a 5-number vector
   `[mean, std, norm, shape0, shape1]`. **Real-TRIBE cosine similarity is
   therefore computed over 5 scalars — effectively noise.** This is a silent
   correctness blocker, not just an unimplemented feature. `model.predict`
   already returns `preds` of shape `(n_segments, n_vertices)`; the worker
   discards it. Must return a usable vector (see Gap 2).

5. **`remove_empty_segments=True` (default).** Segments with no events are
   dropped. A short single-image clip must still yield ≥1 kept segment. Verify
   the clip duration vs `data.TR`; if zero segments survive, lengthen the clip
   duration or disable the flag for v1.

## Gaps, in priority order

### Gap 1 — `executeRun()` is an empty function (the spine) 🔴 highest
`services/orchestrator/src/run.ts` is literally `async function executeRun() {}`.
Nothing renders, encodes, scores, or iterates. For v1 it does not need the
genetic loop — one pass is enough:

```
target   = oracle.encode(render(input.inputNode.payload))   // image → activation
cands    = await agent.generate({ input, output, entropy }) // N text AgentOutputs
scored   = for each cand: score(target, oracle.encode(render(cand.outputNode)))
best     = argmax(scored, s => s.score.neuralSimilarity)
store.complete(id, { best, ranked: scored })
```

Also: update `RunStatus` transitions (`store.updateStatus`) through
`loading_model → predicting → scoring → completed`, and wrap in try/catch →
`store.fail`. Effort: **M**. Depends on Gaps 2–4 existing.

### Gap 2 — Python worker: image/video → events → REAL activation values 🔴 heaviest
File: `services/orchestrator/python/tribe_oracle_worker.py`. Today it only does
`pd.DataFrame(stimulus["events"]) → predict → summary`. Needs:

- **A.** Accept a stimulus that carries an artifact (image or video) by path, not
  pre-built events. New request shape, e.g.
  `{ kind: "video"|"image", artifactPath, durationSec }`, alongside the existing
  events path (keep text-events path for the text candidates).
- **B.** For an image: build an `Image` event and run
  `CreateVideosFromImages()` then the standard video transforms (mirror
  `get_audio_and_text_events`, prepended with the image→video step). For a video
  artifact: use `model.get_events_dataframe(video_path=...)` directly.
- **C.** **Return real `values`.** `preds` is `(n_segments, n_vertices)` and
  varies in length across stimuli — cosine needs fixed-length, aligned vectors.
  Mean-pool over segments → one `n_vertices` vector, return as
  `values: [[...]]`. (Both target and candidate pooled the same way so cosine is
  comparable.) Keep `summary` too.
- **D.** First real run downloads weights + pulls WhisperX/moviepy; ensure
  `setup:tribe` covers moviepy + whisperx. Expect a slow first run.

Effort: **L**. This is the single biggest technical risk (moviepy, WhisperX,
segment-keeping, value pooling). Validate in isolation before wiring Gap 1.

### Gap 3 — Vision generation agent 🟡
File: `packages/core/src/agents/index.ts` (type only) + a new impl. A
`GenerationAgent` that takes `AgentContext { input, output, entropy }`, sends the
**input image** to a vision model, and returns `N` text `AgentOutput`s steered by
the optional `seed.prompt` and varied by `entropy`. Model choice TBD (vision-
capable). Lives in core or orchestrator; needs an API key in config. The image
bytes/URI come from `input.inputNode.payload.source` (`AssetRef`). Effort: **M**.

### Gap 4 — Text renderer (nearly free) 🟢
File: `packages/core/src/renderers/text.ts` (type only). The exact reference was
deleted in the revamp and is recoverable:
`git show cc76498:packages/core/src/modules/text.ts` — restore `buildWordEvents`
+ `renderTextStimulus` as a `TextRenderer` returning a `RenderedStimulus` with
`kind: "text"` and Word events. Note: the new `RenderedStimulus` shape requires
an `artifact` field (`{ kind: "text", text }`) and `sha256` (the old code used
`hash`). ~40 lines. Effort: **S**.

### Gap 5 — Render dispatch, image renderer, smoke, config 🟡
- `RenderPayload` dispatch over `RendererRegistry`
  (`packages/core/src/renderers/index.ts` — type only). Implement the
  `if payload.type === ...` switch.
- **Image renderer** (`renderers/image.ts`, type only): minimal — resolve the
  `AssetRef` to a local file path + `durationSec` (default 0.5 from
  `DEFAULT_TIMING`) and emit a `RenderedStimulus`/event the worker can consume as
  an `Image`. No ffmpeg here (Python/moviepy owns conversion — Finding 1).
- `smoke.ts` currently just prints a stub — make it drive one real image→text
  run end-to-end and print the best candidate + score.
- Config: add the agent's API key/model env vars to
  `services/orchestrator/src/config.ts` (follow the `VOLTA_` prefix).

Effort: **M** total.

## Suggested build order

1. **Gap 4** (text renderer) + **Gap 5 dispatch** — cheap, unblocks rendering.
2. **Gap 2** in isolation — prove image → silent mp4 → events → predict → pooled
   values returns a sane vector, via a standalone Python call before touching TS.
   This is the make-or-break step; do it early.
3. **Gap 3** (vision agent) — independently testable (image in → text out).
4. **Gap 1** (`executeRun`) — wire 2+3+4 together.
5. **Gap 5 smoke** — one real `bun run smoke:tribe`-style image→text run.

## Open risks to watch

- **Empty-segment dropout** (Finding 5): a 0.5s clip may yield zero kept
  segments at TRIBE's `TR`. Mitigation: longer `durationSec`, or
  `remove_empty_segments=False` for v1.
- **Value alignment** (Finding 2C): target and candidate vectors must be the
  same length and pooled identically, or cosine is meaningless. Text candidates
  and image targets go through different feature streams — confirm the pooled
  `n_vertices` dimension matches across both.
- **First-run cost**: WhisperX/moviepy/model downloads make the first real run
  slow; not a code gap but a demo-timing risk.
- **No tests**: verification is the `smoke` path only.
```

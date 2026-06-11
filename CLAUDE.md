# AGENTS.md

Guidance for working in **Project Volta** — a vibe-transfer workbench.

## What this is

Volta carries the "vibe" of one artifact into a different medium (song → text,
image → UI, paragraph → visual). It uses Meta's **TRIBE v2** neural-response
model as a shared "vibe space": TRIBE predicts brain activation to sights,
sounds, and language, giving one common representation across modalities. We
capture the input's vibe in that space, then loop generator agents that produce
candidates and a scorer that keeps the ones whose activation matches.

**TRIBE stays frozen.** We never train it or touch weights. The system searches
over renderable output states; TRIBE is a neural oracle. The invariant we
preserve is predicted neural activation, not literal text or pixels.

Design docs: `docs/ARCHITECTURE.md` (the loop and the vibe-transfer framing) and
`docs/IO_MODULES.md` (the concrete node/payload schema and render boundary).

## Repo layout

Bun monorepo. Workspaces: `apps/*`, `packages/*`, `services/*`.

- `packages/core` (`@volta/core`) — pure TypeScript contracts and algorithms.
  The node schema lives in `src/types.ts`; render/agent/judge/pipeline/describer
  contracts live under `src/renderers`, `src/agents`, `src/judges`,
  `src/pipeline`, `src/describers`; scoring is `src/scoring/activation.ts`.
- `services/orchestrator` (`@volta/orchestrator`) — Bun service: HTTP API,
  SQLite run index, JSON run artifacts, the oracle (mock + TRIBE), run
  execution, and the Python bridge in `python/tribe_oracle_worker.py`.
- `apps/web` (`@volta/web`) — Next.js 16 / React 19 shell for the workflow.
- `vendor/tribev2` — vendored Meta TRIBE v2 (Python/PyTorch). Patched for Mac
  MPS; see `vendor/tribev2/VENDORED.md`. **Do not edit** beyond the documented
  patches.

## Commands

```bash
bun install              # install workspace deps
bun run check            # lint (biome) + typecheck — run before committing
bun run typecheck        # tsc across all workspaces
bun run lint             # biome check .
bun run format           # biome format --write .
bun run smoke            # end-to-end run with the fast MOCK oracle (text input)
bun run smoke:audio      # end-to-end run with an AUDIO input node (mock oracle)
bun run smoke:image      # end-to-end run with an IMAGE input node (mock oracle)
bun run dev              # watch the orchestrator service
bun run dev:web          # Next.js dev (Turbopack)

# TRIBE (heavy — Python venv + model download on first run):
bun run setup:tribe      # create vendor/tribev2/.venv, install TRIBE
bun run smoke:tribe      # end-to-end run with the REAL TRIBE oracle
bun run smoke:audio:tribe # audio input via the hosted (http) TRIBE oracle + describer
bun run smoke:image:tribe # image input via the hosted (http) TRIBE oracle
```

Use `bun run smoke` (mock) for fast iteration; reach for `smoke:tribe` only when
you need real activations.

## Running on your own input

The loop is **medium-agnostic** — `executeRun` never branches on input/output
type, so "run Volta on X" is always the same run with a different input `Node`.
The `smoke:audio` / `smoke:image` scripts are the front door for that; both take
an arbitrary file or URL and a chosen output medium.

```bash
# Image → text vibe transfer, scored by REAL TRIBE (image goes to /predict/image):
VOLTA_ORACLE=http VOLTA_SMOKE_IMAGE=path/to/photo.jpg bun run smoke:image

# Audio → image, real TRIBE + audio description:
VOLTA_ORACLE=http VOLTA_DESCRIBE_AUDIO=true \
  VOLTA_SMOKE_AUDIO=path/to/song.mp3 VOLTA_SMOKE_OUTPUT=image bun run smoke:audio
```

Knobs (all optional; sensible defaults):

- `VOLTA_SMOKE_IMAGE` / `VOLTA_SMOKE_AUDIO` — input file path or http(s) URL.
  Defaults are the fixtures under `services/orchestrator/fixtures/`
  (`swatch.png`, `tone.wav`).
- `VOLTA_SMOKE_OUTPUT` — output medium: `text` (default), `image`, or `code`.
- `VOLTA_ORACLE` — `mock` (default, fast/offline) or `http` (real hosted TRIBE).
  Use `http` for a real run; mock only proves the wiring.
- `VOLTA_MAX_ITERATIONS` / `VOLTA_CANDIDATE_COUNT` — search depth/width (the
  smoke entrypoints pin these low; raise for a real search).

Each run writes readable artifacts under a temp `smokeRoot` (printed on exit):
`target.json`, per-iteration `trajectory.json` / `scores.json` / `judge.json`,
and `evolution-journal.json` (includes the per-iteration score curve). For a
long-lived service instead of a one-shot, `bun run dev` then
`POST /runs` with an `{ input: InputObj, output: OutputObj }` body.

## Conventions

- **Package manager is Bun** — never npm/yarn/pnpm. The lockfile is `bun.lock`.
- **Biome** is the formatter and linter (replaces Prettier/ESLint). Config in
  `biome.json`. Run `bun run format` / `bun run lint`.
- TypeScript is strict, ESNext modules, bundler resolution, `.ts` extensions
  allowed in imports. Shared config: `tsconfig.base.json`.
- Keep solutions minimal and focused — no unnecessary abstractions or files.
- Each workspace exposes a `typecheck` script; `bun run typecheck` fans out over
  all of them with `bun --filter '*'`.

## The node model (how data flows)

Input and output are the same `{ type, payload }` **node** envelope
(`NodeType = "text" | "audio" | "image" | "code"`). Position in the pipeline —
not the shape — decides whether a node is the target, the seed, or an agent
output. Renderers are keyed by node type and turn payloads into TRIBE artifacts:

```text
text  -> text artifact
audio -> audio artifact          (audio is input-only — we don't generate it)
image -> still video -> video
code  -> screenshot(s) -> still video -> video
```

An `InputObj` holds the required target node plus an optional `seed` (prompt to
steer toward); `OutputObj` declares the output medium. Agents emit `AgentOutput`,
which becomes `EvaluatedOutput` after render + score; the judge produces a
`JudgeDecision` and a `NextIterationSeed` for the next round. Full schema in
`docs/IO_MODULES.md`.

## Config (env vars, `VOLTA_` prefix)

Set in `services/orchestrator/src/config.ts`:

- `VOLTA_ORACLE` — `mock` (default), `tribe` (local Python worker), or `http`
  (hosted TRIBE at `VOLTA_TRIBE_URL`; no Python venv needed, returns real
  20484-dim values).
- `VOLTA_TRIBE_URL` — hosted TRIBE base URL (default `https://tribe.bryanhu.com`).
- `VOLTA_IMAGE_DURATION_S` / `VOLTA_IMAGE_FPS` — still-image hold passed to
  `/predict/image?duration=&fps=` (defaults `10` / `10`). The server default of
  2s yields only 2 timesteps and under-samples; 10s separates image targets far
  better (cross-painting collinearity 0.855 → 0.674).
- `VOLTA_FLUX_URL` — hosted Flux image API (default `https://images.bryanhu.com`).
- `VOLTA_AUDIO_URL` — hosted Qwen2.5-Omni audio-description service for the audio
  describer (default `https://audio.bryanhu.com`). Multipart `POST /describe`;
  failure is non-fatal — the local DSP pass (`python/audio_features.py`,
  tempo/energy/brightness/key) still runs, and if both fail the run proceeds on
  neural similarity alone.
- `VOLTA_DESCRIBE_AUDIO` — describe audio targets so agents get perceptual
  context they can't hear (default `true`; set `false` to skip, e.g. mock smokes).
- `VOLTA_CANDIDATE_COUNT` — N candidates generated per iteration (default `2`).
- `VOLTA_SCORING_CONCURRENCY` — max simultaneous candidate scoring calls
  (default `1`; keep low for hosted TRIBE).
- `VOLTA_MAX_ITERATIONS` — M search iterations of the Ranked-Reflect loop; each
  round shows candidates the ranked score trajectory + judge critique and keeps
  the best-so-far (default `1`).
- `VOLTA_CANDIDATE_MODEL` / `VOLTA_JUDGE_MODEL` — model ids passed to the agent
  backend's `AgentSpec` (unused by the deterministic backend; for the future
  Codex/LLM backend).
- `VOLTA_PORT` — HTTP port (default `8787`).
- `VOLTA_DATABASE_PATH` — SQLite path (default `data/volta.sqlite`).
- `VOLTA_RUNS_ROOT` — JSON artifacts + per-agent workspaces (default `.volta/runs`).
- `VOLTA_PYTHON` — Python interpreter (default `vendor/tribev2/.venv/bin/python`).
- `VOLTA_ORACLE_TIMEOUT_MS` — TRIBE request timeout (default 600000; also the
  job-poll deadline for the `http` oracle).
- `VOLTA_AGENT_BACKEND` — agent backend(s): a comma-separated priority list of
  `codex` (default), `claude`, `deepseek`. Later entries take over when the
  primary throws a usage/rate-cap error (e.g. `codex,claude,deepseek`).
- `VOLTA_CODEX_COMMAND` — Codex CLI command (default `codex`).
- `VOLTA_CODEX_MODEL` / `VOLTA_CODEX_PROFILE` — optional Codex overrides.
- `VOLTA_CODEX_TIMEOUT_MS` — Codex agent timeout (default 900000).
- `VOLTA_CLAUDE_COMMAND` / `VOLTA_CLAUDE_MODEL` / `VOLTA_CLAUDE_TIMEOUT_MS` —
  Claude Code CLI backend (default command `claude`, model `sonnet`, 600000ms).
- `VOLTA_DEEPSEEK_MODEL` / `VOLTA_DEEPSEEK_URL` / `VOLTA_DEEPSEEK_TIMEOUT_MS` —
  DeepSeek HTTP backend (needs `DEEPSEEK_API_KEY`; default `deepseek-chat`,
  `https://api.deepseek.com`, 300000ms).
- `VOLTA_VIBE_WEIGHT` — `0`..`1` (default `0`). 0 = perception-faithful
  scoring; >0 suppresses primary sensory cortex (Visual+Somatomotor) and scores
  the affective/association networks. Tested and found to give no benefit (see
  the Yeo-7 ablation) — kept as a documented dead-end knob.
- `VOLTA_ANCHORS_PATH` — override the modality-anchor file (default
  `services/orchestrator/anchors/anchors.json`; absent = legacy raw scoring).
- `VOLTA_SIMILARITY_THRESHOLD` — default neural similarity stop threshold (default 0.9).
- `VOLTA_WEAVE_ENABLED` / `VOLTA_WEAVE_PROJECT` — enable Weave Evolution Journal tracing.
- `VOLTA_WEAVE_CAPTURE_PAYLOADS` — include rawer payload details in Weave traces (default false).

## State of the code (read before extending)

The node-schema migration has **landed** — `packages/core/src/types.ts` is the
node model (`Node`, `InputObj`, `OutputObj`, `AgentOutput`, `JudgeDecision`,
`NextIterationSeed`), and the old `InputModule`/`OutputModule` + `beam.ts` code
is gone.

What's **MVP only** right now:

- Renderers (`render(payload)` dispatch, text/audio/image/code) and code
  screenshot + still-video capture are still mostly type signatures.
- `packages/agent-sdk` has shared Candidate/Judge contracts, workspace creation,
  the OPRO/Reflexion prompt templates, and a Codex CLI backend.
- The orchestrator runs the **Ranked-Reflect** search loop (`run.ts` +
  `trajectory.ts`): each round shows candidate agents the ranked score
  trajectory plus the judge's critique and asks for better outputs. It writes a
  SQLite index row plus readable JSON artifacts under `.volta/runs/<runId>/`,
  including per-iteration artifacts and `evolution-journal.json`.
- Completed runs can be resumed with `POST /runs/:id/resume`; the resume request
  appends new iteration folders using the saved target activation and latest
  `NextIterationSeed`. On resume, `loop.maxIterations` means additional
  iterations.
- TRIBE scoring/ranking works through the oracle abstraction, the tiered audio
  describer (hosted Qwen + local DSP) is wired, and Weave tracing can observe
  the loop. Real renderers and Flux image tools are still open implementation
  work.

See the open-implementation checklist in `docs/IO_MODULES.md` (Scaffold Status).

**No test framework.** Verification is via the `smoke` scripts. Don't claim a
change is tested unless you ran a smoke script and report its output.

## Working agreements

- Run `bun run check` before committing; both lint and typecheck must pass.
- This is a shared repo — pull/rebase before pushing; don't force-push `main`.
- Don't edit `vendor/tribev2/` except per `VENDORED.md`.

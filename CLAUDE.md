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
bun run dev              # watch the orchestrator service
bun run dev:web          # Next.js dev (Turbopack)

# TRIBE (heavy — Python venv + model download on first run):
bun run setup:tribe      # create vendor/tribev2/.venv, install TRIBE
bun run smoke:tribe      # end-to-end run with the REAL TRIBE oracle
bun run smoke:audio:tribe # audio input via the hosted (http) TRIBE oracle + describer
```

`smoke:audio` proves the loop is medium-agnostic: it drives the same
`executeRun` with an `AudioNode` target (fixture `services/orchestrator/fixtures/
tone.wav`). Output medium is a free parameter — `VOLTA_SMOKE_OUTPUT=image` (or
`code`/`text`) and `VOLTA_SMOKE_AUDIO=<path|url>` override it. Audio needs the
`http` oracle (or the patched local `tribe` worker) for real activations.

Use `bun run smoke` (mock) for fast iteration; reach for `smoke:tribe` only when
you need real activations.

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
- `VOLTA_FLUX_URL` — hosted Flux image API (default `https://images.bryanhu.com`).
- `VOLTA_AUDIO_URL` — hosted audio-description service for the audio describer
  (default `https://audio.ai.bryanhu.com`). Multipart `POST /describe`; failure
  is non-fatal (run proceeds on neural similarity alone).
- `VOLTA_DESCRIBE_AUDIO` — describe audio targets so agents get perceptual
  context they can't hear (default `true`; set `false` to skip, e.g. mock smokes).
- `VOLTA_CANDIDATE_COUNT` — N candidates per iteration (default `2`).
- `VOLTA_SCORING_CONCURRENCY` — max simultaneous candidate scoring calls
  (default `1`; keep low for hosted TRIBE).
- `VOLTA_REUSE_TARGET_ARCHIVE` — include prior candidates for the same target in
  new runs (default `false`; enable only for explicit warm-start experiments).
- `VOLTA_MAX_ITERATIONS` — M search iterations; loop feeds the judge's
  `NextIterationSeed` forward and keeps the best-scoring iteration (default `1`).
- `VOLTA_CANDIDATE_MODEL` / `VOLTA_JUDGE_MODEL` — model ids passed to the agent
  backend's `AgentSpec` (unused by the deterministic backend; for the future
  Codex/LLM backend).
- `VOLTA_PORT` — HTTP port (default `8787`).
- `VOLTA_DATABASE_PATH` — SQLite path (default `data/volta.sqlite`).
- `VOLTA_RUNS_ROOT` — JSON artifacts + per-agent workspaces (default `.volta/runs`).
- `VOLTA_PYTHON` — Python interpreter (default `vendor/tribev2/.venv/bin/python`).
- `VOLTA_ORACLE_TIMEOUT_MS` — TRIBE request timeout (default 600000; also the
  job-poll deadline for the `http` oracle).
- `VOLTA_AGENT_BACKEND` — `codex` (default) or `deterministic`.
- `VOLTA_CODEX_COMMAND` — Codex CLI command (default `codex`).
- `VOLTA_CODEX_MODEL` / `VOLTA_CODEX_PROFILE` — optional Codex overrides.
- `VOLTA_CODEX_TIMEOUT_MS` — Codex agent timeout (default 900000).
- `VOLTA_SIMILARITY_THRESHOLD` — default neural similarity stop threshold (default 0.9).
- `VOLTA_WEAVE_ENABLED` / `VOLTA_WEAVE_PROJECT` — enable Weave Evolution Journal tracing.
- `VOLTA_WEAVE_CAPTURE_PAYLOADS` — include rawer payload details in Weave traces (default false).

## State of the code (read before extending)

The node-schema migration has **landed** — `packages/core/src/types.ts` is the
node model (`Node`, `InputObj`, `OutputObj`, `AgentOutput`, `JudgeDecision`,
`NextIterationSeed`), and the old `InputModule`/`OutputModule` + `beam.ts` code
is gone.

What's **MVP only** right now:

- Renderers (`render(payload)` dispatch, text/audio/image/code), code screenshot
  + still-video capture, and audio description are still mostly type signatures.
- `packages/agent-sdk` has shared Candidate/Judge contracts, workspace creation,
  prompt templates, a deterministic backend, and a Codex CLI backend.
- The orchestrator runs a configurable multi-iteration candidate-score-judge
  loop. It writes a SQLite index row plus readable JSON artifacts under
  `.volta/runs/<runId>/`, including per-iteration artifacts and
  `evolution-journal.json`.
- Completed runs can be resumed with `POST /runs/:id/resume`; the resume request
  appends new iteration folders using the saved target activation and latest
  `NextIterationSeed`. On resume, `loop.maxIterations` means additional
  iterations.
- TRIBE scoring/ranking works through the oracle abstraction, and Weave tracing
  can observe the loop. Real renderers, Flux tools, and audio description tools
  are still open implementation work.

See the open-implementation checklist in `docs/IO_MODULES.md` (Scaffold Status).

**No test framework.** Verification is via the `smoke` scripts. Don't claim a
change is tested unless you ran a smoke script and report its output.

## Working agreements

- Run `bun run check` before committing; both lint and typecheck must pass.
- This is a shared repo — pull/rebase before pushing; don't force-push `main`.
- Don't edit `vendor/tribev2/` except per `VENDORED.md`.

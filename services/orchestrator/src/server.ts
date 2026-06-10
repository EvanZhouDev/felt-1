import { join } from "node:path";
import { type AgentBackend, CodexCliBackend } from "@volta/agent-sdk";
import type { InputObj, OutputObj } from "@volta/core";
import {
  type AgentBackendConfig,
  type LoopConfig,
  loadConfig,
  normalizeLoopConfig,
} from "./config.ts";
import { createAudioDescriber } from "./describer.ts";
import { createEvolutionJournal } from "./observability.ts";
import { createOracle } from "./oracle.ts";
import { executeRun, resumeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

const config = loadConfig();
const store = new RunStore(config.databasePath);
const oracle = createOracle(config);
const journal = createEvolutionJournal(config.weave);
const backend = createAgentBackend(config.agentBackend);
const describeAudio = createAudioDescriber(config);

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        oracleMode: config.oracleMode,
        tribeUrl: config.tribeUrl,
        agentBackend: config.agentBackend.mode,
        loop: config.loop,
        weave: {
          enabled: journal.enabled,
          dashboardUrl: journal.dashboardUrl,
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      return json({
        runs: store.list(),
      });
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      const body = (await request.json()) as {
        input?: InputObj;
        output?: OutputObj;
        loop?: Partial<LoopConfig>;
      };
      if (!body.input || !body.output) {
        return json({ error: "input and output are required." }, 400);
      }

      const id = crypto.randomUUID();
      const loop = normalizeLoopConfig({
        ...config.loop,
        ...body.loop,
      });
      const record = store.create({
        id,
        input: body.input,
        output: body.output,
        runPath: join(config.runsRoot, id),
      });

      void executeRun({
        id,
        input: body.input,
        output: body.output,
        store,
        oracle,
        runsRoot: config.runsRoot,
        backend,
        loop,
        journal,
        candidateModel: config.candidateModel,
        judgeModel: config.judgeModel,
        describeAudio,
      }).catch((error) => {
        console.error(`Run ${id} failed:`, error);
      });

      return json({
        run: record,
      });
    }

    const resumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      const id = resumeMatch[1] as string;
      const existing = store.get(id);
      if (!existing) {
        return json({ error: "Run not found." }, 404);
      }
      if (!["completed", "failed"].includes(existing.status)) {
        return json(
          {
            error: `Run must be completed or failed before resume: ${existing.status}.`,
          },
          409,
        );
      }

      const body = (await request.json().catch(() => ({}))) as {
        loop?: Partial<LoopConfig>;
      };
      const loop = normalizeLoopConfig({
        ...config.loop,
        maxIterations: 1,
        ...body.loop,
      });
      store.updateStatus(id, "queued");

      void resumeRun({
        id,
        store,
        oracle,
        runsRoot: config.runsRoot,
        backend,
        loop,
        journal,
        candidateModel: config.candidateModel,
        judgeModel: config.judgeModel,
        describeAudio,
      }).catch((error) => {
        console.error(`Run ${id} resume failed:`, error);
      });

      return json({
        run: store.get(id),
      });
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const run = store.get(runMatch[1] as string);
      if (!run) {
        return json({ error: "Run not found." }, 404);
      }
      return json({
        run,
        artifact: store.getArtifact(run.id),
      });
    }

    return json({ error: "Not found." }, 404);
  },
});

console.log(
  `Volta orchestrator listening on http://localhost:${server.port} (${config.oracleMode} oracle)`,
);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createAgentBackend(config: AgentBackendConfig): AgentBackend {
  return new CodexCliBackend({
    command: config.command,
    model: config.model,
    profile: config.profile,
    timeoutMs: config.timeoutMs,
  });
}

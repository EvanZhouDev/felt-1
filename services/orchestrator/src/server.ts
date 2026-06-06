import type { InputObj, OutputObj } from "@volta/core";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";
import { executeRun } from "./run.ts";
import { RunStore } from "./storage.ts";

const config = loadConfig();
const store = new RunStore(config.databasePath);
const oracle = createOracle(config);

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        oracleMode: config.oracleMode,
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
      };
      if (!body.input || !body.output) {
        return json({ error: "input and output are required." }, 400);
      }

      const id = crypto.randomUUID();
      const record = store.create({
        id,
        input: body.input,
        output: body.output,
      });

      void executeRun({
        id,
        input: body.input,
        output: body.output,
        store,
        oracle,
      });

      return json({
        run: record,
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
        result: run.resultJson ? JSON.parse(run.resultJson) : null,
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

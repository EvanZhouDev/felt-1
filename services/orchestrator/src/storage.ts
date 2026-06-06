import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputObj, OutputObj, RunStatus } from "@volta/core";

export type RunRecord = {
  id: string;
  status: RunStatus;
  inputNodeType: string;
  outputType: string;
  runPath: string;
  selectedAgentId: string | null;
  bestScore: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunArtifact = {
  id: string;
  status: RunStatus;
  input: InputObj;
  output: OutputObj;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RunStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    const directory = dirname(databasePath);
    if (directory !== ".") {
      mkdirSync(directory, { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.exec(`
      create table if not exists runs (
        id text primary key,
        status text not null,
        input_node_type text not null,
        output_type text not null,
        run_path text not null,
        selected_agent_id text,
        best_score real,
        error text,
        created_at text not null,
        updated_at text not null
      );
    `);
    this.ensureColumns();
  }

  create(args: {
    id: string;
    input: InputObj;
    output: OutputObj;
    runPath: string;
  }): RunRecord {
    const now = new Date().toISOString();
    mkdirSync(args.runPath, { recursive: true });
    writeJson(join(args.runPath, "input.json"), args.input);
    writeJson(join(args.runPath, "output-request.json"), args.output);
    writeRunArtifact(args.runPath, {
      id: args.id,
      status: "queued",
      input: args.input,
      output: args.output,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    this.db
      .query(
        `insert into runs
          (id, status, input_node_type, output_type, run_path, selected_agent_id, best_score, error, created_at, updated_at)
          values (?, ?, ?, ?, ?, null, null, null, ?, ?)`,
      )
      .run(
        args.id,
        "queued",
        args.input.inputNode.type,
        args.output.outputType,
        args.runPath,
        now,
        now,
      );
    return this.get(args.id) as RunRecord;
  }

  get(id: string): RunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(
        `select id, status, input_node_type, output_type, run_path, selected_agent_id, best_score, error, created_at, updated_at
         from runs where id = ?`,
      )
      .get(id);
    return row ? mapRow(row) : null;
  }

  list(): RunRecord[] {
    return this.db
      .query<RunRow, []>(
        `select id, status, input_node_type, output_type, run_path, selected_agent_id, best_score, error, created_at, updated_at
         from runs order by created_at desc limit 50`,
      )
      .all()
      .map(mapRow);
  }

  getArtifact(id: string): RunArtifact | null {
    const record = this.get(id);
    if (!record?.runPath) {
      return null;
    }
    return readRunArtifact(record.runPath);
  }

  updateStatus(id: string, status: RunStatus): void {
    const updatedAt = new Date().toISOString();
    this.db
      .query("update runs set status = ?, updated_at = ? where id = ?")
      .run(status, updatedAt, id);
    this.patchArtifact(id, {
      status,
      updatedAt,
    });
  }

  complete(
    id: string,
    result: unknown,
    summary?: {
      selectedAgentId?: string;
      bestScore?: number;
    },
  ): void {
    const updatedAt = new Date().toISOString();
    this.db
      .query(
        `update runs
         set status = ?, selected_agent_id = ?, best_score = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        "completed",
        summary?.selectedAgentId ?? null,
        summary?.bestScore ?? null,
        updatedAt,
        id,
      );
    this.patchArtifact(id, {
      status: "completed",
      result,
      error: null,
      updatedAt,
    });
  }

  fail(id: string, error: unknown): void {
    const errorText = String(error);
    const updatedAt = new Date().toISOString();
    this.db
      .query(
        "update runs set status = ?, error = ?, updated_at = ? where id = ?",
      )
      .run("failed", errorText, updatedAt, id);
    this.patchArtifact(id, {
      status: "failed",
      error: errorText,
      updatedAt,
    });
  }

  private ensureColumns(): void {
    const migrations = [
      "alter table runs add column input_node_type text",
      "alter table runs add column output_type text",
      "alter table runs add column run_path text",
      "alter table runs add column selected_agent_id text",
      "alter table runs add column best_score real",
    ];

    for (const migration of migrations) {
      try {
        this.db.exec(migration);
      } catch {
        // Column already exists. This keeps old local dev DBs usable.
      }
    }
  }

  private patchArtifact(id: string, patch: Partial<RunArtifact>): void {
    const record = this.get(id);
    if (!record?.runPath) {
      return;
    }
    const artifact = readRunArtifact(record.runPath);
    if (!artifact) {
      return;
    }
    writeRunArtifact(record.runPath, {
      ...artifact,
      ...patch,
    });
  }
}

type RunRow = {
  id: string;
  status: RunStatus;
  input_node_type: string | null;
  output_type: string | null;
  run_path: string | null;
  selected_agent_id: string | null;
  best_score: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    inputNodeType: row.input_node_type ?? "unknown",
    outputType: row.output_type ?? "unknown",
    runPath: row.run_path ?? "",
    selectedAgentId: row.selected_agent_id,
    bestScore: row.best_score,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readRunArtifact(runPath: string): RunArtifact | null {
  const artifactPath = join(runPath, "run.json");
  if (!existsSync(artifactPath)) {
    return null;
  }
  return JSON.parse(readFileSync(artifactPath, "utf8")) as RunArtifact;
}

function writeRunArtifact(runPath: string, artifact: RunArtifact): void {
  writeJson(join(runPath, "run.json"), artifact);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import type { InputObj, OutputObj, RunStatus } from "@volta/core";

export type RunRecord = {
  id: string;
  status: RunStatus;
  input: InputObj;
  output: OutputObj;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RunStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    const directory = dirname(databasePath);
    if (directory !== ".") {
      Bun.spawnSync(["mkdir", "-p", directory]);
    }
    this.db = new Database(databasePath);
    this.db.exec(`
      create table if not exists runs (
        id text primary key,
        status text not null,
        input_json text not null,
        output_json text not null,
        result_json text,
        error text,
        created_at text not null,
        updated_at text not null
      );
    `);
  }

  create(args: { id: string; input: InputObj; output: OutputObj }): RunRecord {
    const now = new Date().toISOString();
    this.db
      .query(
        `insert into runs
          (id, status, input_json, output_json, result_json, error, created_at, updated_at)
          values (?, ?, ?, ?, null, null, ?, ?)`,
      )
      .run(
        args.id,
        "queued",
        JSON.stringify(args.input),
        JSON.stringify(args.output),
        now,
        now,
      );
    return this.get(args.id) as RunRecord;
  }

  get(id: string): RunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(
        `select id, status, input_json, output_json, result_json, error, created_at, updated_at
         from runs where id = ?`,
      )
      .get(id);
    return row ? mapRow(row) : null;
  }

  list(): RunRecord[] {
    return this.db
      .query<RunRow, []>(
        `select id, status, input_json, output_json, result_json, error, created_at, updated_at
         from runs order by created_at desc limit 50`,
      )
      .all()
      .map(mapRow);
  }

  updateStatus(id: string, status: RunStatus): void {
    this.db
      .query("update runs set status = ?, updated_at = ? where id = ?")
      .run(status, new Date().toISOString(), id);
  }

  complete(id: string, result: unknown): void {
    this.db
      .query(
        "update runs set status = ?, result_json = ?, updated_at = ? where id = ?",
      )
      .run("completed", JSON.stringify(result), new Date().toISOString(), id);
  }

  fail(id: string, error: unknown): void {
    this.db
      .query(
        "update runs set status = ?, error = ?, updated_at = ? where id = ?",
      )
      .run("failed", String(error), new Date().toISOString(), id);
  }
}

type RunRow = {
  id: string;
  status: RunStatus;
  input_json: string;
  output_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    input: JSON.parse(row.input_json) as InputObj,
    output: JSON.parse(row.output_json) as OutputObj,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

import type { InputObj, NeuralOracle, OutputObj } from "@volta/core";
import type { RunStore } from "./storage.ts";

export type ExecuteRunArgs = {
  id: string;
  input: InputObj;
  output: OutputObj;
  store: RunStore;
  oracle: NeuralOracle;
};

export async function executeRun(_args: ExecuteRunArgs): Promise<void> {}

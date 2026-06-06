import {
  type NeuralOracle,
  runBeamSearch,
  TextInputModule,
  TextOutputModule,
} from "@volta/core";
import type { RunStore } from "./storage.ts";

export async function executeRun(args: {
  id: string;
  inputText: string;
  seed: string;
  store: RunStore;
  oracle: NeuralOracle;
}): Promise<void> {
  try {
    args.store.updateStatus(args.id, "building_events");
    const candidates = await runBeamSearch({
      inputModule: new TextInputModule(),
      outputModule: new TextOutputModule(),
      oracle: args.oracle,
      input: {
        text: args.inputText,
      },
      seed: {
        prompt: args.seed,
      },
      options: {
        iterations: 1,
        beamWidth: 1,
      },
    });
    args.store.complete(args.id, {
      best: candidates[0],
    });
  } catch (error) {
    args.store.fail(args.id, error);
  }
}

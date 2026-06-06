import { runBeamSearch, TextInputModule, TextOutputModule } from "@volta/core";
import { loadConfig } from "./config.ts";
import { createOracle } from "./oracle.ts";

const oracle = createOracle(loadConfig());

try {
  const candidates = await runBeamSearch({
    inputModule: new TextInputModule(),
    outputModule: new TextOutputModule(),
    oracle,
    input: {
      text: "the quiet river reflects the morning sky",
    },
    seed: {
      prompt: "a crowded night market",
    },
    options: {
      iterations: 1,
      beamWidth: 1,
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        best: candidates[0],
      },
      null,
      2,
    ),
  );
} finally {
  await oracle.shutdown?.();
}

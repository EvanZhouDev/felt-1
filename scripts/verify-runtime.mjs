import { execFileSync } from "node:child_process";

const runtime = process.argv[2];
if (runtime === "bun") {
  const expected = "1.4.4-canary.1+963452075";
  if (!process.versions.bun) throw new Error("Run this check with Bun.");
  const revision = execFileSync(process.execPath, ["--revision"], {
    encoding: "utf8",
  }).trim();
  if (revision !== expected) {
    throw new Error(
      `Use verified Bun ${expected}: run node scripts/install-secure-bun.mjs .runtime and put .runtime on PATH.`,
    );
  }
} else if (runtime === "node") {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const patched =
    !process.versions.bun &&
    ((major === 22 && (minor > 23 || (minor === 23 && patch >= 4))) ||
      (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
      major > 26 ||
      (major === 26 && (minor > 12 || (minor === 12 && patch >= 1))));
  if (!patched)
    throw new Error("Use patched Node ^22.23.4 || ^24.22.1 || >=26.12.1.");
} else {
  throw new Error("Specify the runtime to verify: bun or node.");
}

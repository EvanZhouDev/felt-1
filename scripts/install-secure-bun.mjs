import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Emergency upstream build containing the eMudhra CA fix. Stable Bun is unpatched.
const revision = "1.4.4-canary.1+963452075";
const archives = {
  "darwin-arm64": [
    "bun-darwin-aarch64",
    "179654d25e6494c5f7900d2c2caf6185a857ee5e4c9706a14b959e2c36a8e997",
  ],
  "linux-arm64": [
    "bun-linux-aarch64",
    "7341c3b1572c4c1c7f372360b5a17313180cac11dd670e0a2f6a3aec1ce40d05",
  ],
  "linux-x64": [
    "bun-linux-x64",
    "aacef5036f5551631006d20deb11338452064dc32ab25f8ceba8f378d7faf45b",
  ],
};
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const patched =
  (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))) ||
  (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
  major > 26 ||
  (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
if (!patched)
  throw new Error(
    "Use patched Node 22.23.4, 24.22.1, or 26.12.1 to bootstrap Bun.",
  );
const entry = archives[`${process.platform}-${process.arch}`];
if (!entry)
  throw new Error(
    `No verified Bun archive for ${process.platform}/${process.arch}`,
  );
const [name, expected] = entry;
const downloadOnly = process.argv[2] === "--download-only";
const destination = downloadOnly
  ? process.argv[3]
  : process.argv[2] || join(tmpdir(), "volta-secure-bun");
const archive = downloadOnly ? destination : join(destination, `${name}.zip`);
const response = await fetch(
  `https://github.com/oven-sh/bun/releases/download/canary/${name}.zip`,
);
if (!response.ok)
  throw new Error(`Bun archive download failed: HTTP ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(data).digest("hex");
if (actual !== expected)
  throw new Error(
    `Bun archive SHA256 mismatch: ${actual}. Review the next patched release before changing the pin.`,
  );
await mkdir(dirname(archive), { recursive: true });
await writeFile(archive, data);
if (!downloadOnly) {
  const executable = join(
    destination,
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  const python = process.platform === "win32" ? "python" : "python3";
  execFileSync(
    python,
    [
      fileURLToPath(new URL("extract-secure-bun.py", import.meta.url)),
      archive,
      executable,
      `${name}/${process.platform === "win32" ? "bun.exe" : "bun"}`,
      expected,
    ],
    { stdio: "inherit" },
  );
  await chmod(executable, 0o755);
  const actualRevision = execFileSync(executable, ["--revision"], {
    encoding: "utf8",
  }).trim();
  if (actualRevision !== revision)
    throw new Error(`Unexpected Bun revision: ${actualRevision}`);
  if (process.env.GITHUB_PATH)
    await writeFile(process.env.GITHUB_PATH, `${destination}\n`, { flag: "a" });
  console.log(`Verified Bun ${revision} installed at ${executable}`);
}

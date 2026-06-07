import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return Response.json({ error: "Missing path." }, { status: 400 });
  }

  const localPath = normalizeLocalPath(rawPath);
  if (!localPath) {
    return Response.json({ error: "Unsupported media path." }, { status: 400 });
  }

  const resolvedPath = resolve(localPath);
  if (!allowedMediaPath(resolvedPath)) {
    return Response.json(
      { error: "Media path is outside the trace allowlist." },
      { status: 403 },
    );
  }
  if (!existsSync(resolvedPath)) {
    return Response.json({ error: "Media file not found." }, { status: 404 });
  }

  const mime = MIME_TYPES.get(extname(resolvedPath).toLowerCase());
  if (!mime) {
    return Response.json({ error: "Unsupported media type." }, { status: 415 });
  }

  const bytes = await readFile(resolvedPath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mime,
      "cache-control": "no-store",
    },
  });
}

function normalizeLocalPath(path: string): string | undefined {
  if (path.startsWith("file://")) {
    return decodeURIComponent(new URL(path).pathname);
  }
  return path.startsWith("/") ? path : undefined;
}

function allowedMediaPath(path: string): boolean {
  return allowedRoots().some((root) => insideRoot(path, root));
}

function allowedRoots(): string[] {
  const root = repoRoot();
  return [
    join(root, ".volta"),
    join(root, ".agent"),
    resolve(root, "..", "project-volta"),
  ];
}

function insideRoot(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith("..") && !result.startsWith("/"));
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/apps/web") ? resolve(cwd, "../..") : cwd;
}

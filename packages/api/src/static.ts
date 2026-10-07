import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENT = 255;

/** The URL path as safe path segments below the web root, or `undefined` when anything about it is not plain: percent
 *  escapes that do not decode, a decoded segment that is `..`, hidden (a leading dot), carries a separator, a NUL or a
 *  control character, a `%` left after decoding (double encoding), a drive or stream colon, or a trailing dot or space
 *  (Windows resolves both). Empty segments collapse, so `//x` never becomes root-relative. `/` is the app shell. */
export function safeSegments(urlPath: string): string[] | undefined {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/")) return undefined;
  const out: string[] = [];
  for (const raw of urlPath.split("/")) {
    if (raw === "") continue;
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return undefined; }
    if (seg.length > MAX_SEGMENT || seg === "." || seg === ".." || seg.startsWith(".")) return undefined;
    if (/[\\/\u0000-\u001f\u007f%:]/.test(seg) || /[. ]$/.test(seg)) return undefined;
    out.push(seg);
  }
  return out.length === 0 ? ["index.html"] : out;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff",
};

export interface StaticFile { body: Buffer; contentType: string; html: boolean }

/** Read-only file serving of the built web app. Nothing outside the root is reachable: the path is cleaned first, then the
 *  real (symlink-resolved) path of the candidate must still lie under the real root. A path whose last segment has no
 *  extension is a client-side route and gets the app shell. */
export function createStaticServer(root: string): { read(urlPath: string): Promise<StaticFile | undefined> } {
  let realRoot: Promise<string> | undefined;
  return {
    async read(urlPath) {
      const segs = safeSegments(urlPath);
      if (!segs) return undefined;
      try {
        const base = await (realRoot ??= realpath(root));
        const last = segs[segs.length - 1]!;
        const target = last.includes(".") ? segs : ["index.html"];
        const real = await realpath(path.join(base, ...target));
        if (real !== base && !real.startsWith(base + path.sep)) return undefined;
        const st = await stat(real);
        if (!st.isFile() || st.size > MAX_BYTES) return undefined;
        const ext = path.extname(real).toLowerCase();
        return { body: await readFile(real), contentType: TYPES[ext] ?? "application/octet-stream", html: ext === ".html" };
      } catch { return undefined; }
    },
  };
}

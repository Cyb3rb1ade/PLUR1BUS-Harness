// Discovery and opening of the protected log files under `<home>/logs/` (D111 §2.1): `<role>.log` and its rotated
// copies `<role>.log.<n>` (`.1` newest, the S17 rotation of module-api's logger) for the diagnostic stream,
// `audit.log` (+ rotated copies) for the audit stream. `payload.log` is opt-in capture (§2.5) and is never read here.
import { lstatSync, readdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type Stream = "diagnostic" | "audit";

export interface LogFileRef { path: string; component: string; generation: number }
export interface OpenLogFile extends LogFileRef { fh: FileHandle; size: number }

const NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.log(?:\.([0-9]+))?$/;
const EXCLUDED = new Set(["payload"]);

export function listLogFiles(dir: string, stream: Stream): LogFileRef[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: LogFileRef[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const component = m[1]!;
    if (EXCLUDED.has(component)) continue;
    if ((component === "audit") !== (stream === "audit")) continue;
    out.push({ path: path.join(dir, name), component, generation: m[2] === undefined ? 0 : Number(m[2]) });
  }
  return out.sort((a, b) => a.component.localeCompare(b.component) || b.generation - a.generation);
}

const identity = (st: { ino: number | bigint; dev: number | bigint; size: number | bigint }): string => `${st.dev}:${st.ino}`;

/**
 * Opens every file of the stream and keeps the descriptors, so a rotation during the scan (a rename never changes what an
 * open descriptor reads) cannot make one file be read twice or skipped. The set is verified after opening: when a name
 * now points at another file, or the set of names changed, the open is retried (at most `retries` times; after that the
 * descriptors held are used as they are, each still a consistent file). A symlink or a non-regular file is skipped.
 */
export async function openLogFiles(dir: string, stream: Stream, o: { retries?: number; onListed?: () => void | Promise<void> } = {}): Promise<OpenLogFile[]> {
  const retries = o.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const refs = listLogFiles(dir, stream);
    await o.onListed?.();
    const opened: Array<OpenLogFile & { id: string }> = [];
    try {
      for (const ref of refs) {
        let lst;
        try { lst = lstatSync(ref.path); } catch { continue; } // rotated away between the listing and now
        if (!lst.isFile()) continue; // RULING: a symlink in the log directory is never followed
        let fh: FileHandle;
        try { fh = await open(ref.path, "r"); } catch { continue; }
        const st = await fh.stat();
        opened.push({ ...ref, fh, size: st.size, id: identity(st) });
      }
      const stable = listLogFiles(dir, stream).map((r) => r.path).join("\n") === refs.map((r) => r.path).join("\n")
        && opened.every((f) => { try { return identity(lstatSync(f.path)) === f.id; } catch { return false; } });
      if (stable || attempt >= retries) return opened.map(({ id: _id, ...f }) => f);
    } catch (e) { await closeLogFiles(opened); throw e; }
    await closeLogFiles(opened);
  }
}

export async function closeLogFiles(files: Array<{ fh: FileHandle }>): Promise<void> {
  await Promise.all(files.map((f) => f.fh.close().catch(() => undefined)));
}

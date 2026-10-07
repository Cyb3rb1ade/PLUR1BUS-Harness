// Which files under `logs/` are readable through the log RPC, grouped into chains (`<file>` newest, `<file>.1` ...
// `<file>.<keep>` oldest, the module-api rotation), and a symlink-refusing open.
import { constants, lstatSync, readdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sourceKeyOfRole, type LogStream } from "./normalize.ts";

export interface LogChain {
  /** `<stream>/<role>`: the stable identity of a chain, used in cursors and for ordering at equal timestamps. */
  id: string;
  stream: LogStream;
  role: string;
  /** Source key the chain's files stand for (D111 R7: attribution comes from the file). */
  key: string;
  /** Paths, newest file first. */
  files: string[];
}

const NAME = /^(?<role>[A-Za-z0-9][A-Za-z0-9._-]*?)(?<out>\.out)?\.log(?:\.(?<n>[1-9][0-9]{0,5}))?$/;
/** Never readable here: the opt-in payload capture (D111 §2.5) holds prompt and response content. */
const EXCLUDED_ROLES = new Set(["payload"]);

/** The readable chains in `dir`; a missing directory is no chains. Only regular files count; a symlink is skipped. */
export function listChains(dir: string): LogChain[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const byId = new Map<string, { chain: LogChain; ns: Map<number, string> }>();
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m?.groups) continue;
    const role = m.groups["role"]!;
    if (EXCLUDED_ROLES.has(role)) continue;
    const stream: LogStream = m.groups["out"] ? "out" : role === "audit" ? "audit" : "diagnostic";
    if (stream === "out" && role === "audit") continue;
    const full = path.join(dir, name);
    try { if (!lstatSync(full).isFile()) continue; } catch { continue; }
    const id = `${stream}/${role}`;
    let e = byId.get(id);
    if (!e) { e = { chain: { id, stream, role, key: sourceKeyOfRole(role, stream), files: [] }, ns: new Map() }; byId.set(id, e); }
    e.ns.set(m.groups["n"] ? Number(m.groups["n"]) : 0, full);
  }
  return [...byId.values()]
    .map(({ chain, ns }) => ({ ...chain, files: [...ns.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface OpenLog { fh: FileHandle; size: number; identity: string; close(): Promise<void> }

/** Opens a regular file read-only. A symlink, a non-regular file, or a file swapped between `lstat` and `open` is refused (null). */
export async function openRegular(file: string): Promise<OpenLog | null> {
  let before;
  try { before = lstatSync(file, { bigint: true }); } catch { return null; }
  if (!before.isFile()) return null;
  let fh: FileHandle;
  try { fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const st = await fh.stat({ bigint: true });
    // Open-then-fstat: the descriptor, not the name, is what was checked. ino 0 means the platform has no usable file id.
    if (!st.isFile() || (before.ino !== 0n && st.ino !== before.ino) || st.dev !== before.dev) { await fh.close(); return null; }
    return { fh, size: Number(st.size), identity: `${st.dev}:${st.ino}`, close: () => fh.close() };
  } catch { await fh.close().catch(() => {}); return null; }
}

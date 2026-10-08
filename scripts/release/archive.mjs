// Dependency-free deterministic tar writer shared by the release packager and Core assembler.
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
// ---- tar -----------------------------------------------------------------------------------------------------------

const BLOCK = 512;

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`tar: ${n} does not fit ${width} octal digits`);
  return s.padStart(width - 1, "0") + "\0";
}

/** One 512-byte ustar header. `name` must be ASCII and at most 100 bytes (longer names go in a pax record). */
function header(name, { type, size = 0, mode, mtime }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, "ascii");
  return h;
}

function pad(size) {
  const r = size % BLOCK;
  return r === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - r);
}

/** A pax record `"<len> path=<value>\n"`, whose length counts itself. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/** The header blocks for `name`: a plain header, or a pax `x` header carrying the long or non-ASCII name first. */
function headers(name, meta) {
  const fits = Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]*$/.test(name);
  if (fits) return [header(name, meta)];
  const pax = Buffer.from(paxRecord("path", name), "utf8");
  const short = name.replace(/[^\x20-\x7e]/g, "_").slice(-100);
  return [header(`PaxHeaders/${basename(short)}`.slice(0, 100), { type: "x", size: pax.length, mode: 0o644, mtime: meta.mtime }), pax, pad(pax.length), header(short, meta)];
}

/** Collects the archive entries of `dir` under the archive prefix `prefix` into `into` (name → entry). */
function walk(dir, prefix, into, skipTop = new Set()) {
  for (const name of readdirSync(dir).sort()) {
    if (prefix === "" && skipTop.has(name)) continue;
    // pnpm's invocation timestamps/store paths are install metadata, not runtime dependencies.
    if (name === ".modules.yaml" || name.startsWith(".pnpm-workspace-state")) continue;
    const src = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    const st = lstatSync(src);
    if (name === ".bin" && /(^|\/)node_modules$/.test(prefix)) continue; // package-manager shims, not used at runtime
    if (st.isSymbolicLink()) throw new Error(`tar: ${rel} is a symlink; the payload carries no links (the extractor creates none on Windows)`);
    if (into.has(rel)) throw new Error(`tar: ${rel} is added twice`);
    if (st.isDirectory()) {
      into.set(rel, { kind: "dir" });
      walk(src, rel, into);
    } else if (st.isFile()) {
      into.set(rel, { kind: "file", src, exec: process.platform !== "win32" && (st.mode & 0o111) !== 0 });
    } else {
      throw new Error(`tar: ${rel} is not a regular file or directory`);
    }
  }
}

/** Resolves a source description into the sorted entry list. `source` is a directory, or a list of
 *  `{ name, dir }` (a tree under `name`, "" = the root; `skip` drops top-level names), `{ name, data }` (an inline
 *  file) and `{ name, emptyDir: true }`. */
function entries(source) {
  const items = typeof source === "string" ? [{ name: "", dir: source }] : source;
  const all = new Map();
  for (const it of items) {
    if (it.data !== undefined || it.emptyDir) {
      if (all.has(it.name)) throw new Error(`tar: ${it.name} is added twice`);
      all.set(it.name, it.emptyDir ? { kind: "dir" } : { kind: "file", data: Buffer.from(it.data), exec: false });
      continue;
    }
    if (it.name !== "") {
      if (all.has(it.name)) throw new Error(`tar: ${it.name} is added twice`);
      all.set(it.name, { kind: "dir" });
    }
    walk(it.dir, it.name, all, it.skip);
  }
  return [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function* tarStream(list, mtime) {
  for (const [name, e] of list) {
    if (e.kind === "dir") {
      yield* headers(`${name}/`, { type: "5", mode: 0o755, mtime });
      continue;
    }
    const data = e.data ?? readFileSync(e.src);
    yield* headers(name, { type: "0", size: data.length, mode: e.exec ? 0o755 : 0o644, mtime });
    yield data;
    yield pad(data.length);
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** Writes `source` (see [entries]) as a deterministic `.tar.gz` to `out`, atomically. Returns its SHA-256. */
export async function writeTarGz(source, out) {
  const list = entries(source);
  const mtime = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "0", 10) || 0;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  const hash = createHash("sha256");
  const tee = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.from(tarStream(list, mtime)), createGzip({ level: 9 }), tee, createWriteStream(tmp));
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return hash.digest("hex");
}

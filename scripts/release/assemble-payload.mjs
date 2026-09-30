// Assembles the core payload for one release target (2a-H3b-b Task 10, HB18): `core-<ver>-<target>.tar.gz`, its
// `.sha256` (sha256sum format) and a `.json` metadata file that release-native.mjs reads.
//
//   node scripts/release/assemble-payload.mjs --target <id> --out dist/core-<ver>-<id>.tar.gz [--deployed <dir>]
//
// Must run on the target's own runner: the core's production dependencies carry native addons (LanceDB, onnxruntime,
// sharp) that pnpm installs for the host platform only. `pnpm --filter @plur1bus/core deploy --legacy --prod` with the
// hoisted node linker gives a flat node_modules without links (the Rust extractor creates no links on Windows);
// `--deployed` uses an existing deploy tree instead (tests).
//
// Payload layout (what `setup`'s runtime.core, modules.bundled and skills steps read, crates/plur1bus/src/install/
// setup.rs): the core's `dist/` contents at the root (`core.js` first of all), `package.json` stamped with
// `plur1bus.{contract,rpc}`, `node_modules/` (without `.bin` shims), `skills/` (the repo's) and `modules/` (the repo's
// bundled modules; empty today). The archive is deterministic: sorted entries, uid/gid 0, mtime SOURCE_DATE_EPOCH or 0,
// ustar with pax records for long names, no links, no special files.
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { TARGETS, writeAtomic } from "./release-native.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE_JS = "node_modules/@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
const RPC_SCHEMA = "node_modules/@plur1bus/rpc-schema/schema/rpc.schema.json";
/** Top-level entries of the deploy tree that are not shipped (`dist/` is shipped, flattened into the root). */
const DEPLOY_SKIP = new Set(["src", "test", "dist", "package.json"]);

/** The engine contract version the engine reports (`contract: "x.y.z"` in create-engine.js); every occurrence must
 *  agree. */
export function readEngineContract(source) {
  const found = new Set([...source.matchAll(/\bcontract:\s*"(\d+\.\d+\.\d+)"/g)].map((m) => m[1]));
  if (found.size === 0) throw new Error(`engine contract not found in ${ENGINE_JS}`);
  if (found.size > 1) throw new Error(`engine contract is ambiguous in ${ENGINE_JS}: ${[...found].join(", ")}`);
  return [...found][0];
}

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

// ---- resolvability ----------------------------------------------------------------------------------------------

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

/** The package name of a bare specifier (`@a/b/c` → `@a/b`, `x/y` → `x`), or null for relative, absolute, URL and
 *  builtin specifiers. */
function packageOf(spec) {
  // Not a package name (relative, absolute, `node:`/URL, or text inside a string that merely follows the word "import").
  if (!/^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*(?:\/[^\s"':]*)?$/i.test(spec)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return BUILTINS.has(name) || BUILTINS.has(spec) ? null : name;
}

/** Node's package lookup from `fromDir` up to `root` (inclusive), on the paths as they are: no realpath. A payload is
 *  installed without links (the Rust extractor creates none, and `--core-from <dir>` dereferences them on Windows), so
 *  a dependency that pnpm's isolated layout reaches only through a link's real path is missing once installed. */
function reachable(root, fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
    if (dir === root || !(dir + sep).startsWith(root + sep)) return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every package directory in the `node_modules` tree under `dir` (scoped ones included, dot entries such as `.bin`
 *  and `.pnpm` skipped), nested `node_modules` too. */
function packageDirs(dir, out = []) {
  const nm = join(dir, "node_modules");
  if (!isDir(nm)) return out;
  for (const name of readdirSync(nm).sort()) {
    if (name.startsWith(".")) continue;
    const dirs = name.startsWith("@") ? readdirSync(join(nm, name)).sort().map((n) => join(nm, name, n)) : [join(nm, name)];
    for (const d of dirs) {
      if (!existsSync(join(d, "package.json"))) continue;
      out.push(d);
      packageDirs(d, out);
    }
  }
  return out;
}

function jsFiles(dir, out = []) {
  if (!isDir(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (isDir(p)) jsFiles(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

/** What a payload tree cannot resolve once installed without links: every `dependencies` entry of the root package
 *  and of every package under `node_modules`, and every bare import in the shipped code of the root (`dist/`) and of
 *  the workspace packages (`node_modules/@plur1bus/*`, whose imports esbuild leaves external). Each item is
 *  `{ from, name }` with `from` relative to `root`. */
export function unresolvedDependencies(root) {
  root = resolve(root);
  const missing = [];
  const need = (fromDir, name, from) => {
    if (!reachable(root, fromDir, name)) missing.push({ from: relative(root, from).split(sep).join("/") || ".", name });
  };
  for (const dir of [root, ...packageDirs(root)]) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) need(dir, name, dir);
  }
  const workspace = join(root, "node_modules", "@plur1bus");
  const shipped = [join(root, "dist"), ...(isDir(workspace) ? readdirSync(workspace).sort().map((n) => join(workspace, n)) : [])];
  for (const top of shipped) {
    for (const file of jsFiles(top)) {
      const seen = new Set();
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
        const name = packageOf(m[1]);
        if (name === null || seen.has(name)) continue;
        seen.add(name);
        need(dirname(file), name, file);
      }
    }
  }
  return missing;
}

// ---- payload -------------------------------------------------------------------------------------------------------

function bundledModules(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const manifest = join(dir, name, "module.json");
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    out.push({ name: m.name, version: m.version, apiVersion: m.apiVersion });
  }
  return out;
}

function deploy() {
  const dir = mkdtempSync(join(tmpdir(), "p1b-deploy-"));
  const into = join(dir, "core");
  execFileSync("pnpm", ["--filter", "@plur1bus/core", "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", into], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  return { into, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Builds the payload for `target` at `out`, plus `<out>.sha256` and `<out minus .tar.gz>.json`; returns the
 *  metadata. */
export async function assemble({ target, out, deployed, skills = join(ROOT, "skills"), modules = join(ROOT, "modules") }) {
  if (!TARGETS.includes(target)) throw new Error(`${target}: not a release target (${TARGETS.join(", ")})`);
  if (!out.endsWith(".tar.gz")) throw new Error(`--out must end in .tar.gz: ${out}`);
  const d = deployed ? { into: deployed, cleanup: () => {} } : deploy();
  try {
    const root = d.into;
    if (!existsSync(join(root, "dist", "core.js"))) throw new Error(`${root}/dist/core.js is missing: run pnpm build first`);
    const missing = unresolvedDependencies(root);
    if (missing.length > 0) {
      const shown = missing.slice(0, 20).map((m) => `${m.name} (from ${m.from})`).join(", ");
      throw new Error(`the deployed tree does not resolve without links: ${shown}${missing.length > 20 ? `, and ${missing.length - 20} more` : ""}`);
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const contract = readEngineContract(readFileSync(join(root, ENGINE_JS), "utf8"));
    const rpc = JSON.parse(readFileSync(join(root, RPC_SCHEMA), "utf8"))["x-rpc-version"];
    if (typeof rpc !== "string" || rpc === "") throw new Error(`${RPC_SCHEMA} has no x-rpc-version`);
    // setup records the installed core's contract and rpc from `plur1bus.*` (install::setup::install_core), and
    // `update --check` compares them with native.core (Task 5).
    const stamped = { ...pkg, plur1bus: { ...(pkg.plur1bus ?? {}), contract, rpc } };
    const items = [
      { name: "", dir: root, skip: DEPLOY_SKIP },
      { name: "", dir: join(root, "dist") },
      { name: "package.json", data: `${JSON.stringify(stamped, null, 2)}\n` },
      existsSync(skills) ? { name: "skills", dir: skills } : { name: "skills", emptyDir: true },
      existsSync(modules) ? { name: "modules", dir: modules } : { name: "modules", emptyDir: true },
    ];
    const digest = await writeTarGz(items, out);
    writeAtomic(`${out}.sha256`, `${digest}  ${basename(out)}\n`);
    const meta = { target, core: { version: pkg.version, contract, rpc }, modules: bundledModules(modules) };
    writeAtomic(out.replace(/\.tar\.gz$/, ".json"), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  } finally {
    d.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error("usage: assemble-payload.mjs --target <id> --out <file.tar.gz> [--deployed <dir>]");
      a[argv[i].slice(2)] = argv[i + 1];
    }
    if (!a.target || !a.out) throw new Error("--target and --out are required");
    const out = resolve(a.out);
    const meta = await assemble({ target: a.target, out, ...(a.deployed ? { deployed: resolve(a.deployed) } : {}) });
    console.log(`assemble-payload: ${basename(out)} ${readFileSync(`${out}.sha256`, "utf8").split(" ")[0]} (core ${meta.core.version}, contract ${meta.core.contract}, rpc ${meta.core.rpc})`);
  } catch (e) {
    console.error(`assemble-payload: ${e.message}`);
    process.exit(1);
  }
}

// Hermes provider artefact (HM2 Task 7; HM2-R4, R21, R22; rulings F7, F13, F31, F33).
//
//   node scripts/build-hermes-provider.mjs --out <dir> [--expect-version <v>]
//     -> <dir>/plur1bus-hermes-provider-<v>.tar.gz, prints "<sha256>  <name>" (sha256sum format).
//   node scripts/build-hermes-provider.mjs lock --artifacts <dir> --base-url <url> --out <file> [--tested-hermes <v>]
//     -> the `hermes-sidecar.lock.json` seed for the plugin repo (provider + per-target binary URL and SHA-256,
//        nodeVersion from the harness Node pin, `placeholder: false`).
//
// The tarball is a deterministic ustar stream in gzip: entries sorted, mtime 0, uid/gid 0, no user or group
// names, directories 0755 and files 0644, regular files and directories only. It holds
//   plur1bus/**                                   the provider (hosts/hermes/plur1bus)
//   plur1bus/_vendor/plur1bus_memory_client/**   the client package, byte for byte (HM2-R4)
//   plur1bus/LICENSE                              the repository licence
//   plur1bus/MANIFEST.json                        { schema, version, files: { "<archive path>": "<sha256>" } }
// `__pycache__`, `tests`, dotfiles and compiled files are left out; a symbolic link anywhere in either source tree
// fails the build. The provider, the client's pyproject.toml and __version__, and Cargo.toml must carry one version
// (HM2-R22), which names the file. Only `node:` builtins; nothing is fetched.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants as zc } from "node:zlib";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_SCHEMA = "plur1bus.hermes-provider/1";
export const LOCK_SCHEMA = "plur1bus.hermes-sidecar-lock/1";
export const MIN_HERMES_VERSION = "0.21.4";
export const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"];
const ROOT = "plur1bus";
const VENDOR = `${ROOT}/_vendor`;
const CLIENT_PKG = "plur1bus_memory_client";
const VENDOR_INIT =
  '"""Vendored copies of the provider\'s dependencies (HM2-R4); written by scripts/build-hermes-provider.mjs."""\n';

export const tarballName = (version) => `plur1bus-hermes-provider-${version}.tar.gz`;
export const wheelName = (version) => `plur1bus_memory_client-${version}-py3-none-any.whl`;
export const sdistName = (version) => `plur1bus_memory_client-${version}.tar.gz`;
export const binaryName = (target) => `plur1bus-${target}${target.startsWith("win-") ? ".exe" : ""}`;

export function defaultSources(repo = REPO) {
  const client = join(repo, "clients/python/plur1bus-memory-client");
  return {
    provider: join(repo, "hosts/hermes/plur1bus"),
    client: join(client, "src", CLIENT_PKG),
    pyproject: join(client, "pyproject.toml"),
    cargo: join(repo, "Cargo.toml"),
    license: join(repo, "LICENSE"),
    pins: join(repo, "crates/plur1bus/src/install/pins.rs"),
  };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- versions (HM2-R22) ----------------------------------------------------------------------------------------

function match(file, re, what) {
  const m = readFileSync(file, "utf8").match(re);
  if (!m) throw new Error(`${file}: no ${what}`);
  return m[1];
}

/** Every version the artefacts carry, by file. */
export function readVersions(src) {
  return {
    [src.cargo]: match(src.cargo, /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms, "[workspace.package] version"),
    [src.pyproject]: match(src.pyproject, /^\[project\][^[]*?^version\s*=\s*"([^"]+)"/ms, "[project] version"),
    [join(src.provider, "plugin.yaml")]: match(join(src.provider, "plugin.yaml"), /^version:\s*"?([^"\s]+)"?\s*$/m, "version"),
    [join(src.client, "__init__.py")]: match(join(src.client, "__init__.py"), /^__version__\s*=\s*"([^"]+)"/m, "__version__"),
  };
}

/** The one harness version, or throws naming every file that disagrees with Cargo.toml. */
export function harnessVersion(src) {
  const all = readVersions(src);
  const want = all[src.cargo];
  const off = Object.entries(all).filter(([, v]) => v !== want);
  if (off.length) {
    throw new Error(`version mismatch (HM2-R22): Cargo.toml has ${want}; ${off.map(([f, v]) => `${f} has ${v}`).join("; ")}`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(want)) throw new Error(`not a release version: ${want}`);
  return want;
}

export function nodeVersion(src) {
  return match(src.pins, /^pub const NODE_VERSION: &str = "([^"]+)";/m, "NODE_VERSION");
}

// ---- file collection -------------------------------------------------------------------------------------------

const SKIP_DIR = new Set(["__pycache__", "tests", "test"]);
const skipFile = (name) => name.startsWith(".") || /\.(pyc|pyo)$/.test(name);

/** Regular files under `dir` as [relative posix path, absolute path], sorted; throws on a link or special file. */
function collect(dir, rel = "") {
  const out = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(dir, r);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`refusing a symbolic link in the provider sources: ${abs}`);
    if (st.isDirectory()) {
      if (name.startsWith(".") || SKIP_DIR.has(name)) continue;
      out.push(...collect(dir, r));
    } else if (st.isFile()) {
      if (!skipFile(name)) out.push([r, abs]);
    } else {
      throw new Error(`refusing a special file in the provider sources: ${abs}`);
    }
  }
  return out;
}

/** The archive's files as a sorted Map "<archive path>" -> Buffer, MANIFEST.json included. */
export function providerFiles(src, version = harnessVersion(src)) {
  const files = new Map();
  const add = (path, buf) => {
    if (!/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error(`archive path outside [A-Za-z0-9._/-]: ${path}`);
    const key = path.toLowerCase();
    for (const p of files.keys()) if (p.toLowerCase() === key) throw new Error(`duplicate or case-fold duplicate path: ${path}`);
    files.set(path, buf);
  };
  const provider = collect(src.provider);
  if (provider.some(([r]) => r === "_vendor" || r.startsWith("_vendor/"))) throw new Error(`${src.provider}/_vendor exists; the build writes it`);
  for (const [r, abs] of provider) add(`${ROOT}/${r}`, readFileSync(abs));
  const client = collect(src.client);
  if (!client.some(([r]) => r === "__init__.py")) throw new Error(`${src.client} is not a package (no __init__.py)`);
  add(`${VENDOR}/__init__.py`, Buffer.from(VENDOR_INIT));
  for (const [r, abs] of client) add(`${VENDOR}/${CLIENT_PKG}/${r}`, readFileSync(abs));
  add(`${ROOT}/LICENSE`, readFileSync(src.license));
  const manifest = { schema: MANIFEST_SCHEMA, version, files: {} };
  for (const p of [...files.keys()].sort()) manifest.files[p] = sha256(files.get(p));
  add(`${ROOT}/MANIFEST.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---- ustar -----------------------------------------------------------------------------------------------------

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`value ${n} does not fit a ${width}-byte tar field`);
  return `${s.padStart(width - 1, "0")}\0`;
}

function header(path, { size, dir }) {
  const h = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // Split at a "/" so that prefix <= 155 and name <= 100 bytes (paths are ASCII, checked in providerFiles).
    const body = path.endsWith("/") ? path.slice(0, -1) : path;
    const at = [...body.matchAll(/\//g)].map((m) => m.index).reverse().find((i) => i <= 155 && path.length - i - 1 <= 100);
    if (at === undefined) throw new Error(`path too long for ustar: ${path}`);
    prefix = path.slice(0, at);
    name = path.slice(at + 1);
  }
  h.write(name, 0, 100, "ascii");
  h.write(octal(dir ? 0o755 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii"); // uid
  h.write(octal(0, 8), 116, "ascii"); // gid
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii"); // mtime
  h.fill(0x20, 148, 156); // checksum placeholder: eight spaces
  h.write(dir ? "5" : "0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(octal(0, 8), 329, "ascii"); // devmajor
  h.write(octal(0, 8), 337, "ascii"); // devminor
  h.write(prefix, 345, 155, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A ustar stream of `files` (sorted Map path -> Buffer) with every parent directory as its own entry. */
export function ustar(files) {
  const dirs = new Set();
  for (const p of files.keys()) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  const entries = [...[...dirs].map((d) => [d, null]), ...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks = [];
  for (const [p, buf] of entries) {
    if (buf === null) {
      chunks.push(header(p, { size: 0, dir: true }));
    } else {
      chunks.push(header(p, { size: buf.length, dir: false }), buf);
      const pad = (512 - (buf.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // end of archive
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const record = 10240; // blocking factor 20, as tar(1) writes
  if (len % record) chunks.push(Buffer.alloc(record - (len % record)));
  return Buffer.concat(chunks);
}

/** gzip with a fixed header: no name, mtime 0, OS byte 255 ("unknown") on every platform. */
export function gzip(buf) {
  const gz = gzipSync(buf, { level: 9, memLevel: 9, strategy: zc.Z_DEFAULT_STRATEGY });
  gz[4] = gz[5] = gz[6] = gz[7] = 0; // mtime
  gz[9] = 0xff; // OS
  return gz;
}

/** Builds the tarball into `out`; returns { version, name, path, sha256, bytes }. */
export function buildProvider({ out, src = defaultSources(), expectVersion } = {}) {
  if (!out) throw new Error("--out is required");
  const version = harnessVersion(src);
  if (expectVersion !== undefined && expectVersion.replace(/^v/, "") !== version) {
    throw new Error(`--expect-version ${expectVersion} is not the harness version ${version}`);
  }
  const bytes = gzip(ustar(providerFiles(src, version)));
  mkdirSync(out, { recursive: true });
  const name = tarballName(version);
  const path = join(out, name);
  writeFileSync(path, bytes);
  return { version, name, path, sha256: sha256(bytes), bytes };
}

// ---- lock seed (F31, F33) ---------------------------------------------------------------------------------------

/**
 * The seed of the plugin repo's `scripts/dist/hermes-sidecar.lock.json`, from the files of one harness release run:
 * `artifacts` holds the provider tarball and `plur1bus-<target>[.exe]` for every target. `placeholder` is false here
 * and nowhere else: a hand-made lock without real hashes carries `"placeholder": true` (F31).
 */
export function buildLock({ artifacts, baseUrl, src = defaultSources(), testedHermes = MIN_HERMES_VERSION }) {
  if (!artifacts || !baseUrl) throw new Error("lock needs --artifacts and --base-url");
  const version = harnessVersion(src);
  const base = baseUrl.replace(/\/+$/, "");
  const entry = (name) => {
    let buf;
    try {
      buf = readFileSync(join(artifacts, name));
    } catch (e) {
      throw new Error(`lock: ${name} is missing from ${artifacts} (${e.code ?? e.message})`);
    }
    return { url: `${base}/${name}`, sha256: sha256(buf) };
  };
  const binary = {};
  for (const t of TARGETS) binary[t] = entry(binaryName(t));
  return {
    schema: LOCK_SCHEMA,
    placeholder: false,
    harnessTag: `v${version}`,
    version,
    nodeVersion: nodeVersion(src),
    provider: entry(tarballName(version)),
    binary,
    minHermesVersion: MIN_HERMES_VERSION,
    testedHermesVersion: testedHermes,
  };
}

// ---- CLI -------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined || v.startsWith("--")) throw new Error(`bad argument at ${k ?? "end"}`);
    out[k.slice(2)] = v;
  }
  return out;
}

const USAGE =
  "usage: build-hermes-provider.mjs --out <dir> [--expect-version <v>]\n" +
  "       build-hermes-provider.mjs lock --artifacts <dir> --base-url <url> --out <file> [--tested-hermes <v>]";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "lock") {
      const a = parseArgs(argv.slice(1));
      if (!a.out) throw new Error("--out is required");
      const lock = buildLock({ artifacts: a.artifacts, baseUrl: a["base-url"], testedHermes: a["tested-hermes"] });
      writeFileSync(a.out, `${JSON.stringify(lock, null, 2)}\n`);
      console.log(`${lock.provider.sha256}  ${tarballName(lock.version)} (lock ${a.out})`);
    } else {
      const a = parseArgs(argv);
      const r = buildProvider({ out: a.out, expectVersion: a["expect-version"] });
      console.log(`${r.sha256}  ${r.name}`);
    }
  } catch (e) {
    console.error(`build-hermes-provider: ${e.message}\n${USAGE}`);
    process.exit(1);
  }
}

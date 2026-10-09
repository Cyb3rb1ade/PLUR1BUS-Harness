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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
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

import { writeTarGz } from "./archive.mjs";
export { writeTarGz } from "./archive.mjs";

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

/** Where `deploy()` makes its temp directory: the system temp directory when it is on the same volume as the
 *  workspace `root`, else `<root>/target` (gitignored, Cargo's). pnpm's hoisted linker places the workspace packages
 *  of a deploy with a join of the workspace directory and a path relative to it, and across Windows drives that
 *  relative path is absolute: a `D:` checkout with `%TEMP%` on `C:` failed with `ENOENT: mkdir
 *  'D:\\a\\...\\C:\\Users\\...\\core\\node_modules\\@plur1bus'` (windows-2025, HM2 CI round 2). */
export function deployParent(root, tmp, platform = process.platform) {
  const p = platform === "win32" ? win32 : posix;
  const volume = (d) => p.parse(p.resolve(d)).root.toLowerCase();
  return volume(tmp) === volume(root) ? tmp : p.join(root, "target");
}

function deploy() {
  const parent = deployParent(ROOT, tmpdir());
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "p1b-deploy-"));
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
  if (![...TARGETS, "darwin-x64"].includes(target)) throw new Error(`${target}: not a release target (${TARGETS.join(", ")})`);
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

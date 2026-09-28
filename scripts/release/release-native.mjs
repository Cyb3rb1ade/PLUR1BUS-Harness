// Builds `release-native.json`, the `native` object of D78's release.json (HB10, HB18), from the release artefacts of
// the five targets (HB7) and validates it against crates/plur1bus/schema/release-manifest.schema.json's `native`
// definition. D78's release workflow merges the object into release.json and signs it; this script signs nothing.
//
//   node scripts/release/release-native.mjs --artifacts <dir> --version <v> [--base-url <url>] --out <file>
//
// <dir> holds, per target: `plur1bus-<target>[.exe]` (for darwin-arm64: the signed binary), and from
// assemble-payload.mjs `core-<v>-<target>.tar.gz`, its `.sha256` and its `.json` metadata. A missing file, a
// `.sha256` that does not match, or targets that disagree on the core or the bundled modules exit 1 and write nothing.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The five release targets, in the order the release manifest lists them (crates/plur1bus/src/install/targets.rs). */
export const TARGETS = Object.freeze(["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"]);

/** The published binary's file name for `target`. */
export function binaryName(target) {
  return `plur1bus-${target}${target.startsWith("win-") ? ".exe" : ""}`;
}

/** The core payload's file name. `setup` downloads `<release base>/core-<binary version>-<target>.tar.gz`. */
export function payloadName(version, target) {
  return `core-${version}-${target}.tar.gz`;
}

/** The default release base URL: the GitHub release of tag `v<version>` (the URL a release binary bakes in as
 *  PLUR1BUS_RELEASE_BASE_URL). */
export function defaultBaseUrl(version) {
  return `https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/releases/download/v${version}`;
}

/** SHA-256 of a file, streamed, lower-case hex. */
export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("error", fail).on("data", (b) => h.update(b)).on("end", () => ok(h.digest("hex")));
  });
}

/** Atomic write (Global Constraints): `<name>.tmp-<pid>` → fsync → rename. */
export function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The Node version setup installs: `NODE_VERSION` in pins.rs, the single source of truth (HB8). */
export function pinnedNodeVersion() {
  const src = readFileSync(join(ROOT, "crates/plur1bus/src/install/pins.rs"), "utf8");
  const m = /pub const NODE_VERSION: &str = "([^"]+)";/.exec(src);
  if (!m) throw new Error("NODE_VERSION not found in crates/plur1bus/src/install/pins.rs");
  return m[1];
}

/** The config schema's `schemaVersion` constant. */
export function configSchemaVersion() {
  const schema = JSON.parse(readFileSync(join(ROOT, "packages/config-schema/schema/config.schema.json"), "utf8"));
  const v = schema?.properties?.schemaVersion?.const;
  if (!Number.isInteger(v)) throw new Error("config.schema.json has no integer schemaVersion const");
  return v;
}

let validator;
/** Validation errors of `native` against the schema's `native` definition; `[]` when valid. Ajv comes from the
 *  rpc-schema package's dependencies (the repo root has none). */
export function validateNative(native) {
  if (!validator) {
    const require = createRequire(join(ROOT, "packages/rpc-schema/package.json"));
    const mod = require("ajv/dist/2020.js");
    const Ajv2020 = mod.default ?? mod;
    const schema = JSON.parse(readFileSync(join(ROOT, "crates/plur1bus/schema/release-manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    // Validate a document holding only `native` against the whole schema's `native` property with its $defs.
    validator = ajv.compile({ $defs: schema.$defs, type: "object", required: ["native"], additionalProperties: false, properties: { native: schema.properties.native } });
  }
  return validator({ native }) ? [] : validator.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${what}: ${e.message}`);
  }
}

/** The `native` object for `targets`, built from the files in `artifacts`. Throws naming the target on a missing or
 *  inconsistent artefact. */
export async function buildNative({ artifacts, version, baseUrl = defaultBaseUrl(version), targets = TARGETS }) {
  const base = baseUrl.replace(/\/+$/, "");
  const binary = {};
  const payload = {};
  let core = null;
  let modules = null;
  let first = "";
  for (const t of targets) {
    if (!TARGETS.includes(t)) throw new Error(`${t}: not a release target`);
    const bin = join(artifacts, binaryName(t));
    if (!existsSync(bin)) throw new Error(`${t}: no binary (${basename(bin)})`);
    binary[t] = { url: `${base}/${binaryName(t)}`, sha256: await sha256File(bin) };

    const p = join(artifacts, payloadName(version, t));
    if (!existsSync(p)) throw new Error(`${t}: no core payload (${basename(p)})`);
    const digest = await sha256File(p);
    if (existsSync(`${p}.sha256`)) {
      const recorded = readFileSync(`${p}.sha256`, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
      if (recorded !== digest) throw new Error(`${t}: ${basename(p)} does not match its .sha256 (${recorded} != ${digest})`);
    }
    payload[t] = { url: `${base}/${payloadName(version, t)}`, sha256: digest };

    const meta = readJson(p.replace(/\.tar\.gz$/, ".json"), `${t}: payload metadata`);
    const c = { version: meta?.core?.version, contract: meta?.core?.contract, rpc: meta?.core?.rpc };
    const m = Array.isArray(meta?.modules) ? meta.modules.map(({ name, version: v, apiVersion }) => ({ name, version: v, apiVersion })) : [];
    if (core === null) {
      core = c;
      modules = m;
      first = t;
    } else if (JSON.stringify(c) !== JSON.stringify(core) || JSON.stringify(m) !== JSON.stringify(modules)) {
      throw new Error(`${t} and ${first} disagree on the core or the bundled modules: ${JSON.stringify({ core: c, modules: m })} vs ${JSON.stringify({ core, modules })}`);
    }
  }
  const native = {
    binary,
    core: { ...core, payload },
    node: { version: pinnedNodeVersion() },
    modules: modules ?? [],
    configSchemaVersion: configSchemaVersion(),
  };
  const errors = validateNative(native);
  if (errors.length > 0) throw new Error(`the native object does not validate: ${errors.join("; ")}`);
  return native;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined) throw new Error(`usage: release-native.mjs --artifacts <dir> --version <v> [--base-url <url>] --out <file> (at ${k ?? "end"})`);
    out[k.slice(2)] = v;
  }
  for (const k of ["artifacts", "version", "out"]) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2));
    const native = await buildNative({ artifacts: resolve(a.artifacts), version: a.version, ...(a["base-url"] ? { baseUrl: a["base-url"] } : {}) });
    writeAtomic(resolve(a.out), `${JSON.stringify(native, null, 2)}\n`);
    console.log(`release-native: wrote ${a.out} (${Object.keys(native.binary).length} targets)`);
  } catch (e) {
    console.error(`release-native: ${e.message}`);
    process.exit(1);
  }
}

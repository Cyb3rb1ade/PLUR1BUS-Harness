// HM2 Task 7: the Hermes provider tarball (HM2-R4, R21, R22), the lock seed (F31, F33) and the release job (F7, F8).
// Run by the root `lint` script. Builds only into temp dirs, reads the workflow with line scans (no YAML parser),
// never touches the network or a real home.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  MANIFEST_SCHEMA,
  REPO,
  TARGETS,
  binaryName,
  buildLock,
  buildProvider,
  defaultSources,
  harnessVersion,
  sdistName,
  tarballName,
  wheelName,
} from "./build-hermes-provider.mjs";

const SRC = defaultSources();
const VERSION = harnessVersion(SRC);
const TMP = mkdtempSync(join(tmpdir(), "p1-hermes-provider-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
let n = 0;
const fresh = () => join(TMP, `t${n++}`);

/** Independent ustar reader (the oracle for the writer): [{ name, type, mode, uid, gid, mtime, uname, gname, data }]. */
function readTar(gz) {
  const buf = gunzipSync(gz);
  const out = [];
  const str = (o, l) => buf.subarray(o, o + l).toString("latin1").replace(/\0.*$/s, "");
  const oct = (o, l) => parseInt(str(o, l).trim() || "0", 8);
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    assert.equal(oct(off + 148, 8), sum, `checksum at ${off}`);
    assert.equal(str(off + 257, 6), "ustar");
    const prefix = str(off + 345, 155);
    const name = (prefix ? `${prefix}/` : "") + str(off, 100);
    const size = oct(off + 124, 12);
    out.push({
      name,
      type: String.fromCharCode(h[156]),
      mode: oct(off + 100, 8),
      uid: oct(off + 108, 8),
      gid: oct(off + 116, 8),
      mtime: oct(off + 136, 12),
      uname: str(off + 265, 32),
      gname: str(off + 297, 32),
      data: buf.subarray(off + 512, off + 512 + size),
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const built = buildProvider({ out: fresh() });
const entries = readTar(readFileSync(built.path));
const files = new Map(entries.filter((e) => e.type === "0").map((e) => [e.name, e.data]));

test("the tarball is named for the harness version and its printed hash is the file's", () => {
  assert.equal(built.name, tarballName(VERSION));
  assert.equal(built.name, `plur1bus-hermes-provider-${VERSION}.tar.gz`);
  assert.equal(built.sha256, sha256(readFileSync(built.path)));
  const r = spawnSync(process.execPath, [join(REPO, "scripts/build-hermes-provider.mjs"), "--out", fresh()], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${built.sha256}  ${built.name}\n`);
});

test("two builds are byte-identical", () => {
  const a = buildProvider({ out: fresh() });
  const b = buildProvider({ out: fresh() });
  assert.ok(readFileSync(a.path).equals(readFileSync(b.path)));
  assert.ok(readFileSync(a.path).equals(readFileSync(built.path)));
  // gzip header: no name, mtime 0, OS byte fixed.
  const gz = readFileSync(a.path);
  assert.deepEqual([...gz.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
});

/** Git's view of `paths`: index blob id per tracked path, minus the files with uncommitted edits (null outside git). */
function gitBlobs(paths) {
  const git = (args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
  const ls = git(["ls-files", "-s", "-z", "--", ...paths]);
  if (ls.status !== 0) return null;
  const edited = new Set(git(["diff", "--name-only", "-z", "--", ...paths]).stdout.split("\0").filter(Boolean));
  const out = new Map();
  for (const rec of ls.stdout.split("\0").filter(Boolean)) {
    const [meta, path] = rec.split("\t");
    if (!edited.has(path)) out.set(path, meta.split(" ")[1]);
  }
  return out;
}
const blobId = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

test("the vendored client equals clients/python sources byte for byte", () => {
  const prefix = "plur1bus/_vendor/plur1bus_memory_client/";
  const walk = (dir, rel = "") =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return d.name === "__pycache__" ? [] : walk(dir, r);
      return d.name.endsWith(".pyc") ? [] : [r];
    });
  const source = walk(SRC.client).sort();
  const vendored = [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).sort();
  assert.deepEqual(vendored, source);
  assert.ok(files.has("plur1bus/_vendor/__init__.py"));
  // Archive path -> repository path of every shipped file that comes from the checkout.
  const clientRel = "clients/python/plur1bus-memory-client/src/plur1bus_memory_client";
  const origin = new Map([["plur1bus/LICENSE", "LICENSE"]]);
  for (const r of source) origin.set(prefix + r, `${clientRel}/${r}`);
  for (const r of walk(SRC.provider)) origin.set(`plur1bus/${r}`, `hosts/hermes/plur1bus/${r}`);
  for (const [arc, rel] of origin) {
    const shipped = files.get(arc);
    assert.ok(shipped, `${arc} shipped`);
    // The working tree copy, and LF only: a CRLF checkout cannot pass as the source.
    assert.ok(shipped.equals(readFileSync(join(REPO, rel))), `${arc} equals ${rel}`);
    assert.ok(!shipped.includes(0x0d), `${arc} has no CR`);
  }
  // Git's own bytes (the index blob, which .gitattributes keeps LF): every shipped file whose working copy has no
  // uncommitted edit must hash to that blob, so a checkout that rewrote line ends is caught even if the tree agrees
  // with itself.
  const blobs = gitBlobs([...new Set([...origin.values()])]);
  if (blobs) {
    let checked = 0;
    for (const [arc, rel] of origin) {
      if (!blobs.has(rel)) continue;
      assert.equal(blobId(files.get(arc)), blobs.get(rel), `${arc} is git's blob of ${rel}`);
      checked++;
    }
    assert.ok(checked > 0, "at least one shipped file compared with its git blob");
  }
});

test(".gitattributes keeps every shipped file LF on every checkout", () => {
  const r = spawnSync("git", ["-C", REPO, "check-attr", "eol", "--", "hosts/hermes/plur1bus/cli.py", "clients/python/plur1bus-memory-client/src/plur1bus_memory_client/client.py", "LICENSE", "clients/python/plur1bus-memory-client/LICENSE"], { encoding: "utf8" });
  if (r.status !== 0) return;
  for (const line of r.stdout.trim().split("\n")) assert.match(line, /: eol: lf$/, line);
});

test("a carriage return in a shipped file and a symlinked source root fail the build", () => {
  const root = fresh();
  const provider = join(root, "provider");
  cpSync(SRC.provider, provider, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  const src = { ...SRC, provider };
  writeFileSync(join(provider, "mapping.py"), readFileSync(join(provider, "mapping.py"), "utf8").replace(/\n/g, "\r\n"));
  assert.throws(() => buildProvider({ out: join(root, "out"), src }), /carriage return.*plur1bus\/mapping\.py/);
  const client = join(root, "client");
  cpSync(SRC.client, client, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  writeFileSync(join(client, "paths.py"), readFileSync(join(client, "paths.py"), "utf8").replace(/\n/g, "\r\n"));
  assert.throws(() => buildProvider({ out: join(root, "out"), src: { ...SRC, client } }), /carriage return.*_vendor\/plur1bus_memory_client\/paths\.py/);
  const linked = join(root, "linked");
  symlinkSync(SRC.provider, linked, "dir");
  assert.throws(() => buildProvider({ out: join(root, "out"), src: { ...SRC, provider: linked } }), /symbolic link as a provider source root/);
});

test("no __pycache__, tests, dotfiles or links in the tarball", () => {
  for (const e of entries) {
    assert.ok(e.type === "0" || e.type === "5", `${e.name}: type ${e.type}`);
    assert.equal(e.mode, e.type === "5" ? 0o755 : 0o644, e.name);
    assert.deepEqual([e.uid, e.gid, e.mtime, e.uname, e.gname], [0, 0, 0, "", ""], e.name);
    assert.ok(e.name.startsWith("plur1bus/"), e.name);
    assert.ok(!e.name.startsWith("/") && !e.name.split("/").includes(".."), e.name);
    for (const part of e.name.split("/").filter(Boolean)) {
      assert.ok(!part.startsWith("."), e.name);
      assert.ok(!["__pycache__", "tests", "test"].includes(part), e.name);
      assert.ok(!/\.py[co]$/.test(part), e.name);
    }
  }
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), "entries sorted");
  assert.equal(new Set(names.map((s) => s.toLowerCase())).size, names.length, "no case-fold duplicates");
  // Parents come before children.
  for (const nm of names) {
    const parent = nm.replace(/[^/]+\/?$/, "");
    if (parent) assert.ok(names.indexOf(parent) > -1 && names.indexOf(parent) < names.indexOf(nm), nm);
  }
});

test("a planted __pycache__, dotfile and tests dir are left out and a symbolic link fails the build", () => {
  const root = fresh();
  const provider = join(root, "provider");
  cpSync(SRC.provider, provider, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  mkdirSync(join(provider, "__pycache__"));
  writeFileSync(join(provider, "__pycache__", "x.cpython-311.pyc"), "x");
  writeFileSync(join(provider, ".DS_Store"), "x");
  mkdirSync(join(provider, "tests"));
  writeFileSync(join(provider, "tests", "test_x.py"), "x");
  writeFileSync(join(provider, "stray.pyc"), "x");
  const src = { ...SRC, provider };
  const r = buildProvider({ out: join(root, "out"), src });
  assert.ok(readFileSync(r.path).equals(readFileSync(built.path)), "planted files change nothing");
  symlinkSync("mapping.py", join(provider, "link.py"));
  assert.throws(() => buildProvider({ out: join(root, "out2"), src }), /symbolic link/);
});

test("MANIFEST.json hashes match every file", () => {
  const manifest = JSON.parse(files.get("plur1bus/MANIFEST.json").toString("utf8"));
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.version, VERSION);
  const listed = Object.keys(manifest.files);
  assert.deepEqual(listed, [...listed].sort());
  const others = [...files.keys()].filter((p) => p !== "plur1bus/MANIFEST.json").sort();
  assert.deepEqual(listed, others, "every file but MANIFEST.json, nothing else");
  for (const p of listed) assert.equal(manifest.files[p], sha256(files.get(p)), p);
});

test("the licence ships in the tarball and in the client package, equal to the repository LICENSE", () => {
  const license = readFileSync(join(REPO, "LICENSE"));
  assert.ok(files.get("plur1bus/LICENSE").equals(license));
  const pkg = join(REPO, "clients/python/plur1bus-memory-client");
  assert.ok(readFileSync(join(pkg, "LICENSE")).equals(license), "clients/python/plur1bus-memory-client/LICENSE is a copy of LICENSE");
  assert.match(readFileSync(join(pkg, "pyproject.toml"), "utf8"), /^license-files = \["LICENSE"\]$/m);
});

test("versions agree across Cargo.toml, pyproject.toml and plugin.yaml", () => {
  const cargo = readFileSync(SRC.cargo, "utf8").match(/^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms)[1];
  const py = readFileSync(SRC.pyproject, "utf8").match(/^\[project\][^[]*?^version = "([^"]+)"/ms)[1];
  const yaml = readFileSync(join(SRC.provider, "plugin.yaml"), "utf8").match(/^version: (\S+)$/m)[1];
  const init = readFileSync(join(SRC.client, "__init__.py"), "utf8").match(/^__version__ = "([^"]+)"/m)[1];
  assert.deepEqual([py, yaml, init], [cargo, cargo, cargo]);
  assert.equal(VERSION, cargo);
  // A disagreeing copy fails the build and names the file.
  const root = fresh();
  const plugin = join(root, "provider");
  cpSync(SRC.provider, plugin, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  writeFileSync(join(plugin, "plugin.yaml"), readFileSync(join(plugin, "plugin.yaml"), "utf8").replace(/^version: .*$/m, "version: 9.9.9"));
  assert.throws(() => buildProvider({ out: join(root, "out"), src: { ...SRC, provider: plugin } }), /version mismatch.*plugin\.yaml has 9\.9\.9/);
  assert.throws(() => buildProvider({ out: join(root, "out"), expectVersion: "9.9.9" }), /--expect-version 9\.9\.9/);
  assert.equal(buildProvider({ out: join(root, "ok"), expectVersion: `v${VERSION}` }).version, VERSION);
});

function python() {
  for (const c of process.platform === "win32" ? ["py", "python"] : ["python3", "python"]) {
    const r = spawnSync(c, [...(c === "py" ? ["-3"] : []), "-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return c === "py" ? ["py", "-3"] : [c];
  }
  return null;
}

test("the extracted tarball imports the vendored client under a synthetic package name (F13)", (t) => {
  const py = python();
  if (!py) return t.skip("no Python >= 3.11");
  const root = fresh();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const tgz = join(root, "p.tar.gz");
  writeFileSync(tgz, readFileSync(built.path));
  const plugins = join(root, "plugins");
  // Mirrors Hermes' loader: the directory is imported as a package with a synthetic name; only the Hermes stub for
  // agent.memory_provider is on sys.path, the client's source tree is not (-I also drops PYTHONPATH and user site).
  const code = `
import importlib.util, json, os, sys, tarfile
tgz, plugins, stubs = sys.argv[1:4]
with tarfile.open(tgz) as tf:
    tf.extractall(plugins, filter="data")
sys.path.insert(0, stubs)
d = os.path.join(plugins, "plur1bus")
spec = importlib.util.spec_from_file_location("_hermes_user_memory.plur1bus__source_test", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
import types; sys.modules["_hermes_user_memory"] = types.ModuleType("_hermes_user_memory")
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
c = sys.modules[spec.name + "._client"]
print(json.dumps({"vendored": c.VENDORED, "file": os.path.relpath(c.pmc.__file__, d).replace(os.sep, "/"), "version": c.pmc.__version__, "top": "plur1bus_memory_client" in sys.modules, "register": callable(getattr(m, "register", None))}))
`;
  const env = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: "1" };
  const r = spawnSync(py[0], [...py.slice(1), "-I", "-c", code, tgz, plugins, join(REPO, "hosts/hermes/tests/stubs")], { encoding: "utf8", env, cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    vendored: true,
    file: "_vendor/plur1bus_memory_client/__init__.py",
    version: VERSION,
    top: false,
    register: true,
  });
});

test("the lock seed carries real hashes, nodeVersion from the harness pin and placeholder false (F31, F33)", () => {
  const art = fresh();
  mkdirSync(art);
  writeFileSync(join(art, built.name), readFileSync(built.path));
  for (const t of TARGETS) writeFileSync(join(art, binaryName(t)), `binary ${t}`);
  const lock = buildLock({ artifacts: art, baseUrl: "https://example.invalid/releases/v1/" });
  const pin = readFileSync(join(REPO, "crates/plur1bus/src/install/pins.rs"), "utf8").match(/NODE_VERSION: &str = "([^"]+)"/)[1];
  assert.equal(lock.placeholder, false);
  assert.equal(lock.nodeVersion, pin);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.harnessTag, `v${VERSION}`);
  assert.equal(lock.minHermesVersion, "0.21.4");
  assert.deepEqual(lock.provider, { url: `https://example.invalid/releases/v1/${built.name}`, sha256: built.sha256 });
  assert.deepEqual(Object.keys(lock.binary), TARGETS);
  assert.equal(lock.binary["win-arm64"].url, "https://example.invalid/releases/v1/plur1bus-win-arm64.exe");
  assert.equal(lock.binary["linux-x64"].sha256, sha256(Buffer.from("binary linux-x64")));
  for (const e of [lock.provider, ...Object.values(lock.binary)]) assert.match(e.sha256, /^[0-9a-f]{64}$/);
  rmSync(join(art, "plur1bus-darwin-arm64"));
  assert.throws(() => buildLock({ artifacts: art, baseUrl: "https://example.invalid" }), /plur1bus-darwin-arm64 is missing/);
});

// ---- the release workflows (F7, F8; review finding 1): line scans, no YAML parser -------------------------------

const readWf = (name) => readFileSync(join(REPO, ".github/workflows", name), "utf8").replace(/\r\n/g, "\n");
const WF = readWf("harness-release.yml");
const RELEASE = readWf("release.yml");

/** The lines of top-level job `name` (two-space indent) up to the next job. */
function job(name, wf = WF) {
  const lines = wf.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start > 0, `job ${name} exists`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  return lines.slice(start, end);
}
const code = (wf) => wf.split("\n").filter((l) => !/^\s*#/.test(l));
const SHA_USES = /uses: [\w.-]+\/[\w.-]+(\/[\w.-]+)*@[0-9a-f]{40} # v\d+(\.\d+)*$/;
const usesLines = (lines) => lines.filter((l) => /^\s*(- )?uses:/.test(l));

test("harness-release.yml parses, pins every action by SHA and lists the three new files in SHA256SUMS", () => {
  // "Parses": tabs are illegal YAML indentation; every job line is inside the jobs map.
  assert.ok(!/\t/.test(WF), "no tabs");
  assert.match(WF, /^permissions:\n {2}contents: read\n/m, "workflow-wide permissions stay read-only");
  // A called workflow's job permissions are checked against the caller's grant before any job `if`, so no job here
  // may ask for more than contents: read (dry runs and callers without OIDC would fail at startup).
  for (const l of code(WF)) assert.ok(!/^\s+(id-token|attestations|packages|actions|pull-requests|issues|deployments|statuses|checks|security-events|pages|discussions|repository-projects):/.test(l), `harness-release requests no extra permission: ${l.trim()}`);
  for (const l of code(WF)) assert.ok(!/^\s+contents: write/.test(l), l.trim());
  assert.ok(!code(WF).some((l) => /attest-build-provenance/.test(l)), "no attestation inside the called workflow");
  const hermes = job("hermes-artefacts");
  const uses = usesLines(hermes);
  assert.ok(uses.length >= 4, "checkout, setup-node, setup-python, upload");
  for (const l of uses) assert.match(l, SHA_USES, l.trim());
  const text = hermes.join("\n");
  assert.match(text, /\n {4}permissions:\n {6}contents: read\n {4}env:/, "job-scoped read-only permissions");
  assert.match(text, /runs-on: ubuntu-24\.04\n/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /node scripts\/build-hermes-provider\.mjs --out /);
  assert.match(text, /--require-hashes -r clients\/python\/plur1bus-memory-client\/requirements-dev\.txt/);
  assert.match(text, / -m build --no-isolation --outdir hermes clients\/python\/plur1bus-memory-client\n/);
  const v = "${VERSION}";
  for (const f of [tarballName(v), wheelName(v), sdistName(v)]) assert.ok(text.includes(f), `hermes-artefacts names ${f}`);
  assert.match(text, /name: hermes-artefacts\n/, "uploads artefact hermes-artefacts");
  assert.ok(!/pypi|twine|upload-pypi/i.test(text), "nothing goes to PyPI");
  // A direct dispatch may only dry-run; a real run goes through release.yml, which attests.
  const meta = job("meta").join("\n");
  assert.match(meta, /DRY_RUN: \$\{\{ inputs\.dry-run \}\}/);
  assert.match(meta, /if \[ -z "\$INPUT_VERSION" \] && \[ "\$DRY_RUN" != true \]; then\n\s+echo "::error::a real release runs through release\.yml/);

  const native = job("native").join("\n");
  assert.match(native, /needs: \[meta, payload, binary, sign-macos, hermes-artefacts\]/);
  assert.match(native, /needs\.hermes-artefacts\.result == 'success'/);
  const sums = native.split("\n").find((l) => l.includes("> SHA256SUMS"));
  assert.ok(sums, "SHA256SUMS line");
  for (const glob of ["plur1bus-*", "plur1bus_memory_client-*", "hermes-sidecar.lock.json"]) assert.ok(sums.includes(glob), `SHA256SUMS covers ${glob}`);
  assert.match(native, /node scripts\/build-hermes-provider\.mjs lock --artifacts artifacts /);
  for (const p of ["artifacts/plur1bus_memory_client-*", "artifacts/hermes-sidecar.lock.json"]) assert.ok(native.includes(p), `uploaded: ${p}`);
  // New steps in `native` are SHA-pinned too; the old tag pins are left as they are (F7).
  const i = native.indexOf("name: hermes-artefacts");
  assert.ok(i > 0, "native downloads the hermes-artefacts artefact");
  assert.match(native.slice(native.lastIndexOf("uses:", i), i), /@[0-9a-f]{40} # v/);
});

test("release.yml is the real-release entry point and its attest job alone holds the attestation permissions", () => {
  assert.ok(!/\t/.test(RELEASE), "no tabs");
  assert.match(RELEASE, /^on:\n {2}workflow_dispatch:\n/m, "dispatched only");
  assert.ok(!/workflow_call|pull_request|push:|schedule:/.test(code(RELEASE).join("\n")), "no other trigger");
  assert.ok(!/dry-run: true|dry-run: \$\{\{/.test(RELEASE), "no dry-run path through the attesting caller");
  assert.match(RELEASE, /^permissions:\n {2}contents: read\n/m);
  const harness = job("harness", RELEASE).join("\n");
  assert.match(harness, /\n {4}permissions:\n {6}contents: read\n {4}uses: \.\/\.github\/workflows\/harness-release\.yml\n/);
  assert.match(harness, /\n {6}dry-run: false\n/);
  const attest = job("attest", RELEASE);
  const at = attest.join("\n");
  assert.match(at, /needs: harness\n/);
  assert.match(at, /\n {4}permissions:\n {6}contents: read\n {6}id-token: write\n {6}attestations: write\n {4}steps:/);
  for (const l of usesLines(attest)) assert.match(l, SHA_USES, l.trim());
  assert.ok(usesLines(attest).some((l) => /actions\/attest-build-provenance@/.test(l)), "attestation step");
  assert.match(at, /name: hermes-artefacts\n/, "downloads the hermes-artefacts artefact");
  const subject = at.slice(at.indexOf("attest-build-provenance@"));
  for (const glob of ["plur1bus-hermes-provider-*.tar.gz", "plur1bus_memory_client-*.whl", "plur1bus_memory_client-*.tar.gz"]) {
    assert.ok(subject.includes(glob), `attested: ${glob}`);
  }
  // Only the attest job asks for id-token or attestations.
  const holders = code(RELEASE).map((l, n) => [l, n]).filter(([l]) => /^\s+(id-token|attestations): write/.test(l));
  assert.equal(holders.length, 2);
  const lines = RELEASE.split("\n");
  const attestStart = lines.indexOf("  attest:");
  for (const [l] of holders) assert.ok(lines.indexOf(l, attestStart) > attestStart, l);
  // The requirement is documented.
  const doc = readFileSync(join(REPO, "docs/manual-release.md"), "utf8");
  assert.match(doc, /release\.yml/);
  assert.match(doc, /id-token: write/);
  assert.match(WF, /^# .*release\.yml/m);
});

test("the client sdist ships no tests (MANIFEST.in)", () => {
  const m = readFileSync(join(REPO, "clients/python/plur1bus-memory-client/MANIFEST.in"), "utf8");
  assert.match(m, /^prune tests$/m);
});

test("the root lint script runs this test (F8)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.match(pkg.scripts.lint, /node --test [^&]*scripts\/build-hermes-provider\.test\.mjs/);
  assert.equal(pkg.scripts["build:hermes"], "node scripts/build-hermes-provider.mjs --out dist/hermes");
});

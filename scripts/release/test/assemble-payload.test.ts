// assemble-payload.mjs (2a-H3b-b Task 10, HB18): the per-target core payload `core-<ver>-<target>.tar.gz` that
// `setup` installs to `runtime/core`. The deployed tree comes from a fixture here (the workflow runs the real
// `pnpm deploy`). Names, types, modes and contents are read from the archive's own headers (`readTar`, platform
// independent: Windows has no exec bit and bsdtar prints CRLF); the system `tar` lists it too, as an independent reader
// of the same ustar/pax format the Rust extractor (`install::archive`) reads.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error: a plain .mjs script without type declarations
import { assemble, deployParent, readEngineContract, unresolvedDependencies, writeTarGz } from "../assemble-payload.mjs";

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const put = (p: string, body: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const WIN = process.platform === "win32";
type TarEntry = { name: string; type: string; mode: number; data: Buffer };
/** Every entry of a `.tar.gz` as its headers record it (ustar plus pax `path`/`linkpath` records). Directory names
 *  lose their trailing `/`. */
function readTar(archive: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(archive));
  const out: TarEntry[] = [];
  const str = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
  let pax: Record<string, string> = {};
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = Number.parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = {};
      for (const rec of data.toString("utf8").split("\n").filter(Boolean)) {
        const kv = rec.slice(rec.indexOf(" ") + 1);
        pax[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
      }
      continue;
    }
    const prefix = str(h.subarray(345, 500));
    const name = pax.path ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    out.push({ name: name.replace(/\/$/, ""), type, mode: Number.parseInt(str(h.subarray(100, 108)).trim(), 8), data: Buffer.from(data) });
    pax = {};
  }
  return out;
}
/** The system `tar`'s listing (bsdtar on Windows prints CRLF). */
function systemList(archive: string): string[] {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim().replace(/\/$/, "")).filter(Boolean);
}
function list(archive: string): string[] {
  return readTar(archive).map((e) => e.name);
}
function entry(archive: string, name: string): TarEntry {
  const e = readTar(archive).find((x) => x.name === name);
  assert.ok(e, `${name} in the archive`);
  return e;
}
/** A fake `pnpm deploy --prod` tree of the core. */
function deployed(root: string): string {
  const d = join(root, "deployed");
  put(join(d, "package.json"), JSON.stringify({ name: "@plur1bus/core", version: "0.1.0", type: "module" }));
  put(join(d, "src/core.ts"), "// source, not shipped");
  put(join(d, "test/x.test.ts"), "// test, not shipped");
  put(join(d, "dist/core.js"), "#!/usr/bin/env node\n");
  put(join(d, "dist/agent-templates/AGENTS.md"), "# template");
  put(join(d, "node_modules/@cyb3rb1ade/plur1bus-memory/engine/create-engine.js"), 'const x = {\n    contract: "1.9.0",\n};\nconst y = { contract: "1.9.0" };\n');
  put(join(d, "node_modules/@plur1bus/rpc-schema/schema/rpc.schema.json"), JSON.stringify({ "x-rpc-version": "1.3.0" }));
  put(join(d, "node_modules/semver/bin/semver.js"), "#!/usr/bin/env node\n");
  mkdirSync(join(d, "node_modules/.bin"), { recursive: true });
  // pnpm writes links on unix and `.cmd` shims on Windows; `.bin` is skipped either way.
  if (WIN) put(join(d, "node_modules/.bin/semver.cmd"), "@node ..\\semver\\bin\\semver.js %*");
  else symlinkSync("../semver/bin/semver.js", join(d, "node_modules/.bin/semver"));
  return d;
}

describe("assemble-payload", () => {
  it("reads the engine contract and refuses an ambiguous one", () => {
    assert.equal(readEngineContract('a\n    contract: "1.9.0",\nb contract: "1.9.0"'), "1.9.0");
    assert.throws(() => readEngineContract('contract: "1.9.0" contract: "1.8.0"'), /ambiguous/);
    assert.throws(() => readEngineContract("nothing here"), /not found/);
  });

  it("deploys on the workspace's own volume: pnpm's hoisted linker breaks across Windows drives (HM2 CI round 2)", () => {
    // windows-2025: the checkout on D:, %TEMP% on C: gave `mkdir 'D:\\a\\...\\C:\\Users\\...\\node_modules\\@plur1bus'`.
    assert.equal(deployParent("D:\\a\\repo\\repo", "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp", "win32"), "D:\\a\\repo\\repo\\target");
    assert.equal(deployParent("D:\\a\\repo", "d:\\a\\_temp", "win32"), "d:\\a\\_temp", "the same drive in another case");
    assert.equal(deployParent("C:\\src\\repo", "C:\\Temp", "win32"), "C:\\Temp");
    assert.equal(deployParent("\\\\srv\\share\\repo", "C:\\Temp", "win32"), "\\\\srv\\share\\repo\\target", "a UNC checkout");
    assert.equal(deployParent("/home/u/repo", "/tmp", "linux"), "/tmp", "one POSIX tree has no drives");
  });

  it("writes a deterministic tar.gz with long names, modes and no links", async () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-tar-"));
    try {
      const src = join(root, "src");
      // Over 100 bytes (a pax record), short enough for a Windows temp path.
      const long = `node_modules/${"a".repeat(35)}/${"b".repeat(35)}/${"c".repeat(35)}/index.js`;
      put(join(src, long), "long");
      put(join(src, "bin/run"), "#!/bin/sh\n");
      if (!WIN) chmodSync(join(src, "bin/run"), 0o755);
      mkdirSync(join(src, "empty"));
      const a = join(root, "a.tar.gz");
      const b = join(root, "b.tar.gz");
      await writeTarGz(src, a);
      put(join(src, "node_modules/.modules.yaml"), "changed install time and store path");
      put(join(src, ".pnpm-workspace-state-v1.json"), "changed install timestamp");
      await writeTarGz(src, b);
      assert.equal(sha(a), sha(b), "same tree, same bytes");
      const entries = readTar(a);
      const names = entries.map((e) => e.name);
      assert.ok(names.includes(long), `long name kept: ${names.join(", ")}`);
      assert.equal(entry(a, long).data.toString("utf8"), "long");
      assert.equal(entry(a, "empty").type, "5");
      assert.deepEqual(systemList(a).sort(), [...names].sort(), "the system tar reads the same entries");
      for (const e of entries) {
        assert.ok(e.type === "0" || e.type === "5", `${e.name}: only files and directories (type ${e.type})`);
        // Modes as the archive carries them: directories 0755; files 0644, or 0755 where the file system has an exec
        // bit (not on Windows, where the builder records none).
        const exec = e.name === "bin/run" && !WIN;
        assert.equal(e.mode, e.type === "5" || exec ? 0o755 : 0o644, `${e.name} mode ${e.mode.toString(8)}`);
      }
      if (!WIN) {
        // A symlink outside node_modules/.bin is refused: the Rust extractor cannot create links on Windows.
        symlinkSync("run", join(src, "bin/link"));
        await assert.rejects(writeTarGz(src, join(root, "c.tar.gz")), /symlink/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assembles the payload: core.js at the root, stamped package.json, skills, modules, checksum and metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-asm-"));
    try {
      const skills = join(root, "skills");
      put(join(skills, "plur1bus-ops/SKILL.md"), "# ops");
      const out = join(root, "dist/core-0.2.0-linux-x64.tar.gz");
      const meta = await assemble({ target: "linux-x64", out, deployed: deployed(root), skills, modules: join(root, "no-modules") });
      assert.deepEqual(meta, { target: "linux-x64", core: { version: "0.1.0", contract: "1.9.0", rpc: "1.3.0" }, modules: [] });
      assert.deepEqual(JSON.parse(readFileSync(out.replace(/\.tar\.gz$/, ".json"), "utf8")), meta);
      assert.equal(readFileSync(`${out}.sha256`, "utf8"), `${sha(out)}  core-0.2.0-linux-x64.tar.gz\n`);

      const names = list(out);
      for (const n of ["core.js", "agent-templates/AGENTS.md", "package.json", "skills/plur1bus-ops/SKILL.md", "modules", "node_modules/semver/bin/semver.js"]) {
        assert.ok(names.includes(n), `${n} in ${names.join(", ")}`);
      }
      for (const n of names) assert.ok(!/^(src|test|dist)(\/|$)/.test(n) && !n.includes(".bin"), `${n} is not shipped`);
      for (const e of readTar(out)) assert.ok(e.type === "0" || e.type === "5", `${e.name}: no links (type ${e.type})`);
      assert.deepEqual(systemList(out).sort(), [...names].sort(), "the system tar reads the same entries");
      const pkg = JSON.parse(entry(out, "package.json").data.toString("utf8"));
      assert.deepEqual(pkg.plur1bus, { contract: "1.9.0", rpc: "1.3.0" }, "setup reads the contract and rpc from here");
      assert.equal(pkg.version, "0.1.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a deployed tree whose workspace packages resolve their deps only through links (CI round 1)", async () => {
    // windows-2025: setup's copy of a plain (isolated) `pnpm deploy` tree failed with ERR_MODULE_NOT_FOUND 'ajv'
    // imported from node_modules/@plur1bus/config-schema/dist/index.js. In that layout ajv sits next to the package's
    // real path under .pnpm, which only a link reaches; installed without links, Node's lookup from the package's own
    // directory up to the payload root never finds it.
    const root = mkdtempSync(join(tmpdir(), "p1b-res-"));
    try {
      const workspacePkg = (d: string) => {
        put(join(d, "node_modules/@plur1bus/config-schema/package.json"), JSON.stringify({ name: "@plur1bus/config-schema", type: "module", dependencies: { ajv: "8.20.0" } }));
        put(join(d, "node_modules/@plur1bus/config-schema/dist/index.js"), 'import Ajv from "ajv";\nimport { readFileSync } from "node:fs";\nimport "./local.js";\nexport const msg = "please import \\", \\" here";\n');
      };
      const isolated = deployed(join(root, "isolated"));
      workspacePkg(isolated);
      put(join(isolated, "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/package.json"), JSON.stringify({ name: "ajv" }));
      const missing = unresolvedDependencies(isolated);
      assert.deepEqual(
        missing.map((m: { from: string; name: string }) => `${m.name} <- ${m.from}`).sort(),
        ["ajv <- node_modules/@plur1bus/config-schema", "ajv <- node_modules/@plur1bus/config-schema/dist/index.js"],
        "the declared dependency and the import both, and nothing for node:, relative or string text",
      );
      await assert.rejects(
        assemble({ target: "win-x64", out: join(root, "bad.tar.gz"), deployed: isolated, skills: join(root, "no-skills"), modules: join(root, "no-modules") }),
        /does not resolve without links: ajv \(from node_modules\/@plur1bus\/config-schema/,
      );

      // The hoisted layout harness-release deploys (--config.node-linker=hoisted): ajv at the root resolves.
      const hoisted = deployed(join(root, "hoisted"));
      workspacePkg(hoisted);
      put(join(hoisted, "node_modules/ajv/package.json"), JSON.stringify({ name: "ajv" }));
      assert.deepEqual(unresolvedDependencies(hoisted), []);
      await assemble({ target: "win-x64", out: join(root, "ok.tar.gz"), deployed: hoisted, skills: join(root, "no-skills"), modules: join(root, "no-modules") });

      // A dependency the root package declares is checked from the root, and a nested copy satisfies its owner only.
      put(join(hoisted, "package.json"), JSON.stringify({ name: "@plur1bus/core", version: "0.1.0", type: "module", dependencies: { "left-pad": "1" } }));
      put(join(hoisted, "node_modules/@plur1bus/config-schema/node_modules/left-pad/package.json"), JSON.stringify({ name: "left-pad" }));
      assert.deepEqual(unresolvedDependencies(hoisted), [{ from: ".", name: "left-pad" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the bundled modules and refuses an unknown target", async () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-asm-"));
    try {
      const modules = join(root, "modules");
      put(join(modules, "fixture/module.json"), JSON.stringify({ name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js" }));
      put(join(modules, "fixture/index.js"), "");
      const out = join(root, "core-0.2.0-win-x64.tar.gz");
      const meta = await assemble({ target: "win-x64", out, deployed: deployed(root), skills: join(root, "no-skills"), modules });
      assert.deepEqual(meta.modules, [{ name: "fixture", version: "0.1.0", apiVersion: "1" }]);
      assert.ok(list(out).includes("modules/fixture/module.json"));
      const intel = await assemble({ target: "darwin-x64", out: join(root, "intel.tar.gz"), deployed: deployed(join(root, "intel")), skills: join(root, "no-skills"), modules: join(root, "no-modules") });
      assert.equal(intel.target, "darwin-x64");
      await assert.rejects(assemble({ target: "linux-riscv64", out: join(root, "y.tar.gz"), deployed: deployed(join(root, "other")) }), /not a release target/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

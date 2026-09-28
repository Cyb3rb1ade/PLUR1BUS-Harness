// release-native.mjs (2a-H3b-b Task 10, HB18): the `native` object of D78's release.json, built from the release
// artefacts of the five targets and validated against release-manifest.schema.json's `native` definition.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error: a plain .mjs script without type declarations
import { TARGETS, binaryName, buildNative, payloadName, validateNative } from "../release-native.mjs";

const SCRIPT = resolve("scripts/release/release-native.mjs");
const VERSION = "0.2.0";
const BASE = "https://example.invalid/releases/download/v0.2.0";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A fake artefact directory: a binary, a payload and its metadata for every target in `targets`. */
function artefacts(targets: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "p1b-rel-"));
  for (const t of targets) {
    writeFileSync(join(dir, binaryName(t)), `fake binary ${t}`);
    const payload = payloadName(VERSION, t);
    writeFileSync(join(dir, payload), `fake payload ${t}`);
    writeFileSync(join(dir, `${payload}.sha256`), `${sha(`fake payload ${t}`)}  ${payload}\n`);
    const meta = { target: t, core: { version: "0.1.0", contract: "1.9.0", rpc: "1.3.0" }, modules: [{ name: "fixture", version: "0.1.0", apiVersion: "1" }] };
    writeFileSync(join(dir, payload.replace(/\.tar\.gz$/, ".json")), JSON.stringify(meta));
  }
  return dir;
}

describe("release-native", () => {
  it("builds the native object for five targets and validates it", async () => {
    assert.deepEqual(TARGETS, ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"]);
    const dir = artefacts(TARGETS);
    try {
      const native = await buildNative({ artifacts: dir, version: VERSION, baseUrl: BASE });
      assert.deepEqual(Object.keys(native.binary), TARGETS);
      assert.deepEqual(Object.keys(native.core.payload), TARGETS);
      assert.deepEqual(native.binary["win-x64"], { url: `${BASE}/plur1bus-win-x64.exe`, sha256: sha("fake binary win-x64") });
      assert.deepEqual(native.binary["linux-arm64"], { url: `${BASE}/plur1bus-linux-arm64`, sha256: sha("fake binary linux-arm64") });
      assert.deepEqual(native.core.payload["darwin-arm64"], { url: `${BASE}/core-0.2.0-darwin-arm64.tar.gz`, sha256: sha("fake payload darwin-arm64") });
      assert.equal(native.core.version, "0.1.0");
      assert.equal(native.core.contract, "1.9.0");
      assert.equal(native.core.rpc, "1.3.0");
      // The pinned Node (crates/plur1bus/src/install/pins.rs) and the config schema's version, read from the tree.
      assert.equal(native.node.version, "24.21.0");
      assert.equal(native.configSchemaVersion, 1);
      assert.deepEqual(native.modules, [{ name: "fixture", version: "0.1.0", apiVersion: "1" }]);
      assert.deepEqual(validateNative(native), []);
      // The schema is strict: an extra key fails validation.
      assert.notDeepEqual(validateNative({ ...native, extra: true }), []);

      // The CLI writes the same object (atomically) and exits 0.
      const out = join(dir, "release-native.json");
      execFileSync(process.execPath, [SCRIPT, "--artifacts", dir, "--version", VERSION, "--base-url", BASE, "--out", out], { stdio: "pipe" });
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), native);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a target without a payload", async () => {
    const dir = artefacts(TARGETS);
    try {
      rmSync(join(dir, payloadName(VERSION, "win-arm64")));
      await assert.rejects(buildNative({ artifacts: dir, version: VERSION, baseUrl: BASE }), /win-arm64: no core payload/);
      const out = join(dir, "release-native.json");
      assert.throws(
        () => execFileSync(process.execPath, [SCRIPT, "--artifacts", dir, "--version", VERSION, "--base-url", BASE, "--out", out], { stdio: "pipe" }),
        (e: any) => e.status === 1 && /win-arm64: no core payload/.test(String(e.stderr)),
      );
      assert.throws(() => readFileSync(out), "nothing written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a payload whose .sha256 does not match and targets that disagree on the core", async () => {
    const dir = artefacts(TARGETS);
    try {
      const p = payloadName(VERSION, "linux-x64");
      writeFileSync(join(dir, `${p}.sha256`), `${"0".repeat(64)}  ${p}\n`);
      await assert.rejects(buildNative({ artifacts: dir, version: VERSION, baseUrl: BASE }), /linux-x64: .*sha256/);
      writeFileSync(join(dir, `${p}.sha256`), `${sha("fake payload linux-x64")}  ${p}\n`);
      const metaPath = join(dir, p.replace(/\.tar\.gz$/, ".json"));
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.core.contract = "1.8.0";
      writeFileSync(metaPath, JSON.stringify(meta));
      await assert.rejects(buildNative({ artifacts: dir, version: VERSION, baseUrl: BASE }), /disagree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a target without a binary", async () => {
    const dir = artefacts(TARGETS);
    try {
      rmSync(join(dir, binaryName("darwin-arm64")));
      await assert.rejects(buildNative({ artifacts: dir, version: VERSION, baseUrl: BASE }), /darwin-arm64: no binary/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

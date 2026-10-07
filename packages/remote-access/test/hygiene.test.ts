import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Work-package rules turned into checks: no shell-outs (no OpenSSL through a shell), no files written by the
// library itself (private keys leave the module only through the SecretPort), no network except node:tls/node:net
// primitives, and no runtime dependency in package.json.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

test("the library has source files to check", () => {
  assert.ok(files.length >= 8, `found ${files.length}`);
});

test("no source file imports child_process, fs, http(s) or dns, or names openssl", () => {
  const banned = /from\s+["'](?:node:)?(?:child_process|fs|fs\/promises|http|https|http2|dns|dgram|worker_threads|vm)["']|require\(|\bopenssl\b|process\.env/i;
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8");
    assert.ok(!banned.test(text), `${f} uses a banned module or name`);
  }
});

test("package.json declares no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as Record<string, unknown>;
  assert.equal(pkg["dependencies"], undefined);
  assert.equal(pkg["optionalDependencies"], undefined);
  assert.equal(pkg["peerDependencies"], undefined);
});

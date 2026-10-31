import { limitsHelper } from "./fixture.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DESCRIPTORS, discoverConnectors } from "../../src/external-agents/discovery.ts";
import { CONNECTORS } from "../../src/external-agents/engine.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const SECRET = "CREDENTIAL-BODY-SHOULD-NOT-APPEAR";

test("descriptors cover the four connectors and do not read login files", async () => {
  assert.deepEqual(DESCRIPTORS.map((d) => d.id), [...CONNECTORS]);
  assert.equal(DESCRIPTORS.find((d) => d.id === "goose")?.effort, "gated");
  assert.equal(DESCRIPTORS.find((d) => d.id === "agy")?.effort, "best-effort");
  const root = tempDir("m6b-discover-");
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".config", "goose"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), SECRET, { mode: 0o600 });
  const bin = join(binDir, "agy");
  mkdirSync(binDir);
  writeFileSync(bin, `#!${process.execPath}
const secret = process.env.SUPER_SECRET ? "LEAKED" : "stub 1";
if (process.argv.includes("--version")) { process.stdout.write(secret + "\\n"); process.exit(0); }
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
    process.exit(0);
  }
});
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const previous = process.env.SUPER_SECRET;
  process.env.SUPER_SECRET = "hunter2";
  try {
    const found = await discoverConnectors({ home, limitsHelper, pathEnv: binDir, env: process.env, timeoutMs: 5_000 });
    assert.equal(JSON.stringify(found).includes(SECRET), false);
    const codex = found.find((c) => c.id === "codex");
    assert.equal(codex?.bin, null);
    assert.equal(codex?.login[0]?.exists, true);
    assert.equal(typeof codex?.login[0]?.mode, "number");
    assert.equal(found.find((c) => c.id === "goose")?.login[0]?.exists, true);
    const hit = found.find((c) => c.id === "agy");
    assert.equal(hit?.bin, bin);
    assert.equal(hit?.version, "stub 1");
    assert.equal(hit?.protocol, "ok");
    assert.equal(hit?.effort, "best-effort");
    const win = await discoverConnectors({ home, pathEnv: binDir, platform: "win32" });
    assert.equal(win.find((c) => c.id === "agy")?.reason, "sandbox-unavailable");
    assert.equal(win.find((c) => c.id === "agy")?.protocol, "unprobed");
  } finally {
    if (previous === undefined) delete process.env.SUPER_SECRET;
    else process.env.SUPER_SECRET = previous;
  }
});

test("login discovery never opens FIFO or mode-000 credential contents", async () => {
  const root = tempDir("acp-login-metadata-");
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), SECRET, { mode: 0 });
  if (process.platform !== "win32") {
    const { execFileSync } = await import("node:child_process");
    mkdirSync(join(root, ".claude"));
    execFileSync("mkfifo", [join(root, ".claude", ".credentials.json")]);
  }
  const found = await discoverConnectors({ home: root, pathEnv: "" });
  assert.equal(found.find(row => row.id === "codex")?.login[0]?.exists, true);
  assert.doesNotMatch(JSON.stringify(found), new RegExp(SECRET));
});

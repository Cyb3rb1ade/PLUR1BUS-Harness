import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { denyEntriesFor, looksLikeSecret, redactSecrets, redactText } from "../../src/host-tools/index.ts";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx } from "./helpers.ts";

describe("credential deny-list", () => {
  it("covers keychain, ssh, gnupg, cloud CLIs, dotenv names and D110 stores", () => {
    const posix = denyEntriesFor("/Users/alice", {}, "darwin");
    const names = posix.filter((e) => "name" in e).map((e) => e.name).sort();
    const paths = posix.filter((e) => "path" in e).map((e) => e.path);
    assert.ok(names.includes(".env"));
    assert.ok(names.includes(".ssh"));
    assert.ok(names.includes(".gnupg"));
    assert.ok(names.includes("auth.json"));
    assert.ok(names.includes("credentials"));
    assert.ok(paths.some((p) => p.includes("/.ssh")));
    assert.ok(paths.some((p) => p.includes("/.gnupg")));
    assert.ok(paths.some((p) => p.includes("/Library/Keychains")));
    assert.ok(paths.some((p) => p.includes("/.aws")));
    assert.ok(paths.some((p) => p.includes("/.codex")));
    assert.ok(paths.some((p) => p.includes("/.hermes")));
    assert.ok(paths.some((p) => /\/\.[oO].*claw/.test(p) || p.includes("penclaw")), "other-host credential dir");
  });

  it("expands CODEX_HOME, HERMES_HOME and Windows LocalAppData", () => {
    const win = denyEntriesFor("C:\\Users\\alice", {
      CODEX_HOME: "C:\\codex-home",
      HERMES_HOME: "C:\\hermes-home",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    }, "win32");
    const paths = win.filter((e) => "path" in e).map((e) => e.path);
    assert.ok(paths.some((p) => p.includes("codex-home")));
    assert.ok(paths.some((p) => p.includes("hermes-home")));
    assert.ok(paths.some((p) => /AppData/i.test(p) && /hermes/i.test(p)));
  });

  it("redacts token-shaped process arguments and deny-listed paths", () => {
    assert.equal(looksLikeSecret("sk-live-abcdefghijklmnopqrstuv"), true);
    assert.equal(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz123456"), true);
    assert.equal(looksLikeSecret("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb"), true);
    assert.equal(looksLikeSecret("node"), false);
    const line = redactSecrets("/usr/bin/node --token=sk-live-abcdefghijklmnopqrstuv /Users/alice/.ssh/id_ed25519", denyEntriesFor("/Users/alice", {}, "darwin"));
    assert.ok(!line.includes("sk-live"));
    assert.ok(!line.includes("id_ed25519") || line.includes("[redacted]"));
    assert.match(line, /\[redacted\]/);
  });

  it("redactText never returns the original secret", () => {
    assert.equal(redactText("pre ghp_abcdefghijklmnopqrstuvwxyz123456 post").includes("ghp_"), false);
  });

  it("apps.open of a deny-listed file is denied_by_denylist", async () => {
    const { ctx } = makeCtx("darwin");
    const r = await runHostTool("apps.open", { target: "/Users/alice/.ssh/id_ed25519", kind: "file" }, ctx);
    assert.equal(r.isError, true);
    if (r.isError) assert.equal(r.error.code, "denied_by_denylist");
  });
});

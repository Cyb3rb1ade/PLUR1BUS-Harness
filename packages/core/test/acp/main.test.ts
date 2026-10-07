import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { CoreClient } from "@plur1bus/module-api";
import { runAcpMain } from "../../src/acp/main.ts";

function io() {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let err = ""; stderr.on("data", (c) => { err += c; }); let out = ""; stdout.on("data", (c) => { out += c; });
  return { stdin, stdout, stderr, err: () => err, out: () => out };
}
const fakeClient = (calls: string[]): CoreClient => ({
  hello: {} as never, supports: () => true, onNotification: () => () => {}, onClose: () => () => {}, close: async () => { calls.push("close"); },
  call: (async (m: string) => { calls.push(m); return { session: { id: "ses_1" } }; }) as never,
});

describe("acp main", () => {
  it("missing arguments → exit 2, nothing on stdout", async () => {
    const t = io();
    assert.equal(await runAcpMain(["--home", "/x"], t as never, async () => { throw new Error("no"); }), 2);
    assert.equal(t.out(), "");
  });

  it("an unreachable core → exit 1 with a hint on stderr only", async () => {
    const t = io();
    const code = await runAcpMain(["--home", "/x", "--agent", "a", "--account", "h", "--user", "u"], t as never, async () => { throw new Error("ECONNREFUSED sk-secret"); });
    assert.equal(code, 1);
    assert.equal(t.out(), "");
    assert.match(t.err(), /cannot reach the core/);
    assert.doesNotMatch(t.err(), /sk-secret/, "only the error class is reported");
  });

  it("serves ACP on the given streams and closes the core connection when stdin ends", async () => {
    const t = io(); const calls: string[] = [];
    const p = runAcpMain(["--home", "/x", "--agent", "bernd", "--account", "h", "--user", "u"], t as never, async () => fakeClient(calls));
    t.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    t.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } })}\n`);
    t.stdin.end();
    assert.equal(await p, 0);
    const lines = t.out().trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((m) => m.id), [1, 2]);
    assert.equal(lines[1].result.sessionId, "ses_1");
    assert.deepEqual(calls, ["session.create", "close"]);
  });
});

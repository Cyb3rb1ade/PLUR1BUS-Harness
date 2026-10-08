import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CoreClient } from "@plur1bus/module-api";
import { runAcpMain } from "../../src/acp/main.ts";

function io() {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let err = ""; stderr.on("data", (c) => { err += c; }); let out = ""; stdout.on("data", (c) => { out += c; });
  return { stdin, stdout, stderr, err: () => err, out: () => out };
}
const fakeClient = (calls: { m: string; p: any }[], o: { closeFails?: boolean } = {}): CoreClient => ({
  hello: {} as never, supports: () => true, onNotification: () => () => {}, onClose: () => () => {},
  close: async () => { calls.push({ m: "close", p: null }); if (o.closeFails) throw new Error("already closed"); },
  call: (async (m: string, p: any) => { calls.push({ m, p }); return { session: { id: "ses_1" } }; }) as never,
});
const ARGS = ["--home", "/x", "--agent", "bernd", "--account", "acc", "--user", "u"];

describe("acp main coverage: usage errors (exit 2)", () => {
  const cases: { name: string; argv: string[]; match: RegExp }[] = [
    { name: "unknown option", argv: [...ARGS, "--bogus"], match: /^acp: / },
    { name: "positional argument", argv: [...ARGS, "extra"], match: /^acp: / },
    { name: "option without value", argv: ["--agent"], match: /^acp: / },
    { name: "no arguments", argv: [], match: /--agent, --account and --user are required/ },
    { name: "missing agent", argv: ["--account", "a", "--user", "u"], match: /required/ },
    { name: "missing account", argv: ["--agent", "a", "--user", "u"], match: /required/ },
    { name: "missing user", argv: ["--agent", "a", "--account", "a"], match: /required/ },
    { name: "empty agent", argv: ["--agent", "", "--account", "a", "--user", "u"], match: /required/ },
  ];
  for (const c of cases) {
    it(`${c.name} exits 2 and never connects`, async () => {
      const t = io(); let connected = 0;
      const code = await runAcpMain(c.argv, t as never, async () => { connected++; throw new Error("no"); });
      assert.equal(code, 2);
      assert.match(t.err(), c.match);
      assert.equal(t.out(), "");
      assert.equal(connected, 0);
    });
  }
});

describe("acp main coverage: connection", () => {
  it("passes the resolved home to the connector (--home wins)", async () => {
    const t = io(); const seen: string[] = [];
    await runAcpMain(ARGS, t as never, async (h) => { seen.push(h); throw new Error("stop"); });
    assert.deepEqual(seen, [path.resolve("/x")]);
  });
  it("without --home the default home is resolved", async () => {
    const t = io(); const seen: string[] = [];
    const prev = process.env.PLUR1BUS_HOME;
    process.env.PLUR1BUS_HOME = path.join(os.tmpdir(), "p1b-acp-main-home");
    try { await runAcpMain(["--agent", "a", "--account", "b", "--user", "c"], t as never, async (h) => { seen.push(h); throw new Error("stop"); }); }
    finally { if (prev === undefined) delete process.env.PLUR1BUS_HOME; else process.env.PLUR1BUS_HOME = prev; }
    assert.deepEqual(seen, [path.resolve(path.join(os.tmpdir(), "p1b-acp-main-home"))]);
  });
  it("a connector failure reports only the error class; a non-Error throw is reported as error", async () => {
    const t = io();
    class WeirdError extends Error { constructor() { super("secret-token"); this.name = "WeirdError"; } }
    assert.equal(await runAcpMain(ARGS, t as never, async () => { throw new WeirdError(); }), 1);
    assert.match(t.err(), /\(WeirdError\)/);
    assert.doesNotMatch(t.err(), /secret-token/);
    const t2 = io();
    assert.equal(await runAcpMain(ARGS, t2 as never, async () => { throw "plain"; }), 1);
    assert.match(t2.err(), /\(error\)/);
    assert.match(t2.err(), /plur1bus daemon start/);
  });
  it("the default connector fails cleanly (exit 1) on a home without a running core", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p1b-acp-main-"));
    try {
      const t = io();
      const code = await runAcpMain(["--home", dir, "--agent", "a", "--account", "b", "--user", "c"], t as never);
      assert.equal(code, 1);
      assert.match(t.err(), /cannot reach the core/);
      assert.equal(t.out(), "");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe("acp main coverage: default connector with recorded pid", () => {
  it("a recorded pid is handed to connect as expectedServerPid; with no listener the run still ends with exit 1", { skip: process.platform === "win32" ? "POSIX-Rechte und Unix-Socket" : false }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p1b-acp-main-"));
    try {
      await fs.mkdir(path.join(dir, "run"), { mode: 0o700 });
      await fs.chmod(path.join(dir, "run"), 0o700);
      await fs.writeFile(path.join(dir, "run", "core.token"), "a".repeat(64), { mode: 0o600 });
      await fs.writeFile(path.join(dir, "run", "core.pid"), "2147483646\n", { mode: 0o600 });
      const t = io();
      const code = await runAcpMain(["--home", dir, "--agent", "a", "--account", "b", "--user", "c"], t as never);
      assert.equal(code, 1);
      assert.match(t.err(), /cannot reach the core/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe("acp main coverage: serving", () => {
  it("logs acp.started as JSON on stderr only, builds the caller from the flags and closes the client at end of input", async () => {
    const t = io(); const calls: { m: string; p: any }[] = [];
    const p = runAcpMain(ARGS, t as never, async () => fakeClient(calls));
    t.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    t.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } })}\n`);
    t.stdin.end();
    assert.equal(await p, 0);
    const created = calls.find((c) => c.m === "session.create")!;
    assert.deepEqual(created.p, { caller: { channel: "cli", accountId: "acc", userId: "u" }, agentId: "bernd", kind: "acp", title: "ACP" });
    const errLines = t.err().trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(errLines.some((l) => l.event === "acp.started" && l.level === "info"));
    assert.ok(errLines.some((l) => l.event === "acp.session-new"));
    for (const l of t.out().trim().split("\n")) assert.equal(JSON.parse(l).jsonrpc, "2.0");
    assert.equal(calls.at(-1)!.m, "close");
  });
  it("an empty session (stdin ends at once) exits 0 and still closes the client", async () => {
    const t = io(); const calls: { m: string; p: any }[] = [];
    t.stdin.end();
    assert.equal(await runAcpMain(ARGS, t as never, async () => fakeClient(calls)), 0);
    assert.deepEqual(calls.map((c) => c.m), ["close"]);
    assert.equal(t.out(), "");
  });
  it("a failing client.close() is swallowed", async () => {
    const t = io(); const calls: { m: string; p: any }[] = [];
    t.stdin.end();
    assert.equal(await runAcpMain(ARGS, t as never, async () => fakeClient(calls, { closeFails: true })), 0);
    assert.deepEqual(calls.map((c) => c.m), ["close"]);
  });
});

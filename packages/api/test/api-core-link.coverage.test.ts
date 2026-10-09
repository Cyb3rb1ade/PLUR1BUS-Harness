import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectOptions, CoreClient } from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";

interface Fake extends CoreClient { drop(): void; closed: number; calls: Array<[string, object | undefined]> }
function fakeClient(id: string): Fake {
  let onClose: (() => void) | undefined;
  const f: Fake = {
    hello: { rpc: "1", instanceId: id, pid: 1 }, closed: 0, calls: [],
    call: (async (m: string, p?: object) => { f.calls.push([m, p]); return { from: id, m }; }) as CoreClient["call"],
    onNotification: () => () => {}, onClose: (h) => { onClose = h; return () => {}; }, close: async () => { f.closed++; }, supports: () => true,
    drop() { onClose?.(); },
  };
  return f;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("createCoreLink", () => {
  it("passes params through and returns the result of the client", async () => {
    const c = fakeClient("c1");
    const link = createCoreLink("/h", { connect: async () => c, readToken: () => "t", readPid: () => undefined });
    assert.deepEqual(await link.call("agent.list", { a: 1 }), { from: "c1", m: "agent.list" });
    await link.call("core.status");
    assert.deepEqual(c.calls, [["agent.list", { a: 1 }], ["core.status", undefined]]);
  });

  it("omits expectedServerPid when no pid is recorded and passes the address and a 1 s timeout", async () => {
    const opens: ConnectOptions[] = [];
    const link = createCoreLink("/some/home", { connect: async (o) => { opens.push(o); return fakeClient("c"); }, readToken: () => "tok", readPid: () => undefined });
    await link.call("x");
    assert.equal("expectedServerPid" in opens[0]!, false);
    assert.equal(opens[0]!.token, "tok");
    assert.equal(opens[0]!.connectTimeoutMs, 1000);
    assert.equal(opens[0]!.endpoint, "core");
    if (process.platform !== "win32") assert.equal(opens[0]!.address, "/some/home/run/core.sock");
  });

  it("passes the recorded pid and reads the home it was given", async () => {
    const homes: string[] = []; const opens: ConnectOptions[] = [];
    const link = createCoreLink("/h2", { connect: async (o) => { opens.push(o); return fakeClient("c"); }, readToken: (h) => { homes.push(`t:${h}`); return "t"; }, readPid: (h) => { homes.push(`p:${h}`); return 77; } });
    await link.call("x");
    assert.deepEqual(homes, ["p:/h2", "t:/h2"]);
    assert.equal(opens[0]!.expectedServerPid, 77);
  });

  it("logs connect and loss when a logger is given, and works without one", async () => {
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const c = fakeClient("c1");
    const withLog = createCoreLink("/h", { connect: async () => c, readToken: () => "t", readPid: () => undefined, log: { debug() {}, info: (m, f) => logs.push([m, f]) } });
    await withLog.call("x"); c.drop();
    assert.deepEqual(logs, [["core connected", { instanceId: "c1" }], ["core connection lost", undefined]]);
    const c2 = fakeClient("c2");
    const quiet = createCoreLink("/h", { connect: async () => c2, readToken: () => "t", readPid: () => undefined });
    await quiet.call("x"); c2.drop();
  });

  it("a stale drop notification of an old connection does not discard the new one", async () => {
    const clients: Fake[] = []; let opens = 0;
    const link = createCoreLink("/h", { connect: async () => { opens++; const c = fakeClient(`c${opens}`); clients.push(c); return c; }, readToken: () => "t", readPid: () => undefined });
    await link.call("a"); clients[0]!.drop();
    await link.call("b"); assert.equal(opens, 2);
    clients[0]!.drop(); // again, late
    await link.call("c");
    assert.equal(opens, 2, "the live connection is kept");
    assert.deepEqual(clients[1]!.calls.map((x) => x[0]), ["b", "c"]);
  });

  it("a connect that fails for concurrent callers fails them all, and the next call retries", async () => {
    let n = 0;
    const link = createCoreLink("/h", { connect: async () => { if (++n === 1) throw new Error("ECONNREFUSED"); return fakeClient("c"); }, readToken: () => "t", readPid: () => undefined });
    const results = await Promise.allSettled([link.call("a"), link.call("b")]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
    assert.equal(n, 1);
    await link.call("c");
    assert.equal(n, 2);
  });

  it("a throwing token or pid reader is the caller's error, not a connection", async () => {
    let opened = 0;
    const link = createCoreLink("/h", { connect: async () => { opened++; return fakeClient("c"); }, readToken: () => { throw new Error("no token file"); }, readPid: () => undefined });
    await assert.rejects(link.call("x"), /no token file/);
    assert.equal(opened, 0);
    const link2 = createCoreLink("/h", { connect: async () => fakeClient("c"), readToken: () => "t", readPid: () => { throw new Error("pid boom"); } });
    await assert.rejects(link2.call("x"), /pid boom/);
  });

  it("close() closes a live client once, refuses later calls, and is harmless without a client or twice", async () => {
    const c = fakeClient("c");
    const link = createCoreLink("/h", { connect: async () => c, readToken: () => "t", readPid: () => undefined });
    await link.close(); // nothing connected yet
    await assert.rejects(link.call("x"), /the core link is closed/);
    const link2 = createCoreLink("/h", { connect: async () => c, readToken: () => "t", readPid: () => undefined });
    await link2.call("x");
    await link2.close(); await link2.close();
    assert.equal(c.closed, 1);
    await assert.rejects(link2.call("x"), /closed/);
  });

  it("the defaults read the token and pid files of the home and fail cleanly when no core listens", async () => {
    const home = mkdtempSync(join(tmpdir(), "cl-")); dirs.push(home);
    // No run/ at all: the default token reader fails.
    await assert.rejects(createCoreLink(home).call("x"));
    mkdirSync(join(home, "run"), { mode: 0o700 }); chmodSync(join(home, "run"), 0o700);
    writeFileSync(join(home, "run", "core.token"), "tok\n");
    writeFileSync(join(home, "run", "core.pid"), "notanumber\n");
    // Token and pid readable, but nothing is listening: the default connect fails.
    const link = createCoreLink(home);
    await assert.rejects(link.call("x"));
    await link.close();
  });
});

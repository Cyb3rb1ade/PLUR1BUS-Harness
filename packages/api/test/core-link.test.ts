import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectOptions, CoreClient } from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";

function fakeClient(id: string, calls: string[]): CoreClient & { drop(): void } {
  let onClose: (() => void) | undefined;
  return {
    hello: { rpc: "1", instanceId: id, pid: 1 },
    call: (async (m: string) => { calls.push(`${id}:${m}`); return { from: id }; }) as CoreClient["call"],
    onNotification: () => () => {}, onClose: (h) => { onClose = h; return () => {}; }, close: async () => {}, supports: () => true,
    drop() { onClose?.(); },
  };
}

test("the link connects on first use, shares one connection, passes the fresh token and the recorded pid, and reconnects after a drop", async () => {
  const calls: string[] = []; const opens: ConnectOptions[] = []; const clients: Array<ReturnType<typeof fakeClient>> = [];
  let token = "t1";
  const link = createCoreLink("/h", {
    connect: async (o) => { opens.push(o); await new Promise((r) => setTimeout(r, 5)); const c = fakeClient(`c${clients.length + 1}`, calls); clients.push(c); return c; },
    readToken: () => token, readPid: () => 4242,
  });
  assert.equal(opens.length, 0, "lazy");
  await Promise.all([link.call("a"), link.call("b"), link.call("c")]);
  assert.equal(opens.length, 1, "concurrent first calls share one connect");
  assert.deepEqual([opens[0]!.token, opens[0]!.expectedServerPid, opens[0]!.endpoint], ["t1", 4242, "core"]);
  await link.call("d");
  assert.equal(opens.length, 1);
  token = "t2"; clients[0]!.drop();
  await link.call("e");
  assert.equal(opens.length, 2); assert.equal(opens[1]!.token, "t2", "the token is read afresh for every connection");
  assert.deepEqual(calls.slice(-1), ["c2:e"]);
});

test("a failed connect fails that call only; the next call tries again; a closed link refuses", async () => {
  let n = 0;
  const link = createCoreLink("/h", { connect: async () => { if (++n === 1) throw new Error("ECONNREFUSED"); return fakeClient("c", []); }, readToken: () => "t", readPid: () => undefined });
  await assert.rejects(link.call("x"), /ECONNREFUSED/);
  assert.deepEqual(await link.call("x"), { from: "c" });
  await link.close();
  await assert.rejects(link.call("x"), /closed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, type CoreClient } from "../src/client.ts";
import { createRpcServer, MAX_PENDING_NOTIFICATIONS, type RpcServerOptions } from "../src/rpc-server.ts";
import { createLogger } from "../src/logger.ts";

// Delivery is bound to the subscriptions that matched when the producer called notify(): a subscription added while the
// connection's queue is still busy is not one the producer checked, and a connection without any matching subscription
// never occupies queue slots.
async function harness(t: test.TestContext, extra: Partial<RpcServerOptions>) {
  const dir = await mkdtemp(join(tmpdir(), "p1b-notify-eligible-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\p1b-${randomUUID()}` : join(dir, "rpc.sock");
  const token = randomBytes(32).toString("hex"), apiToken = randomBytes(32).toString("hex");
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  const server = createRpcServer({ address, token, apiToken, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "test" }), ...extra });
  await server.listen();
  const clients: CoreClient[] = [];
  // api: "control" is the API's credential-only link (no principal), "person" a delegated web session.
  const open = async (api?: "control" | "person") => {
    const c = await connect({ address, token, ...(api ? { api: { clientId: "harness-api" as const, token: apiToken, ...(api === "person" ? { principal: { userId: "christian", role: "owner" as const, kind: "person" as const } } : {}) } } : {}) });
    clients.push(c); return c;
  };
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await server.close(); await logger.close(); await rm(dir, { recursive: true, force: true }); });
  return { server, open };
}
const record = (n: number) => ({ approval: { id: `a${n}` } });

test("a subscription added while the queue waits on an earlier identity lookup does not receive an opt-in event", async t => {
  let release!: (person: string) => void;
  const identity = new Promise<string>(resolve => { release = resolve; });
  const { server, open } = await harness(t, { personOfConnection: () => identity });
  const checked = await open(), late = await open();
  t.after(() => release("christian"));
  const seen = { checked: [] as string[], late: [] as string[] };
  checked.onNotification(m => seen.checked.push(m)); late.onNotification(m => seen.late.push(m));
  await checked.call("events.subscribe", { names: ["approval.requested"] });
  await late.call("events.subscribe", { names: ["inbox.changed"] });
  // Blocks only the late connection's queue (the checked one has no inbox.changed subscription).
  server.notify("inbox.changed", { change: "created", kinds: ["approval"] }, { audience: [{ personId: "christian" }] });
  server.notify("approval.requested", record(1), { optIn: true });
  await late.call("events.subscribe", { names: ["approval.requested"] });
  release("christian");
  await delay(60);
  assert.deepEqual(seen.late, ["inbox.changed"], "the late subscription was never checked by the producer");
  assert.deepEqual(seen.checked, ["approval.requested"], "the checked subscription still gets the event exactly once");
});

test("a burst without eligible subscriptions disconnects neither a plain RPC nor an API control connection", async t => {
  const { server, open } = await harness(t, { personOfConnection: () => new Promise<string>(() => {}), apiPersonOfConnection: () => new Promise<string>(() => {}) });
  const rpc = await open(), control = await open("control"), unfiltered = await open();
  await rpc.call("events.subscribe", { names: ["inbox.changed"] });
  await control.call("events.subscribe", { names: ["api.account.changed"] });
  await unfiltered.call("events.subscribe", {});
  let closed = 0;
  for (const c of [rpc, control, unfiltered]) c.onClose(() => { closed++; });
  for (let n = 0; n <= MAX_PENDING_NOTIFICATIONS + 8; n++) {
    server.notify("approval.requested", record(n), { optIn: true }); // matches no names subscription of these connections
    server.notify("inbox.changed", { change: "created", kinds: ["approval"] }, { audience: [] }); // empty audience: nobody may receive it
    server.notify("grant.changed", { change: "created", grant: { id: `g${n}` } }, { optIn: true, audience: [{ personId: "christian" }] });
  }
  await delay(60);
  assert.equal(closed, 0);
  for (const c of [rpc, control, unfiltered]) assert.ok((await c.call("events.subscribe", { names: ["core.state"] }) as { subscriptionId: string }).subscriptionId);
});

test("eligible deliveries keep the legacy unfiltered rule and API connections still see only core.state without an audience", async t => {
  const { server, open } = await harness(t, { apiPrincipalOf: p => p, apiPersonOfConnection: async (_id, p) => p.userId });
  const unfiltered = await open(), named = await open(), api = await open("person");
  const seen = { unfiltered: [] as string[], named: [] as string[], api: [] as string[] };
  unfiltered.onNotification(m => seen.unfiltered.push(m)); named.onNotification(m => seen.named.push(m)); api.onNotification(m => seen.api.push(m));
  await unfiltered.call("events.subscribe", {});
  await unfiltered.call("events.subscribe", {});
  await named.call("events.subscribe", { names: ["approval.requested", "core.state"] });
  await api.call("events.subscribe", {});
  server.notify("inbox.changed", { change: "created", kinds: ["approval"] });
  server.notify("approval.requested", record(1), { optIn: true });
  server.notify("core.state", { state: "ready" });
  await delay(60);
  assert.deepEqual(seen.unfiltered, ["inbox.changed", "core.state"], "no-names subscriptions get every non-opt-in event, once per connection");
  assert.deepEqual(seen.named, ["approval.requested", "core.state"]);
  assert.deepEqual(seen.api, ["core.state"]);
});

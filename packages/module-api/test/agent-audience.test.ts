import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, type CoreClient } from "../src/client.ts";
import { createRpcServer } from "../src/rpc-server.ts";
import { apiPrincipal } from "../src/api-principal.ts";
import { createLogger } from "../src/logger.ts";
import { authorize } from "../../core/src/rbac/authorize.ts";
import { rpcAddress, selfServer } from "./helpers/endpoint.ts";

// Real delegated sockets exercise subscription admission and delivery separately.
test("agent audiences use current RBAC, preserve local owner, deny missing hooks, and retain order", async t => {
  const dir = await mkdtemp(join(tmpdir(), "p1b-agent-audience-"));
  const address = rpcAddress(dir);
  const token = randomBytes(32).toString("hex"), apiToken = randomBytes(32).toString("hex");
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  let rights = true; let fail = false;
  const server = createRpcServer({ address, token, apiToken, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "test" }),
    apiPrincipalOf: p => p, apiPersonOfConnection: async (_id, p) => p.userId,
    canReadAgent: async (ctx, agentId) => {
      if (fail) throw new Error("identity unavailable");
      const p = apiPrincipal(ctx);
      if (p === undefined) return true;
      if (p?.userId === "permitted") await delay(5);
      return authorize(p && { ...p, agentRights: p.userId === "permitted" && rights ? { bernd: "use" } : {} }, "agent.read", { kind: "agent", agentId }).effect === "allow";
    } });
  await server.listen();
  const clients: CoreClient[] = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await server.close(); await logger.close(); await rm(dir, { recursive: true, force: true }); });
  for (const [userId, role] of [["denied", "viewer"], ["permitted", "member"], ["admin", "admin"], ["owner", "owner"]] as const) {
    clients.push(await connect({ address, token, ...selfServer, api: { clientId: "harness-api", token: apiToken, principal: { userId, role, kind: "person" } } }));
  }
  clients.push(await connect({ address, token, ...selfServer }));
  const seen: number[][] = clients.map(() => []);
  clients.forEach((c, i) => c.onNotification((_m, p) => seen[i]!.push((p as { totalMs: number }).totalMs)));
  await assert.rejects(clients[0]!.call("events.subscribe", { agentId: "bernd" }), (e: any) => e.error === "E_DENIED");
  for (const c of clients) await c.call("events.subscribe", {});
  for (let n = 1; n <= 3; n++) server.notify("recall.completed", { agentId: "bernd", totalMs: n, degraded: null }, { audience: [{ agentId: "bernd" }] });
  await delay(80);
  assert.deepEqual(seen, [[], [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]]);
  rights = false;
  server.notify("recall.completed", { agentId: "bernd", totalMs: 4, degraded: null }, { audience: [{ agentId: "bernd" }] });
  await delay(40); assert.deepEqual(seen[1], [1, 2, 3], "revocation applies to existing unfiltered subscription");
  fail = true;
  server.notify("recall.completed", { agentId: "bernd", totalMs: 5, degraded: null }, { audience: [{ agentId: "bernd" }] });
  await delay(40); assert.ok(seen.every(s => !s.includes(5)), "lookup failure denies all affected deliveries");
});

test("delegated agent subscriptions and audiences fail closed without an agent-visibility hook", async t => {
  const dir = await mkdtemp(join(tmpdir(), "p1b-no-agent-hook-"));
  const address = rpcAddress(dir);
  const token = randomBytes(32).toString("hex"), apiToken = randomBytes(32).toString("hex");
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  const server = createRpcServer({ address, token, apiToken, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "test" }), apiPersonOfConnection: async (_id, p) => p.userId });
  await server.listen();
  // Cleanup first: a refused connect must not leave the listening server holding the test process open.
  let client!: CoreClient;
  t.after(async () => { await client?.close(); await server.close(); await logger.close(); await rm(dir, { recursive: true, force: true }); });
  client = await connect({ address, token, ...selfServer, api: { clientId: "harness-api", token: apiToken, principal: { userId: "viewer", role: "viewer", kind: "person" } } });
  await assert.rejects(client.call("events.subscribe", { agentId: "bernd" }), (e: any) => e.error === "E_DENIED");
  await client.call("events.subscribe", {});
  const seen: string[] = []; client.onNotification(m => seen.push(m));
  server.notify("recall.completed", { agentId: "bernd", totalMs: 1, degraded: null }, { audience: [{ agentId: "bernd" }] });
  await delay(30); assert.deepEqual(seen, []);
});

test("an event storm behind an unresolved identity lookup disconnects at the bounded queue", async t => {
  const dir = await mkdtemp(join(tmpdir(), "p1b-event-queue-"));
  const address = rpcAddress(dir);
  const token = randomBytes(32).toString("hex");
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  let release!: (person: string) => void;
  const identity = new Promise<string>(resolve => { release = resolve; });
  const server = createRpcServer({ address, token, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "test" }), personOfConnection: () => identity });
  await server.listen();
  let client!: CoreClient;
  t.after(async () => { release("person"); await client?.close(); await server.close(); await logger.close(); await rm(dir, { recursive: true, force: true }); });
  client = await connect({ address, token, ...selfServer });
  await client.call("events.subscribe", {});
  const closed = new Promise<void>(resolve => client.onClose(resolve));
  const { MAX_PENDING_NOTIFICATIONS } = await import("../src/rpc-server.ts");
  for (let n = 0; n <= MAX_PENDING_NOTIFICATIONS; n++) server.notify("inbox.changed", { change: "created", kinds: ["approval"] }, { audience: [{ personId: "person" }] });
  await Promise.race([closed, delay(2000).then(() => { throw new Error("event queue did not disconnect"); })]);
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger, createRpcServer, type CoreClient } from "@plur1bus/module-api";
import { connect } from "../helpers/connect.ts";
import { createPermissionNotifier, type PermissionNotifier } from "../../src/approvals/notify.ts";
import { AGENT_PRINCIPAL, PERSON } from "./rpc-helpers.ts";
import { askFor, rig, tick, type Rig } from "./service-helpers.ts";

// The notifier checks the opted-in audience, then hands the event to the shared server synchronously; the server must deliver it
// only to subscriptions that existed at that moment, even when a connection's queue is still busy with an earlier event.
it("approval.requested reaches the checked person once and never a subscription added behind a slow identity lookup", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "p1b-approval-transport-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\p1b-${randomUUID()}` : join(dir, "rpc.sock");
  const token = randomBytes(32).toString("hex");
  const logger = createLogger({ file: join(dir, "test.log"), role: "core", level: "error" });
  let release!: (person: string) => void;
  const identity = new Promise<string>(resolve => { release = resolve; });
  const server = createRpcServer({ address, token, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "test" }), personOfConnection: () => identity });
  await server.listen();
  // Cleanup first: a refused connect must not leave the listening server holding the test process open (Windows refuses a pipe whose server pid the client was not told).
  let person!: CoreClient, agent!: CoreClient;
  t.after(async () => { release("christian"); await person?.close(); await agent?.close(); await server.close(); await logger.close(); await rm(dir, { recursive: true, force: true }); });
  person = await connect({ address, token }); agent = await connect({ address, token });

  const seen = { person: [] as string[], agent: [] as string[] };
  person.onNotification(m => seen.person.push(m)); agent.onNotification(m => seen.agent.push(m));
  await person.call("events.subscribe", { names: ["approval.requested"] });
  await agent.call("events.subscribe", { names: ["inbox.changed"] });
  const personConn = server.subscriptions().find(s => s.names?.includes("approval.requested"))!.connectionId;

  let notifier!: PermissionNotifier;
  let r!: Rig;
  r = await rig({ service: { events: { emit: (n, p) => { r.events.push({ name: n, payload: p }); notifier.events.emit(n, p); } } } });
  notifier = createPermissionNotifier({
    subscriptions: () => server.subscriptions(), notify: (m, p, o) => server.notify(m, p, o),
    // The agent connection would be refused if the producer ever checked it.
    principalOf: async connectionId => connectionId === personConn ? PERSON : AGENT_PRINCIPAL,
    grantRecordOf: () => undefined, now: () => r.clock.now(),
  });
  t.after(() => { notifier.close(); r.service.dispose(); });

  // Holds only the agent connection's queue: it alone subscribed to inbox.changed.
  server.notify("inbox.changed", { change: "created", kinds: ["approval"] }, { audience: [{ personId: "christian" }] });
  void r.service.request(askFor({ actionHash: "cd".padEnd(64, "0") }));
  await tick(); await notifier.idle();
  await agent.call("events.subscribe", { names: ["approval.requested"] });
  release("christian");
  await delay(80);
  assert.deepEqual(seen.agent, ["inbox.changed"], "the unchecked late subscription must not receive the private event");
  assert.deepEqual(seen.person, ["approval.requested"]);
});

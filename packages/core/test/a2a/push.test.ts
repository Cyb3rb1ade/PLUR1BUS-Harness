import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createEgress } from "../../src/egress/index.ts";
import { createA2aHandler } from "../../src/a2a/handler.ts";
import { PushDispatcher, type PushTransport } from "../../src/a2a/push.ts";
import { AGENTS, allowPush, BASE, KEY_B, peers, rpc, sendMsg, rig } from "./helpers.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";

const never = (): Promise<void> => new Promise(() => {});

const listen = (s: Server): Promise<{ port: number; url: string }> => new Promise((resolve, reject) => {
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    if (!a || typeof a === "string") { reject(new Error("no address")); return; }
    resolve({ port: a.port, url: `http://127.0.0.1:${a.port}` });
  });
});

describe("push notification config and delivery", () => {
  it("set/get/list/delete round-trip on a task", async () => {
    const { h } = rig({ opts: { pushTransport: allowPush } });
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const set = await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "http://127.0.0.1:9/hook", token: "tkn" },
    });
    assert.equal(set.json.result.taskId, t.id);
    assert.equal(set.json.result.pushNotificationConfig.url, "http://127.0.0.1:9/hook");
    assert.ok(set.json.result.pushNotificationConfig.id);
    const id = set.json.result.pushNotificationConfig.id;
    const got = await rpc(h, "tasks/pushNotificationConfig/get", { id: t.id, pushNotificationConfigId: id });
    assert.equal(got.json.result.pushNotificationConfig.token, "tkn");
    const listed = await rpc(h, "tasks/pushNotificationConfig/list", { id: t.id });
    assert.equal(listed.json.result.length, 1);
    const del = await rpc(h, "tasks/pushNotificationConfig/delete", { id: t.id, pushNotificationConfigId: id });
    assert.equal(del.json.result, null);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/get", { id: t.id })).json.error.code, -32001);
  });
  it("a peer without task.push cannot set a webhook", async () => {
    const { h } = rig({ opts: { pushTransport: allowPush } });
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const denied = await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "http://127.0.0.1:9/hook" },
    }, { key: KEY_B });
    assert.equal(denied.json.error.code, -32600);
    assert.equal(denied.json.error.data.reason, "forbidden");
  });
  it("without an egress policy the webhook URL is refused (SSRF default deny)", async () => {
    const { h } = rig();
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const r = await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "http://127.0.0.1:9/hook" },
    });
    assert.equal(r.json.error.code, -32602);
    assert.equal(r.json.error.data.reason, "push-url-denied");
  });
  it("PushNotificationNotSupported when the card turns push off", async () => {
    const { h } = rig({ opts: { features: { streaming: true, pushNotifications: false } } });
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/list", { id: "x" })).json.error.code, -32003);
  });
  it("delivers the Task as HTTP POST with the notification token to a local receiver", async () => {
    const received: { body: string; token?: string; auth?: string }[] = [];
    const hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const token = req.headers["x-a2a-notification-token"];
        const auth = req.headers.authorization;
        received.push({
          body: Buffer.concat(chunks).toString("utf8"),
          ...(typeof token === "string" ? { token } : {}),
          ...(typeof auth === "string" ? { auth } : {}),
        });
        res.writeHead(204); res.end();
      });
    });
    const { port, url } = await listen(hook);
    try {
      const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
      const r = rig({ opts: { egress } });
      const t = (await rpc(r.h, "message/send", sendMsg("ping", {}, {
        blocking: true,
        pushNotificationConfig: { url: `${url}/hook`, token: "secret-token", authentication: { schemes: ["bearer"], credentials: "hook-key" } },
      }))).json.result;
      await r.h.tasks.push?.idle();
      assert.ok(received.length >= 1);
      const last = received.at(-1)!;
      assert.equal(last.token, "secret-token");
      assert.equal(last.auth, "Bearer hook-key");
      const payload = JSON.parse(last.body);
      assert.equal(payload.kind, "task");
      assert.equal(payload.id, t.id);
      assert.equal(payload.status.state, "completed");
    } finally { await new Promise<void>((res) => hook.close(() => res())); }
  });
  it("refuses private, loopback and metadata URLs, including after a redirect", async () => {
    const posted: string[] = [];
    const transport: PushTransport = {
      async decide(url) {
        if (/169\.254\.|10\.0\.0\.|127\.0\.0\.1/.test(url)) return { allowed: false, reason: "private-address", message: "private" };
        return { allowed: true, host: "example.test", port: 443, address: "93.184.216.34", family: 4 };
      },
      async post({ url }) {
        posted.push(url);
        if (url.includes("/from")) return { status: 307, location: "http://169.254.169.254/latest/meta-data/" };
        return { status: 204 };
      },
    };
    const { h } = rig({ fake: { gate: never }, opts: { pushTransport: transport, limits: { pushMaxAttempts: 1 } } });
    const t = (await rpc(h, "message/send", sendMsg("slow"))).json.result;
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "http://169.254.169.254/latest/meta-data/" },
    })).json.error.data.reason, "push-url-denied");
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "http://127.0.0.1/hook" },
    })).json.error.data.reason, "push-url-denied");
    const ok = await rpc(h, "tasks/pushNotificationConfig/set", {
      taskId: t.id, pushNotificationConfig: { url: "https://example.test/from" },
    });
    assert.equal(ok.status, 200);
    await rpc(h, "tasks/cancel", { id: t.id });
    await h.tasks.push?.idle();
    assert.ok(posted.includes("https://example.test/from"));
    assert.equal(posted.some((u) => u.includes("169.254")), false);
  });
  it("retries a failed POST with backoff and stops after N attempts", async () => {
    let n = 0;
    const transport: PushTransport = {
      async decide(url) {
        const u = new URL(url);
        return { allowed: true, host: u.hostname, port: 9, address: "127.0.0.1", family: 4 };
      },
      async post() { n += 1; return { status: 500 }; },
    };
    const push = new PushDispatcher({
      transport, scheduler: { set: (fn) => { fn(); return 0; }, clear() {} },
      clock: { now: () => 1 }, maxAttempts: 3, backoffMs: 1,
    });
    const h = createA2aHandler({
      peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined), advertisedBaseUrl: BASE,
      provider: () => new FakeChatProvider(), push,
    });
    await rpc(h, "message/send", sendMsg("x", {}, { blocking: true, pushNotificationConfig: { url: "http://127.0.0.1:9/h" } }));
    await push.idle();
    assert.equal(n, 3);
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createA2aServer, type A2aServer } from "../../src/a2a/server.ts";
import { openA2aSessionBackend } from "../../src/a2a/turn-port.ts";
import { createEgress } from "../../src/egress/index.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { AGENTS, KEY_A, KEY_B, peers } from "./helpers.ts";

const open: Array<A2aServer | Server> = [];
afterEach(async () => {
  while (open.length) {
    const x = open.pop()!;
    if ("handler" in x) await (x as A2aServer).close();
    else await new Promise<void>((res) => { (x as Server).close(() => res()); });
  }
});

class FakeA2aClient {
  readonly url: string;
  readonly key: string;
  readonly agent: string;
  constructor(url: string, key: string, agent = "bernd") {
    this.url = url; this.key = key; this.agent = agent;
  }
  #rpcUrl(): string { return `${this.url}/a2a/${this.agent}/`; }
  async card(): Promise<any> {
    const r = await fetch(`${this.url}/a2a/${this.agent}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${this.key}` } });
    return { status: r.status, json: await r.json() };
  }
  async call(method: string, params: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(this.#rpcUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: r.status, json: await r.json() };
  }
  async stream(method: string, params: unknown): Promise<{ status: number; events: any[] }> {
    const r = await fetch(this.#rpcUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await r.text();
    const events = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!));
    return { status: r.status, events };
  }
}

const msg = (text: string, extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) => ({
  message: { role: "user", messageId: `m-${Math.random().toString(36).slice(2)}`, parts: [{ kind: "text", text }], ...extra },
  ...(Object.keys(cfg).length ? { configuration: cfg } : {}),
});

async function start(extra: Record<string, unknown> = {}) {
  const backend = openA2aSessionBackend({ provider: () => new FakeChatProvider() });
  const s = createA2aServer({
    peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined),
    provider: () => new FakeChatProvider(), turns: backend.port, ...extra,
  });
  open.push(s);
  const addr = await s.listen();
  return { s, backend, client: new FakeA2aClient(addr.url, KEY_A), ...addr };
}

function hookServer(): Promise<{ server: Server; url: string; received: { body: string; token?: string }[] }> {
  const received: { body: string; token?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const token = req.headers["x-a2a-notification-token"];
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        ...(typeof token === "string" ? { token } : {}),
      });
      res.writeHead(204); res.end();
    });
  });
  open.push(server);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") { reject(new Error("no address")); return; }
      resolve({ server, url: `http://127.0.0.1:${a.port}/hook`, received });
    });
  });
}

describe("A2A 0.3 conformance (Fake-A2A-Client × FakeChatProvider)", () => {
  it("send → completed against the session turn-loop", async () => {
    const { client, backend } = await start();
    const card = await client.card();
    assert.equal(card.status, 200);
    assert.equal(card.json.protocolVersion, "0.3.0");
    assert.equal(card.json.capabilities.streaming, true);
    const r = await client.call("message/send", msg("hello", {}, { blocking: true }));
    assert.equal(r.json.result.status.state, "completed");
    assert.equal(r.json.result.artifacts[0].parts[0].text, "echo[bernd]: hello");
    const sessions = backend.store.listSessions({ owner: "a2a-peer:peer-a" });
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0]!.kind, "direct");
    backend.close();
  });
  it("stream yields artifact chunks then a final status", async () => {
    const { client, backend } = await start();
    const { events } = await client.stream("message/stream", msg("stream-me"));
    const kinds = events.map((e) => e.result.kind);
    assert.ok(kinds.includes("artifact-update"));
    const last = events.at(-1)!.result;
    assert.equal(last.kind, "status-update");
    assert.equal(last.final, true);
    assert.equal(last.status.state, "completed");
    backend.close();
  });
  it("cancel mid-run aborts the turn", async () => {
    const backend = openA2aSessionBackend({
      provider: () => new FakeChatProvider({ gate: () => new Promise(() => {}) }),
    });
    const s = createA2aServer({
      peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined),
      provider: () => new FakeChatProvider({ gate: () => new Promise(() => {}) }), turns: backend.port,
    });
    open.push(s);
    const addr = await s.listen();
    const client = new FakeA2aClient(addr.url, KEY_A);
    const sent = await client.call("message/send", msg("slow"));
    const id = sent.json.result.id;
    try {
      const c = await client.call("tasks/cancel", { id });
      assert.equal(c.json.result.status.state, "canceled");
      const got = await client.call("tasks/get", { id });
      assert.equal(got.json.result.status.state, "canceled");
    } finally { backend.close(); }
  });
  it("resubscribe after the first SSE is dropped continues from the live task", async () => {
    const backend = openA2aSessionBackend({
      provider: () => new FakeChatProvider({ gate: () => new Promise(() => {}) }),
    });
    const s = createA2aServer({
      peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined),
      provider: () => new FakeChatProvider({ gate: () => new Promise(() => {}) }), turns: backend.port,
    });
    open.push(s);
    const addr = await s.listen();
    const client = new FakeA2aClient(addr.url, KEY_A);
    const sent = await client.call("message/send", msg("slow"));
    const id = sent.json.result.id;
    const ac = new AbortController();
    const dropped = fetch(`${addr.url}/a2a/bernd/`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY_A}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/resubscribe", params: { id } }),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await dropped.catch(() => {});
    try {
      const still = await client.call("tasks/get", { id });
      assert.equal(still.json.result.status.state, "working");
      await client.call("tasks/cancel", { id });
      const { events } = await client.stream("tasks/resubscribe", { id });
      assert.equal(events[0]!.result.status.state, "canceled");
      assert.equal(events[0]!.result.final, true);
    } finally {
      await client.call("tasks/cancel", { id }).catch(() => {});
      backend.close();
    }
  });
  it("push POSTs the completed task to a local receiver", async () => {
    const hook = await hookServer();
    const port = Number(new URL(hook.url).port);
    const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
    const { client, s, backend } = await start({ egress });
    const r = await client.call("message/send", msg("ping", {}, {
      blocking: true, pushNotificationConfig: { url: hook.url, token: "conformance-token" },
    }));
    assert.equal(r.json.result.status.state, "completed");
    const deadline = Date.now() + 2000;
    while (hook.received.length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
    await s.handler?.tasks.push?.idle();
    assert.ok(hook.received.length >= 1);
    assert.equal(hook.received.at(-1)!.token, "conformance-token");
    assert.equal(JSON.parse(hook.received.at(-1)!.body).id, r.json.result.id);
    backend.close();
  });
  it("a missing or wrong bearer never starts a turn", async () => {
    const { url, backend } = await start();
    const anon = await fetch(`${url}/a2a/bernd/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: msg("nope") }),
    });
    assert.equal(anon.status, 401);
    const bad = new FakeA2aClient(url, KEY_B);
    const r = await bad.call("message/send", msg("nope"));
    assert.equal(r.json.error.code, -32600);
    assert.equal(backend.store.listSessions({ owner: "a2a-peer:peer-b" }).sessions.length, 0);
    backend.close();
  });
});

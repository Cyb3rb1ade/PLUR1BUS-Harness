import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createCallBudget } from "../../src/budget/calls.ts";
import { PeerCallBudget } from "../../src/budget/peer.ts";
import { A2aPeerStore } from "../../src/a2a/peer-store.ts";
import { A2aPeerTransport, type A2aExecution, type PeerTransportDeps } from "../../src/tools/a2a-transport.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { AgentCard } from "@a2a-js/sdk";
import { ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { grant, MemoryGrants } from "../policy/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { ApprovalAnswer, ApprovalAsk } from "../../src/tools/approval.ts";

const execution: A2aExecution = { person: "owner", agent: "main", session: "session", turn: "turn", project: "project", surface: 3, policy: {} };

it("negotiates A2A 1.0 through the SDK server version check on every HTTP request", async () => {
  const card = AgentCard.fromJSON({
    name: "Version control",
    supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://peer.example/rpc" }],
  });
  assert.throws(() => validateVersion(new ServerCallContext({}).requestedVersion, card, "JSONRPC"));
  const versions: string[] = [];
  const f = await fixture((req, res) => {
    const version = req.headers["a2a-version"];
    const context = new ServerCallContext(typeof version === "string" ? { requestedVersion: version } : {});
    versions.push(context.requestedVersion);
    res.setHeader("content-type", "application/json");
    try {
      validateVersion(context.requestedVersion, card, "JSONRPC");
      res.end("{}");
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
  try {
    await f.request();
    await f.request({ method: "POST", body: "{}", purpose: "message" });
    assert.deepEqual(versions, ["1.0", "1.0"]);
  } finally {
    await f.close();
  }
});
async function fixture(handler: RequestListener, options: Pick<PeerTransportDeps, "credential"> & {
  now?(): number; approve?(ask: ApprovalAsk): Promise<ApprovalAnswer>;
} = {}) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  // The name deliberately cannot resolve; the socket must use the approved pin.
  const url = `http://unresolvable.invalid:${address.port}/card`;
  const dir = tempDir("a2a-transport-");
  const store = new A2aPeerStore({ path: join(dir, "peers.sqlite"), now: Date.now });
  store.add({ id: "peer", cardUrl: url, kid: "key", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) });
  const peer = store.get("peer")!;
  if (options.credential) peer.credentialSecret = "a2a/peer/token";
  const path = join(dir, "budget.sqlite");
  const budget = createCallBudget({ path, clock: { now: Date.now } });
  const peerBudget = new PeerCallBudget({ path, now: Date.now });
  const audit = memoryAuditSink();
  const grants = new MemoryGrants();
  const asks: unknown[] = [], approvalDetails: ApprovalAsk[] = [], urls: string[] = [];
  let localOnly = false, current = true;
  let pin = "127.0.0.1";
  const settings = { enabled: true, timeoutMs: 2000, maxCardBytes: 1024, maxRequestBytes: 1024, maxReplyBytes: 1024, peerCalls: 8, turnCalls: 16, peerTokens: 10000, turnTokens: 20000 };
  const transport = new A2aPeerTransport({ ...(options.credential ? { credential: options.credential } : {}),
    settings: () => settings, localOnly: () => localOnly, now: options.now ?? Date.now, peerBudget, budget, audit,
    egress: { async decide(raw) { urls.push(raw); return { allowed: true, host: "unresolvable.invalid", port: address.port, address: pin, family: 4 }; } },
    dispatch: { grants, grantUse: { markUsed() {}, consumeOnce() { return true; } }, audit: createPolicyAudit({ sink: audit, clock: { now: Date.now } }), approvals: { async request(ask) { asks.push(ask.args); approvalDetails.push(ask); return options.approve ? options.approve(ask) : { approved: true }; } } },
  });
  const request = (overrides: Partial<Parameters<A2aPeerTransport['request']>[1]> = {}) => transport.request(peer, { url, method: "GET", purpose: "card", execution, signal: new AbortController().signal, current: () => current, ...overrides });
  return { transport, peer, settings, request, audit, grants, asks, approvalDetails, urls, setPin: (v: string) => { pin = v; }, localOnly: () => { localOnly = true; }, revoke: () => { current = false; }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); peerBudget.close(); budget.close(); store.close(); } };
}

it("excludes each approval wait from the network deadline, including a redirect", async () => {
  let now = Date.now(), approvals = 0, requests = 0;
  const f = await fixture((req, res) => {
    assert.equal(approvals, ++requests, "a request needs its own completed approval");
    if (req.url === "/card") { res.writeHead(302, { location: "/redirected" }); res.end(); }
    else { res.setHeader("content-type", "application/json"); res.end("{}"); }
  }, { now: () => now, async approve() { now += 60_000; approvals++; return { approved: true }; } });
  try {
    const reply = await f.request();
    assert.equal(reply.status, 200);
    assert.equal(approvals, 2);
    assert.equal(requests, 2);
  } finally { await f.close(); }
});

it("does not reset an exhausted network allowance at a redirect", async () => {
  let now = Date.now(), requests = 0;
  const f = await fixture((_req, res) => {
    requests++; now += 2000;
    res.writeHead(302, { location: "/redirected" }); res.end();
  }, { now: () => now });
  try {
    await assert.rejects(f.request(), { code: "request-failed" });
    assert.equal(requests, 1);
    assert.equal(f.asks.length, 1, "an exhausted allowance cannot ask for another hop");
  } finally { await f.close(); }
});

it("automatically times out an approved stalled request and closes its socket", { timeout: 5000 }, async t => {
  let arrived!: () => void, disconnected!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await fixture((_req, res) => { res.once("close", disconnected); arrived(); });
  t.after(() => f.close());
  f.settings.timeoutMs = 1000;
  const timedOut = assert.rejects(f.request(), error => {
    assert.ok(error instanceof Error);
    assert.ok(["request-failed", "aborted"].includes((error as { code?: string }).code ?? ""));
    return true;
  });
  await arrival;
  await timedOut;
  await closed;
  assert.equal(f.urls.length, 1);
  assert.equal(f.asks.length, 1);
});

it("releases the preview lease before human waiting and leases afresh for traffic", async () => {
  const preview = randomBytes(24).toString("base64url"), network = randomBytes(24).toString("base64url");
  const active = new Set<string>(), released: string[] = [];
  let leases = 0, hits = 0;
  const f = await fixture((req, res) => {
    hits++; assert.equal(req.headers.authorization, `Bearer ${network}`);
    res.setHeader("content-type", "application/json"); res.end("{}");
  }, {
    async credential() {
      const value = ++leases === 1 ? preview : network;
      active.add(value);
      return { value, release() { assert.ok(active.delete(value)); released.push(value); } };
    },
    async approve() { assert.equal(active.size, 0, "no lease survives the approval wait"); return { approved: true }; },
  });
  try {
    await f.request();
    assert.equal(hits, 1);
    assert.equal(leases, 2);
    assert.deepEqual(released, [preview, network]);
    assert.equal(active.size, 0);
    assert.ok(!JSON.stringify([f.approvalDetails, f.audit.events]).includes(preview));
    assert.ok(!JSON.stringify([f.approvalDetails, f.audit.events]).includes(network));
  } finally { await f.close(); }
});

it("shows a bounded decoded and redacted approval preview with recurring-job context", async () => {
  const value = randomBytes(32).toString("base64url");
  let released = 0;
  const f = await fixture((_req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); }, {
    credential: async () => ({ value, release() { released++; } }),
  });
  try {
    f.settings.maxRequestBytes = 16_384;
    const objective = "Compare the supplied sort algorithms";
    const encoded = JSON.stringify({ question: `${objective}: ${value} ${Buffer.from(value).toString("base64")}` });
    await f.request({ method: "POST", purpose: "message", body: JSON.stringify({ params: { message: { parts: [{ text: encoded }] } } }),
      execution: { ...execution, recurring: { jobId: "daily", jobName: "Daily comparison" } } });
    const ask = f.approvalDetails[0]!;
    assert.ok(ask.reason?.includes(objective));
    assert.ok(ask.reason!.length <= 2048);
    assert.deepEqual(ask.recurring, { jobId: "daily", jobName: "Daily comparison" });
    for (const secret of [value, Buffer.from(value).toString("base64")]) {
      assert.ok(!JSON.stringify(f.approvalDetails).includes(secret));
      assert.ok(!JSON.stringify(f.audit.events).includes(secret));
    }
    assert.ok(!JSON.stringify(f.audit.events).includes(objective));
    assert.equal(released, 2, "preview and network leases are both released");
  } finally { await f.close(); }
});

it("requires a fresh trust answer and displays the full endpoint separately from bounded summaries", async () => {
  const f = await fixture((_req, res) => { res.end(); });
  try {
    f.grants.grants.push(grant("network.a2a", "session", { kind: "capability" }, {
      person: execution.person, agent: execution.agent, sessionId: execution.session, createdAt: Date.now(),
    }));
    const endpoint = new URL(f.peer.cardUrl);
    endpoint.pathname = `/${"a".repeat(1850)}/confirm-this-suffix`;
    await f.transport.confirmTrust(f.peer, endpoint.toString(), execution, new AbortController().signal, () => true);
    const ask = f.approvalDetails[0]!;
    assert.equal(ask.tool, "peer.a2a_trust");
    assert.ok(ask.diff?.includes(endpoint.toString()));
    assert.ok(ask.diff!.length < 8192);
    assert.deepEqual(f.urls, []);
  } finally { await f.close(); }
});

it("releases a late lease after approval cancellation without showing or sending it", async () => {
  const value = randomBytes(24).toString("base64url");
  let resolveLease!: (lease: { value: string; release(): void }) => void;
  let leaseStarted!: () => void;
  const started = new Promise<void>(resolve => { leaseStarted = resolve; });
  let released = 0, hits = 0;
  const f = await fixture((_req, res) => { hits++; res.end(); }, {
    credential: async () => {
      leaseStarted();
      return new Promise(resolve => { resolveLease = resolve; });
    },
  });
  try {
    const controller = new AbortController();
    const operation = f.request({ signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(operation, { code: "aborted" });
    resolveLease({ value, release() { released++; } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(released, 1);
    assert.equal(hits, 0);
    assert.deepEqual(f.approvalDetails, []);
  } finally { await f.close(); }
});

it("pins the actual HTTP connection and audits only identifiers, hashes and counts", async () => {
  const marker = "FOREIGN-SECRET-CONTENT-123456789";
  const f = await fixture((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: marker })); });
  try {
    f.localOnly();
    const result = await f.request(); assert.match(result.body, new RegExp(marker));
    assert.equal(f.urls.length, 1); assert.equal(f.asks.length, 1);
    assert.equal(f.audit.events.filter(e => e.action === "a2a.call").length, 1);
    assert.ok(!JSON.stringify([f.audit.events, f.asks]).includes(marker));
    assert.ok(!JSON.stringify(f.audit.events).includes("unresolvable"));
  } finally { await f.close(); }
});

it("refuses a persisted out-of-scope credential before approval, lease or connection", async () => {
  let leases = 0;
  let calls = 0;
  const value = randomBytes(24).toString("base64url");
  const f = await fixture((_req, res) => { calls++; res.setHeader("content-type", "application/json"); res.end("{}"); }, {
    credential: async () => { leases++; return { value, release() {} }; },
  });
  try {
    f.peer.credentialSecret = "provider-key";
    await assert.rejects(f.request(), { code: "invalid-peer" });
    assert.equal(leases, 0);
    assert.equal(calls, 0);
    assert.deepEqual(f.asks, []);
    assert.deepEqual(f.urls, []);
  } finally { await f.close(); }
});

it("rechecks every redirect, rejects cross-origin hops and does not replay POSTs", async () => {
  let hits = 0;
  const f = await fixture((req, res) => { hits++; if (req.url === "/card") { res.statusCode = 302; res.setHeader("location", "/next"); res.end(); } else { res.setHeader("content-type", "application/json"); res.end("{}"); } });
  try {
    await f.request(); assert.equal(hits, 2); assert.equal(f.urls.length, 2); assert.equal(f.asks.length, 2);
    await assert.rejects(f.request({ method: "POST", body: "{}", purpose: "message" }), { code: "request-failed" });
    assert.equal(hits, 3);
    f.settings.peerCalls = 3;
    await assert.rejects(f.request(), { code: "budget-exceeded" });
    assert.equal(hits, 3);
  } finally { await f.close(); }
  const cross = await fixture((_req, res) => { res.statusCode = 302; res.setHeader("location", "https://other.invalid/card"); res.end(); });
  try { await assert.rejects(cross.request(), { code: "egress-denied" }); assert.equal(cross.urls.length, 1); }
  finally { await cross.close(); }
});

it("refuses headless asks, revoked peers and WAN pins under localOnly before sending", async () => {
  let hits = 0;
  const f = await fixture((_req, res) => { hits++; res.end("{}"); });
  try {
    await assert.rejects(f.request({ execution: { ...execution, policy: { headless: { jobId: "job" } } } }), { code: "approval-required" });
    assert.equal(f.asks.length, 0); assert.equal(f.urls.length, 0);
    f.localOnly(); f.setPin("93.184.216.34");
    await assert.rejects(f.request(), { code: "local-only" });
    f.setPin("127.0.0.1"); f.revoke();
    await assert.rejects(f.request(), { code: "peer-revoked" });
    assert.equal(hits, 0);
  } finally { await f.close(); }
});

it("caps chunked responses, sanitizes remote errors and aborts an in-flight request", async () => {
  const large = await fixture((_req, res) => { res.setHeader("content-type", "application/json"); res.write("{"); res.end("x".repeat(2048)); });
  try { await assert.rejects(large.request(), { code: "too-large" }); }
  finally { await large.close(); }
  const bad = await fixture((_req, res) => { res.statusCode = 500; res.end("FOREIGN-ERROR-TOKEN-123456789"); });
  try { await assert.rejects(bad.request(), error => error instanceof Error && error.message === "A2A peer request failed"); assert.ok(!JSON.stringify(bad.audit.events).includes("FOREIGN")); }
  finally { await bad.close(); }
  const controller = new AbortController();
  const hanging = await fixture(() => { controller.abort(); });
  try { await assert.rejects(hanging.request({ signal: controller.signal }), { code: "aborted" }); }
  finally { await hanging.close(); }
});

it("never includes a leased bearer or outgoing message in approval arguments, audits or errors", async () => {
  const marker = "SECRET-LEASE-AND-MESSAGE-77665544";
  let released = 0, hits = 0;
  const f = await fixture((req, res) => {
    hits++; assert.equal(req.headers.authorization, `Bearer ${marker}`);
    res.statusCode = 500; res.end(marker);
  }, { credential: async () => ({ value: marker, release() { released++; } }) });
  try {
    await assert.rejects(f.request({ method: "POST", body: JSON.stringify({ question: marker }), purpose: "message" }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, "A2A peer request failed"); return true;
    });
    assert.equal(hits, 1); assert.equal(released, 2, "preview and network leases are both released");
    assert.ok(!JSON.stringify([f.asks, f.audit.events]).includes(marker));
  } finally { await f.close(); }
});

it("refuses an unavailable audit before I/O and refunds only that unused admission", async () => {
  let hits = 0;
  const f = await fixture((_req, res) => { hits++; res.setHeader("content-type", "application/json"); res.end("{}"); });
  try {
    const append = f.audit.append;
    f.settings.peerCalls = 1;
    f.audit.append = event => { if (event.action === "a2a.call") throw new Error("SECRET-AUDIT-ERROR-77665544"); append(event); };
    await assert.rejects(f.request(), error => error instanceof Error && error.message === "A2A peer request failed");
    assert.equal(hits, 0); f.audit.append = append;
    await f.request(); assert.equal(hits, 1);
    assert.ok(!JSON.stringify(f.audit.events).includes("SECRET-AUDIT-ERROR"));
  } finally { await f.close(); }
});

it("concurrent calls cannot exceed the same peer/turn call reservation", async () => {
  let hits = 0;
  const f = await fixture((_req, res) => { hits++; res.setHeader("content-type", "application/json"); res.end("{}"); });
  try {
    f.settings.peerCalls = 1;
    const results = await Promise.allSettled([f.request(), f.request()]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const refused = results.find(r => r.status === "rejected");
    assert.ok(refused && refused.status === "rejected"); assert.equal(refused.reason.code, "budget-exceeded");
    assert.equal(hits, 1);
  } finally { await f.close(); }
});

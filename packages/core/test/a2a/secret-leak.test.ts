import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createCallBudget } from "../../src/budget/calls.ts";
import { PeerCallBudget } from "../../src/budget/peer.ts";
import { A2aPeerStore } from "../../src/a2a/peer-store.ts";
import { A2aPeerTransport, type A2aExecution, type PeerTransportDeps } from "../../src/tools/a2a-transport.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { MemoryGrants } from "../policy/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const execution: A2aExecution = { person: "owner", agent: "main", session: "session", turn: "turn", project: "project", surface: 3, policy: {} };
async function fixture(handler: RequestListener, options: Pick<PeerTransportDeps, "credential"> = {}) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  // The name deliberately cannot resolve; the socket must use the approved pin.
  const url = `http://unresolvable.invalid:${address.port}/card`;
  const dir = tempDir("a2a-transport-");
  const store = new A2aPeerStore({ path: join(dir, "peers.sqlite"), now: Date.now });
  store.add({ id: "peer", cardUrl: url, kid: "key", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) });
  const peer = store.get("peer")!;
  if (options.credential) peer.credentialSecret = "peer-token";
  const path = join(dir, "budget.sqlite");
  const budget = createCallBudget({ path, clock: { now: Date.now } });
  const peerBudget = new PeerCallBudget({ path, now: Date.now });
  const audit = memoryAuditSink();
  const asks: unknown[] = [], urls: string[] = [];
  let localOnly = false, current = true;
  let pin = "127.0.0.1";
  const settings = { enabled: true, timeoutMs: 2000, maxCardBytes: 1024, maxRequestBytes: 1024, maxReplyBytes: 1024, peerCalls: 8, turnCalls: 16, peerTokens: 10000, turnTokens: 20000 };
  const transport = new A2aPeerTransport({ ...options, settings: () => settings, localOnly: () => localOnly, now: Date.now, peerBudget, budget, audit,
    egress: { async decide(raw) { urls.push(raw); return { allowed: true, host: "unresolvable.invalid", port: address.port, address: pin, family: 4 }; } },
    dispatch: { grants: new MemoryGrants(), audit: createPolicyAudit({ sink: audit, clock: { now: Date.now } }), approvals: { async request(ask) { asks.push(ask.args); return { approved: true }; } } },
  });
  const request = (overrides: Partial<Parameters<A2aPeerTransport['request']>[1]> = {}) => transport.request(peer, { url, method: "GET", purpose: "card", execution, signal: new AbortController().signal, current: () => current, ...overrides });
  return { transport, peer, settings, request, audit, asks, urls, setPin: (v: string) => { pin = v; }, localOnly: () => { localOnly = true; }, revoke: () => { current = false; }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); peerBudget.close(); budget.close(); store.close(); } };
}

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
    assert.equal(hits, 1); assert.equal(released, 1);
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

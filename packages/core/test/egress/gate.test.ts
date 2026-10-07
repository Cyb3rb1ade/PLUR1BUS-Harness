import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileEgressPolicy, DEFAULT_EGRESS_CONFIG } from "../../src/egress/policy.ts";
import { createGate, EgressDenial } from "../../src/egress/gate.ts";

const policy = (o: Partial<typeof DEFAULT_EGRESS_CONFIG>) => compileEgressPolicy({ ...DEFAULT_EGRESS_CONFIG, ...o });
const reason = (fn: () => void): string | null => {
  try { fn(); return null; } catch (e) { assert.ok(e instanceof EgressDenial, String(e)); return e.reason; }
};
const pre = (p: ReturnType<typeof policy>, url: string) => reason(() => createGate(p).beforeResolve(new URL(url)));

describe("gate.beforeResolve", () => {
  const p = policy({ allowHosts: ["example.com", "*.cdn.test", "localhost", "127.0.0.1", "[::1]"], allowPorts: [443, 8443] });
  it("allows an allowlisted https host on an allowed port", () => {
    assert.equal(pre(p, "https://example.com/x"), null);
    assert.equal(pre(p, "https://a.cdn.test:8443/x"), null);
  });
  it("refuses a host that is not on the list", () => assert.equal(pre(p, "https://evil.test/"), "host-not-allowed"));
  it("refuses a port that is not on the list (explicit and scheme default)", () => {
    assert.equal(pre(p, "https://example.com:444/"), "port");
    assert.equal(pre(p, "https://example.com:22/"), "port");
    const only8443 = policy({ allowHosts: ["example.com"], allowPorts: [8443] });
    assert.equal(pre(only8443, "https://example.com/"), "port", "the default 443 is checked like any other port");
  });
  it("refuses http for a public name, and any other scheme", () => {
    assert.equal(pre(p, "http://example.com/"), "scheme");
    for (const u of ["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "ws://example.com/"]) assert.equal(pre(p, u), "scheme", u);
  });
  it("http to loopback needs allowLoopback, a loopback spelling and an allowlist entry", () => {
    assert.equal(pre(p, "http://localhost:443/"), "scheme", "allowLoopback is off");
    const lo = policy({ allowHosts: ["localhost", "127.0.0.1", "[::1]"], allowPorts: [3000], allowLoopback: true });
    assert.equal(pre(lo, "http://localhost:3000/"), null);
    assert.equal(pre(lo, "http://127.0.0.1:3000/"), null);
    assert.equal(pre(lo, "http://[::1]:3000/"), null);
    assert.equal(pre(lo, "http://127.0.0.2:3000/"), "host-not-allowed", "not listed");
    assert.equal(pre(lo, "http://localhost:3001/"), "port");
    assert.equal(pre(lo, "http://example.com:3000/"), "scheme");
  });
  it("normalises exotic IPv4 spellings before judging them", () => {
    const lo = policy({ allowHosts: ["127.0.0.1"], allowPorts: [80], allowLoopback: true });
    for (const u of ["http://0x7f.1/", "http://2130706433/", "http://017700000001/", "http://127.1/"]) assert.equal(pre(lo, u), null, `${u} is 127.0.0.1`);
    assert.equal(pre(lo, "http://0x7f.0.0.2/"), "host-not-allowed");
  });
  it("an IPv4-mapped IPv6 spelling is the same destination as its IPv4 address, no more", () => {
    const lo = policy({ allowHosts: ["127.0.0.1"], allowPorts: [80], allowLoopback: true });
    assert.equal(pre(lo, "http://[::ffff:127.0.0.1]/"), null);
    const none = policy({ allowHosts: ["10.0.0.1"], allowPorts: [80], allowLoopback: true });
    assert.equal(pre(none, "http://[::ffff:127.0.0.1]/"), "host-not-allowed");
  });
});

describe("gate.afterResolve", () => {
  const lo = policy({ allowHosts: ["localhost", "dev.example", "*"], allowPorts: [443, 3000], allowLoopback: true });
  const g = createGate(lo);
  it("https to a public pin passes", () => assert.equal(reason(() => g.afterResolve(new URL("https://dev.example/"), { address: "93.184.216.34", family: 4 })), null));
  it("a name that resolves to loopback is refused even with allowLoopback", () => {
    assert.equal(reason(() => g.afterResolve(new URL("https://dev.example/"), { address: "127.0.0.1", family: 4 })), "loopback");
  });
  it("a loopback spelling may reach loopback, over http or https", () => {
    assert.equal(reason(() => g.afterResolve(new URL("http://localhost:3000/"), { address: "127.0.0.1", family: 4 })), null);
    assert.equal(reason(() => g.afterResolve(new URL("https://localhost/"), { address: "127.0.0.1", family: 4 })), null);
  });
  it("http is never sent to a non-loopback pin", () => {
    assert.equal(reason(() => g.afterResolve(new URL("http://localhost:3000/"), { address: "93.184.216.34", family: 4 })), "scheme");
  });
});

describe("gate counters", () => {
  it("records allowed and denied decisions by reason", () => {
    const seen: string[] = [];
    const g = createGate(policy({ allowHosts: ["a.example"] }), { onDecision: (d) => seen.push(d.allowed ? "ok" : d.reason) });
    g.beforeResolve(new URL("https://a.example/"));
    g.afterResolve(new URL("https://a.example/"), { address: "93.184.216.34", family: 4 });
    assert.throws(() => g.beforeResolve(new URL("https://b.example/")));
    assert.deepEqual(seen, ["ok", "host-not-allowed"]);
  });
});

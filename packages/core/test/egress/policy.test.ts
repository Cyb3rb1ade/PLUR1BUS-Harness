import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileEgressPolicy, hostAllowed, DEFAULT_EGRESS_CONFIG } from "../../src/egress/policy.ts";

const cfg = (o: Partial<typeof DEFAULT_EGRESS_CONFIG>) => ({ ...DEFAULT_EGRESS_CONFIG, ...o });

describe("egress policy: defaults", () => {
  it("deny all hosts, https port only, no loopback", () => {
    const p = compileEgressPolicy(DEFAULT_EGRESS_CONFIG);
    assert.deepEqual(p.allowPorts, [443]);
    assert.equal(p.allowLoopback, false);
    assert.equal(hostAllowed(p, "example.com"), false);
    assert.deepEqual(p.errors, []);
  });
});

describe("egress policy: host rules", () => {
  const p = compileEgressPolicy(cfg({ allowHosts: ["Example.COM", "*.api.test", "8.8.8.8", "[2001:4860:4860::8888]", "bücher.example."] }));
  it("compiles without errors", () => assert.deepEqual(p.errors, []));
  it("exact names are case-insensitive and ignore a trailing dot", () => {
    assert.equal(hostAllowed(p, "example.com"), true);
    assert.equal(hostAllowed(p, "EXAMPLE.com."), true);
    assert.equal(hostAllowed(p, "www.example.com"), false);
    assert.equal(hostAllowed(p, "example.com.evil.test"), false);
  });
  it("*.suffix matches subdomains of any depth, never the apex or a lookalike", () => {
    assert.equal(hostAllowed(p, "a.api.test"), true);
    assert.equal(hostAllowed(p, "a.b.api.test"), true);
    assert.equal(hostAllowed(p, "api.test"), false);
    assert.equal(hostAllowed(p, "evilapi.test"), false);
    assert.equal(hostAllowed(p, "api.test.evil.test"), false);
  });
  it("IDN entries match their punycode form", () => assert.equal(hostAllowed(p, "xn--bcher-kva.example"), true));
  it("IP literals match only an exact entry, in canonical spelling", () => {
    assert.equal(hostAllowed(p, "8.8.8.8"), true);
    assert.equal(hostAllowed(p, "8.8.4.4"), false);
    assert.equal(hostAllowed(p, "[2001:4860:4860::8888]"), true);
    assert.equal(hostAllowed(p, "[2001:4860:4860:0:0:0:0:8888]"), true);
  });
  it("`*` allows any name but never an IP literal", () => {
    const any = compileEgressPolicy(cfg({ allowHosts: ["*"] }));
    assert.equal(hostAllowed(any, "anything.example"), true);
    assert.equal(hostAllowed(any, "8.8.8.8"), false);
    assert.equal(hostAllowed(any, "[::1]"), false);
    assert.equal(hostAllowed(any, "127.0.0.1"), false);
  });
});

describe("egress policy: invalid configuration fails closed", () => {
  for (const bad of ["", "ex ample.com", "http://example.com", "example.com/path", "a*.example.com", "*.", "**", "*.*.example.com", "user@example.com", "example.com:443", "0x7f.1", "2130706433", "x".repeat(300)]) {
    it(`rejects host entry ${JSON.stringify(bad.slice(0, 30))}`, () => {
      const p = compileEgressPolicy(cfg({ allowHosts: ["good.example", bad] }));
      assert.equal(p.errors.length, 1);
      assert.equal(hostAllowed(p, "good.example"), false, "any error makes the whole host list deny-all");
    });
  }
  it("rejects bad ports", () => {
    for (const ports of [[0], [65536], [-1], [1.5], [NaN]]) {
      const p = compileEgressPolicy(cfg({ allowHosts: ["a.example"], allowPorts: ports as number[] }));
      assert.equal(p.errors.length, 1, JSON.stringify(ports));
      assert.deepEqual(p.allowPorts, [], "no port is allowed");
    }
  });
});

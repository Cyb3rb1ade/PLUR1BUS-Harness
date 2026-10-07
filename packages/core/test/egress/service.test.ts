import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEgress } from "../../src/egress/service.ts";
import type { EgressConfig } from "../../src/egress/policy.ts";
import { WebFailure } from "../../src/tools/web/failure.ts";
import { startStub, stubResolver, never } from "../tools/web/helpers.ts";
import type { Resolver } from "../../src/tools/web/guard.ts";
import { makePinnedLookup } from "../../src/tools/web/http.ts";

const UA = "PLUR1BUS/test";
const mk = (cfg: Partial<EgressConfig>, resolver: Resolver = never) =>
  createEgress({ config: () => ({ allowHosts: [], allowPorts: [443], allowLoopback: false, ...cfg }), resolver, now: () => 0 });
const refused = (p: Promise<unknown>, code: string, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code && (!re || re.test(e.message)), `expected ${code}`);

describe("egress.decide: allowlist hit and miss", () => {
  const e = mk({ allowHosts: ["api.example.com", "*.cdn.example.net"] }, stubResolver({ "api.example.com": ["93.184.216.34"], "a.cdn.example.net": ["2606:2800:220:1:248:1893:25c8:1946"], "other.example.org": ["93.184.216.34"] }));
  it("an allowlisted name resolving to a public address is allowed and carries the pin", async () => {
    assert.deepEqual(await e.decide("https://api.example.com/x"), { allowed: true, host: "api.example.com", port: 443, address: "93.184.216.34", family: 4 });
    const v6 = await e.decide("https://a.cdn.example.net/");
    assert.ok(v6.allowed && v6.family === 6);
  });
  it("a name that is not listed is refused before any DNS lookup", async () => {
    const calls = stubResolver({});
    const e2 = mk({ allowHosts: ["api.example.com"] }, calls);
    const d = await e2.decide("https://other.example.org/");
    assert.deepEqual(d.allowed === false && d.reason, "host-not-allowed");
    assert.deepEqual(calls.calls, []);
  });
  it("an empty allowlist allows nothing", async () => {
    const d = await mk({}, never).decide("https://example.com/");
    assert.equal(d.allowed, false);
  });
});

describe("egress.decide: private ranges after resolution (every IPv4/IPv6 spelling)", () => {
  const allowEverything = (r: Resolver = never) => mk({ allowHosts: ["*", "127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "[::ffff:7f00:1]", "[fd00:ec2::254]", "[fe80::1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]"], allowPorts: [80, 443], allowLoopback: false }, r);
  for (const [name, answers] of [
    ["loopback", ["127.0.0.1"]], ["rfc1918", ["10.1.2.3"]], ["rfc1918-b", ["172.16.0.9"]], ["rfc1918-c", ["192.168.1.1"]], ["metadata", ["169.254.169.254"]],
    ["cgnat (alibaba metadata)", ["100.100.100.200"]], ["unspecified", ["0.0.0.0"]], ["v6 loopback", ["::1"]], ["v4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["v4-mapped metadata", ["::ffff:169.254.169.254"]], ["ula (aws v6 metadata)", ["fd00:ec2::254"]], ["link-local v6", ["fe80::1"]], ["nat64 of loopback", ["64:ff9b::7f00:1"]],
    ["6to4 of loopback", ["2002:7f00:0001::"]], ["mixed public + private", ["93.184.216.34", "10.0.0.1"]],
  ] as const) {
    it(`refuses a name that resolves to ${name}`, async () => {
      const d = await allowEverything(stubResolver({ "evil.example": [...answers] })).decide("https://evil.example/");
      assert.equal(d.allowed, false);
      assert.match(d.allowed ? "" : d.reason, /private-address|loopback/);
    });
  }
  for (const lit of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "[fd00:ec2::254]", "[fe80::1]", "[64:ff9b::7f00:1]"]) {
    it(`refuses the literal ${lit} even when it is listed`, async () => {
      const d = await allowEverything().decide(`https://${lit}/`);
      assert.equal(d.allowed, false, lit);
    });
  }
  for (const spelling of ["0x7f.1", "0x7f.0.0.1", "2130706433", "017700000001", "127.1", "0177.0.0.1", "127.0.1", "0x7f000001", "1.1.1.1.1"]) {
    it(`refuses the legacy spelling ${spelling} (not listed, and loopback besides)`, async () => {
      const d = await allowEverything().decide(`https://${spelling}/`);
      assert.equal(d.allowed, false, spelling);
    });
  }
  it("localhost never reaches DNS and is refused unless loopback is on", async () => {
    const d = await mk({ allowHosts: ["localhost"] }, never).decide("https://localhost/");
    assert.equal(d.allowed, false);
  });
  it("a listed public IP literal is allowed", async () => {
    const d = await mk({ allowHosts: ["93.184.216.34"] }, never).decide("https://93.184.216.34/");
    assert.equal(d.allowed, true);
  });
});

describe("egress: DNS rebinding", () => {
  it("the pin is the address of the first answer; a later, different answer never matters", async () => {
    let n = 0;
    const flip: Resolver = async () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const e = mk({ allowHosts: ["rebind.example"] }, flip);
    const d = await e.decide("https://rebind.example/");
    assert.ok(d.allowed);
    assert.equal(n, 1);
    // The socket's lookup answers the vetted address whatever it is asked, so a second resolution cannot happen.
    await new Promise<void>((res) => makePinnedLookup({ address: d.allowed ? d.address : "", family: 4 })("rebind.example", { all: true }, (_e: unknown, a: any) => { assert.deepEqual(a, [{ address: "93.184.216.34", family: 4 }]); res(); }));
    // A second decision sees the flipped answer and refuses it.
    assert.equal((await e.decide("https://rebind.example/")).allowed, false);
  });
  it("a name that answers public first and loopback second in ONE answer set is refused (any non-public record)", async () => {
    const e = mk({ allowHosts: ["rebind.example"], allowLoopback: true }, async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    assert.equal((await e.decide("https://rebind.example/")).allowed, false);
  });
  it("allowLoopback does not let a public NAME reach loopback", async () => {
    const e = mk({ allowHosts: ["rebind.example"], allowLoopback: true }, stubResolver({ "rebind.example": ["127.0.0.1"] }));
    const d = await e.decide("https://rebind.example/");
    assert.deepEqual(d.allowed === false && d.reason, "private-address");
  });
  it("a request never resolves a name twice for one hop", async () => {
    const calls = stubResolver({ "once.example": ["93.184.216.34"] });
    const e = mk({ allowHosts: ["once.example"] }, calls);
    // The connect to a public address would leave the machine; cut it off immediately and only count resolutions.
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    await e.request("https://once.example/", { userAgent: UA, signal: ac.signal, timeoutMs: 1000 }).catch(() => undefined);
    assert.ok(calls.calls.length <= 1, `resolved ${calls.calls.length} times`);
  });
});

describe("egress.request over a loopback stub", () => {
  it("an allowlist hit with allowLoopback fetches; counters are exposed", async () => {
    const s = await startStub((_q, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hi"); });
    try {
      const e = mk({ allowHosts: ["127.0.0.1", "localhost"], allowPorts: [s.port], allowLoopback: true });
      const r = await e.request(`http://127.0.0.1:${s.port}/`, { userAgent: UA, timeoutMs: 3000 });
      assert.equal(r.body.toString(), "hi");
      const r2 = await e.request(`http://localhost:${s.port}/`, { userAgent: UA, timeoutMs: 3000 });
      assert.equal(r2.status, 200);
      assert.equal(e.status().decisions.allowed, 2);
    } finally { await s.close(); }
  });
  it("the same request without allowLoopback never reaches the stub", async () => {
    const s = await startStub((_q, res) => res.end("x"));
    try {
      await refused(mk({ allowHosts: ["127.0.0.1"], allowPorts: [s.port] }).request(`http://127.0.0.1:${s.port}/`, { userAgent: UA }), "egress-denied");
      assert.equal(s.hits.length, 0);
    } finally { await s.close(); }
  });
  it("a port outside the list is refused before connecting", async () => {
    const s = await startStub((_q, res) => res.end("x"));
    try {
      await refused(mk({ allowHosts: ["127.0.0.1"], allowPorts: [s.port + 1], allowLoopback: true }).request(`http://127.0.0.1:${s.port}/`, { userAgent: UA }), "egress-denied", /port/);
      assert.equal(s.hits.length, 0);
    } finally { await s.close(); }
  });
});

describe("egress.request: redirects are judged again on every hop", () => {
  const redirectTo = (location: string) => (_q: unknown, res: import("node:http").ServerResponse) => { res.writeHead(302, { location }); res.end(); };
  const cases: Array<[string, string, string]> = [
    ["a private address", "http://10.0.0.5/", "egress-denied"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/", "egress-denied"],
    ["an IPv6 loopback literal", "http://[::1]/", "egress-denied"],
    ["a decimal-spelled loopback", "http://2130706433/", "egress-denied"],
    ["a host that is not listed", "https://evil.example/", "egress-denied"],
    ["a scheme that is not http(s)", "file:///etc/passwd", "egress-denied"],
    ["a listed loopback host on another port", "http://127.0.0.1:1/", "egress-denied"],
  ];
  for (const [name, target, code] of cases) {
    it(`refuses a redirect to ${name}`, async () => {
      const s = await startStub(redirectTo(target));
      try {
        const e = mk({ allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: true });
        await refused(e.request(`http://127.0.0.1:${s.port}/`, { userAgent: UA, timeoutMs: 3000 }), code);
        assert.equal(s.hits.length, 1, "only the first hop was requested");
      } finally { await s.close(); }
    });
  }
  it("refuses a redirect to an allowlisted name that resolves privately, via the SSRF check", async () => {
    const s = await startStub(redirectTo("https://internal.example/"));
    try {
      const e = mk({ allowHosts: ["127.0.0.1", "internal.example"], allowPorts: [s.port, 443], allowLoopback: true }, stubResolver({ "internal.example": ["10.0.0.7"] }));
      await refused(e.request(`http://127.0.0.1:${s.port}/`, { userAgent: UA, timeoutMs: 3000 }), "private-address");
      assert.equal(e.status().decisions.byReason["private-address"], 1);
    } finally { await s.close(); }
  });
  it("follows a redirect between two listed loopback hosts", async () => {
    const t = await startStub((_q, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("landed"); });
    const s = await startStub(redirectTo(`http://localhost:${t.port}/`));
    try {
      const e = mk({ allowHosts: ["127.0.0.1", "localhost"], allowPorts: [s.port, t.port], allowLoopback: true });
      const r = await e.request(`http://127.0.0.1:${s.port}/`, { userAgent: UA, timeoutMs: 3000 });
      assert.equal(r.body.toString(), "landed");
      assert.equal(r.redirects.length, 1);
    } finally { await s.close(); await t.close(); }
  });
});

describe("egress.status", () => {
  it("reports the normalised policy and counts denials by reason, never URLs", async () => {
    const e = mk({ allowHosts: ["Example.com"] });
    await e.decide("https://nope.example/");
    await e.decide("http://example.com/");
    const st = e.status();
    assert.deepEqual(st.policy, { allowHosts: ["example.com"], allowPorts: [443], allowLoopback: false, valid: true, errors: [] });
    assert.deepEqual(st.decisions, { allowed: 0, denied: 2, byReason: { "host-not-allowed": 1, scheme: 1 } });
    assert.ok(!JSON.stringify(st).includes("nope.example"));
  });
  it("reports an invalid configuration as deny-all", () => {
    const st = mk({ allowHosts: ["ok.example", "bad host"] }).status();
    assert.equal(st.policy.valid, false);
    assert.deepEqual(st.policy.allowHosts, []);
    assert.equal(st.policy.errors.length, 1);
  });
  it("follows the live configuration", async () => {
    let cfg: EgressConfig = { allowHosts: [], allowPorts: [443], allowLoopback: false };
    const e = createEgress({ config: () => cfg, resolver: stubResolver({ "a.example": ["93.184.216.34"] }) });
    assert.equal((await e.decide("https://a.example/")).allowed, false);
    cfg = { ...cfg, allowHosts: ["a.example"] };
    assert.equal((await e.decide("https://a.example/")).allowed, true);
  });
});

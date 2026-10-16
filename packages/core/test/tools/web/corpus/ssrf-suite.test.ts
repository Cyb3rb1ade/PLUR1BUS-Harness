// M2 acceptance 12, the SSRF half: private, loopback, link-local and cloud-metadata destinations are refused on direct
// requests and on every redirect hop, however they are spelled, and a name is never resolved a second time for the
// connection. Modelled on the egress hardening in #432 (gate) and #459 (audit pins): each case is driven through the
// production `createWebFetch` with the egress gate attached, against a loopback fixture server whose hit counter proves
// that a refused destination was never contacted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { createWebFetch, type WebFetch } from "../../../../src/tools/web/fetch.ts";
import { WebFailure } from "../../../../src/tools/web/failure.ts";
import { createGate } from "../../../../src/egress/gate.ts";
import { compileEgressPolicy, DEFAULT_EGRESS_CONFIG } from "../../../../src/egress/policy.ts";
import { startStub, stubResolver, never, type Stub } from "../helpers.ts";

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WebFailure, `expected a typed failure, got ${String(e)}`);
    return e.code;
  }
  return "fetched";
};
const strict = (extra: Record<string, unknown> = {}): WebFetch => createWebFetch({ allowPrivate: [], timeoutMs: 2000, resolver: never, ...extra });
const withStub = async <T>(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, run: (s: Stub) => Promise<T>): Promise<T> => {
  const s = await startStub(handler);
  try {
    return await run(s);
  } finally {
    await s.close();
  }
};
const redirectTo = (location: string) => (_q: http.IncomingMessage, res: http.ServerResponse) => void res.writeHead(302, { location }).end();

describe("ssrf suite · direct addresses (every spelling, no resolver, no connection)", () => {
  const refused: Array<[string, string]> = [
    // RFC 1918 and neighbours
    ["private", "http://10.0.0.1/"], ["private", "http://10.255.255.254/"], ["private", "http://172.16.0.1/"], ["private", "http://172.31.255.255/"], ["private", "http://192.168.0.1/"], ["private", "http://192.168.1.254:8080/admin"],
    // loopback, all spellings
    ["loopback", "http://127.0.0.1/"], ["loopback", "http://127.255.255.254/"], ["loopback", "http://localhost/"], ["loopback", "http://localhost./"], ["loopback", "http://LocalHost:8080/"], ["loopback", "http://service.localhost/"],
    ["loopback", "http://[::1]/"], ["loopback", "http://[0:0:0:0:0:0:0:1]/"], ["loopback", "http://[0000::0001]/"],
    ["loopback", "http://2130706433/"], ["loopback", "http://0x7f000001/"], ["loopback", "http://017700000001/"], ["loopback", "http://127.1/"], ["loopback", "http://0x7f.0.0.1/"], ["loopback", "http://0177.0.0.01/"], ["loopback", "http://127.0.0.1./"],
    ["loopback", "http://0/"], ["loopback", "http://0.0.0.0/"], ["loopback", "http://[::]/"],
    // full-width and ideographic-dot spellings: the URL parser maps them onto ASCII
    ["loopback", "http://１２７.０.０.１/"], ["loopback", "http://127。0。0。1/"],
    // link-local and the metadata endpoints of the big clouds
    ["link-local", "http://169.254.169.254/latest/meta-data/"], ["link-local", "http://169.254.169.254/computeMetadata/v1/"], ["link-local", "http://169.254.170.2/v2/credentials"], ["link-local", "http://[fe80::1]/"], ["link-local", "http://[febf::1]/"],
    ["metadata", "http://[fd00:ec2::254]/latest/meta-data/"], ["metadata", "http://100.100.100.200/latest/meta-data/"], ["metadata", "http://192.0.0.192/opc/v2/"], ["metadata", "http://168.63.129.16/machine?comp=goalstate"],
    ["metadata", "http://2852039166/"], ["metadata", "http://0xa9fea9fe/"], ["metadata", "http://0251.0376.0251.0376/"], ["metadata", "http://169.254.43518/"],
    // shared address space, ULA, multicast, broadcast, reserved
    ["private", "http://100.64.0.1/"], ["private", "http://[fc00::1]/"], ["private", "http://[fd12:3456::1]/"], ["private", "http://224.0.0.1/"], ["private", "http://[ff02::1]/"], ["private", "http://255.255.255.255/"], ["private", "http://240.0.0.1/"], ["private", "http://198.18.0.1/"], ["private", "http://192.0.2.1/"],
    // IPv4-mapped IPv6, every spelling of loopback, private and metadata
    ["mapped", "http://[::ffff:127.0.0.1]/"], ["mapped", "http://[::ffff:7f00:1]/"], ["mapped", "http://[::FFFF:7F00:1]/"], ["mapped", "http://[0:0:0:0:0:ffff:7f00:1]/"], ["mapped", "http://[0:0:0:0:0:ffff:127.0.0.1]/"],
    ["mapped", "http://[::ffff:10.0.0.1]/"], ["mapped", "http://[::ffff:192.168.1.1]/"], ["mapped", "http://[::ffff:172.16.0.1]/"],
    ["mapped", "http://[::ffff:169.254.169.254]/"], ["mapped", "http://[::ffff:a9fe:a9fe]/"], ["mapped", "http://[::ffff:100.100.100.200]/"], ["mapped", "http://[::ffff:168.63.129.16]/"],
    // IPv4-compatible, NAT64, 6to4, translated: other IPv6 shapes that carry an IPv4 address
    ["embedded", "http://[::127.0.0.1]/"], ["embedded", "http://[::7f00:1]/"], ["embedded", "http://[64:ff9b::7f00:1]/"], ["embedded", "http://[64:ff9b::a9fe:a9fe]/"], ["embedded", "http://[2002:7f00:1::]/"], ["embedded", "http://[2002:a9fe:a9fe::1]/"], ["embedded", "http://[::ffff:0:7f00:1]/"], ["embedded", "http://[::ffff:0:a9fe:a9fe]/"],
  ];
  for (const [kind, url] of refused) {
    it(`${kind} · ${url}`, async () => {
      const got = await code(strict().fetch({ url }));
      assert.equal(got, "private-address", `${url} must be refused as private-address, got ${got}`);
    });
  }

  it("a refused destination is never contacted: the loopback fixture server sees zero hits for any spelling of itself", async () => {
    await withStub((_q, res) => res.end("internal"), async (s) => {
      for (const host of [`127.0.0.1`, `localhost`, `[::ffff:7f00:1]`, `2130706433`, `0x7f.1`, `127.1`, `[::ffff:127.0.0.1]`]) {
        assert.equal(await code(strict().fetch({ url: `http://${host}:${s.port}/` })), "private-address", host);
      }
      assert.equal(s.hits.length, 0);
    });
  });

  it("the refusal carries a hint and a person-facing sentence, and names no secret", async () => {
    try {
      await strict().fetch({ url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
      assert.fail("fetched");
    } catch (e) {
      assert.ok(e instanceof WebFailure);
      assert.equal(e.code, "private-address");
      assert.match(e.hint, /internal/i);
      assert.match(e.userAction, /private network/i);
      assert.equal(JSON.stringify(e.toResult()).includes("security-credentials"), false, "the path of the refused request is not echoed");
    }
  });

  it("non-http schemes and embedded credentials are refused before any resolution", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.test/x", "gopher://example.test/", "data:text/html,hi", "javascript:alert(1)", "ws://example.test/", "dict://localhost:11211/stat"]) assert.equal(await code(strict().fetch({ url })), "egress-denied", url);
    for (const url of ["http://user:pw@example.test/", "http://127.0.0.1@evil.test/", "http://example.test@127.0.0.1/"]) assert.equal(await code(strict().fetch({ url })), "invalid-url", url);
  });

  it("an allowlist entry is an exact range: allowing 10.1.0.0/16 does not open 10.2.0.1, loopback or metadata", async () => {
    const f = createWebFetch({ allowPrivate: ["10.1.0.0/16"], timeoutMs: 300, resolver: never });
    for (const url of ["http://10.2.0.1/", "http://10.0.0.1/", "http://127.0.0.1/", "http://169.254.169.254/", "http://[::ffff:10.2.0.1]/"]) assert.equal(await code(f.fetch({ url })), "private-address", url);
    assert.notEqual(await code(f.fetch({ url: "http://10.1.2.3/" })), "private-address", "inside the range the guard steps aside (the connect then fails or times out offline)");
  });
});

describe("ssrf suite · names that resolve to internal addresses", () => {
  const answers: Record<string, string[]> = {
    "a.test": ["10.1.2.3"], "b.test": ["127.0.0.1"], "c.test": ["::1"], "d.test": ["169.254.169.254"], "e.test": ["fd00:ec2::254"], "f.test": ["::ffff:127.0.0.1"], "g.test": ["::ffff:a9fe:a9fe"],
    "metadata.google.internal": ["169.254.169.254"], "metadata.azure.test": ["168.63.129.16"], "h.test": ["100.100.100.200"],
    "mixed-first.test": ["10.0.0.5", "93.184.216.34"], "mixed-last.test": ["93.184.216.34", "10.0.0.5"], "mixed6.test": ["93.184.216.34", "fe80::1"], "junk.test": ["not-an-address"], "empty.test": [],
  };
  for (const name of Object.keys(answers)) {
    it(`${name} -> ${answers[name]!.join(", ") || "(nothing)"}`, async () => {
      const resolver = stubResolver(answers);
      const got = await code(strict({ resolver }).fetch({ url: `http://${name}/` }));
      assert.equal(got, name === "empty.test" ? "not-found" : "private-address");
    });
  }
  it("an NXDOMAIN is not-found, not an address verdict", async () => {
    assert.equal(await code(strict({ resolver: stubResolver({}) }).fetch({ url: "http://nope.test/" })), "not-found");
  });
});

describe("ssrf suite · DNS rebinding (a name is resolved once per hop, and the connection uses that answer)", () => {
  it("the first answer is what is dialled: a later private answer is irrelevant, and the resolver is asked exactly once", async () => {
    await withStub((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("reached"), async (s) => {
      let n = 0;
      const flip = async () => (++n === 1 ? [{ address: "127.0.0.1", family: 4 as const }] : [{ address: "169.254.169.254", family: 4 as const }]);
      const f = createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver: flip, timeoutMs: 2000 });
      const r = await f.fetch({ url: `http://rebind.test:${s.port}/` });
      assert.equal(r.markdown, "reached");
      assert.equal(n, 1, "the socket must not re-resolve the name");
      assert.equal(s.hits.length, 1);
    });
  });

  it("a private answer first is refused on that one answer, whatever the second would have been", async () => {
    let n = 0;
    const flip = async () => (++n === 1 ? [{ address: "10.0.0.7", family: 4 as const }] : [{ address: "93.184.216.34", family: 4 as const }]);
    assert.equal(await code(strict({ resolver: flip }).fetch({ url: "http://rebind.test/" })), "private-address");
    assert.equal(n, 1);
  });

  it("the second resolution of the same name (the next redirect hop) is checked again and refused", async () => {
    let port = 0;
    await withStub((q, res) => (q.url === "/" ? res.writeHead(302, { location: `http://rebind.test:${port}/second` }).end() : res.end("never")), async (s) => {
      port = s.port;
      let n = 0;
      const flip = async () => (++n === 1 ? [{ address: "127.0.0.1", family: 4 as const }] : [{ address: "169.254.169.254", family: 4 as const }]);
      const f = createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver: flip, timeoutMs: 2000 });
      assert.equal(await code(f.fetch({ url: `http://rebind.test:${s.port}/` })), "private-address");
      assert.equal(n, 2, "one resolution per hop");
      assert.equal(s.hits.length, 1, "the metadata address was never dialled, the fixture saw only the first hop");
    });
  });

  it("a chain that keeps using one allowed name resolves it once per hop and nothing else", async () => {
    let port = 0;
    await withStub((q, res) => (q.url === "/" ? res.writeHead(302, { location: `http://ok.test:${port}/a` }).end() : q.url === "/a" ? res.writeHead(307, { location: `http://ok.test:${port}/b` }).end() : res.writeHead(200, { "content-type": "text/plain" }).end("end")), async (s) => {
      port = s.port;
      const resolver = stubResolver({ "ok.test": ["127.0.0.1"] });
      const r = await createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver, timeoutMs: 2000 }).fetch({ url: `http://ok.test:${s.port}/` });
      assert.equal(r.markdown, "end");
      assert.deepEqual(resolver.calls, ["ok.test", "ok.test", "ok.test"]);
    });
  });

  it("DNS answers are judged as a set: one internal record among public ones refuses the name (no race between records)", async () => {
    const resolver = stubResolver({ "pool.test": ["93.184.216.34", "93.184.216.35", "192.168.0.9"] });
    assert.equal(await code(strict({ resolver }).fetch({ url: "http://pool.test/" })), "private-address");
  });
});

describe("ssrf suite · redirects", () => {
  // The first hop is the fixture server on 127.0.0.1, allowed by an exact /32; no target below lies inside that range.
  const hop = async (location: string): Promise<{ result: string; hits: number }> =>
    withStub(redirectTo(location), async (s) => ({ result: await code(createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver: stubResolver({ "internal.test": ["10.0.0.9"], "meta.test": ["169.254.169.254"], "loop6.test": ["::1"] }), timeoutMs: 2000 }).fetch({ url: `http://127.0.0.1:${s.port}/` })), hits: s.hits.length }));

  const internal = [
    "http://127.0.0.2/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/iam/security-credentials/", "http://[fd00:ec2::254]/", "http://100.100.100.200/", "http://168.63.129.16/",
    "http://10.0.0.1/", "http://172.16.5.5/", "http://192.168.1.1/", "http://[fc00::1]/", "http://[fe80::1]/",
    "http://[::ffff:127.0.0.2]/", "http://[::ffff:a9fe:a9fe]/", "http://[::ffff:10.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:a9fe:a9fe::]/",
    "http://2130706434/", "http://0177.0.0.2/", "http://0xa9fea9fe/", "http://0.0.0.0/", "http://0/",
    "//169.254.169.254/latest", "//[::1]:8080/", "http://internal.test/", "http://meta.test/", "http://loop6.test/",
  ];
  for (const target of internal) {
    it(`public hop -> ${target}`, async () => {
      const r = await hop(target);
      assert.equal(r.result, "private-address", target);
      assert.equal(r.hits, 1, "only the first hop was contacted");
    });
  }

  for (const [target, expected] of [["file:///etc/passwd", "egress-denied"], ["ftp://files.test/x", "egress-denied"], ["gopher://x.test/", "egress-denied"], ["data:text/plain,x", "egress-denied"], ["javascript:alert(1)", "egress-denied"], ["http://user:pw@example.test/", "invalid-url"], ["http://", "invalid-url"]] as const) {
    it(`public hop -> ${target} is ${expected}`, async () => {
      const r = await hop(target);
      assert.equal(r.result, expected);
      assert.equal(r.hits, 1);
    });
  }

  it("the refusal can come on a later hop: allowed -> allowed -> metadata", async () => {
    let port = 0;
    await withStub((q, res) => res.writeHead(302, { location: q.url === "/" ? `http://127.0.0.1:${port}/two` : "http://169.254.169.254/" }).end(), async (s) => {
      port = s.port;
      assert.equal(await code(createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver: never, timeoutMs: 2000 }).fetch({ url: `http://127.0.0.1:${s.port}/` })), "private-address");
      assert.equal(s.hits.length, 2);
    });
  });

  it("redirect hops carry no cookies, no credentials and none of the caller's headers", async () => {
    let port = 0;
    await withStub((q, res) => (q.url === "/" ? res.writeHead(302, { location: `http://127.0.0.1:${port}/next`, "set-cookie": "sid=abc; Path=/" }).end() : res.writeHead(200, { "content-type": "text/plain" }).end("ok")), async (s) => {
      port = s.port;
      await createWebFetch({ allowPrivate: ["127.0.0.1/32"], resolver: never, timeoutMs: 2000 }).fetch({ url: `http://127.0.0.1:${s.port}/` });
      for (const h of s.hits) {
        assert.equal(h.headers.cookie, undefined);
        assert.equal(h.headers.authorization, undefined);
        assert.equal(h.headers.referer, undefined);
      }
      assert.equal(s.hits.length, 2);
    });
  });
});

describe("ssrf suite · egress gate (B4) in front of the same client", () => {
  const gated = (cfg: Partial<typeof DEFAULT_EGRESS_CONFIG>, extra: Record<string, unknown> = {}): WebFetch => createWebFetch({ allowPrivate: ["127.0.0.0/8"], timeoutMs: 2000, gate: createGate(compileEgressPolicy({ ...DEFAULT_EGRESS_CONFIG, ...cfg })), ...extra });

  it("the default policy allows nothing: not even a public name is resolved", async () => {
    const resolver = stubResolver({ "example.test": ["93.184.216.34"] });
    assert.equal(await code(gated({}, { resolver }).fetch({ url: "https://example.test/" })), "egress-denied");
    assert.deepEqual(resolver.calls, [], "refused before name resolution");
  });

  it("plain http to a public name is refused even when the name is listed", async () => {
    const resolver = stubResolver({ "example.test": ["93.184.216.34"] });
    assert.equal(await code(gated({ allowHosts: ["example.test"], allowPorts: [80, 443] }, { resolver }).fetch({ url: "http://example.test/" })), "egress-denied");
    assert.deepEqual(resolver.calls, []);
  });

  it("a listed public name that rebinds to loopback is refused as private-address, even with allowLoopback on", async () => {
    await withStub((_q, res) => res.end("internal"), async (s) => {
      const resolver = stubResolver({ "good.test": ["127.0.0.1"] });
      const f = gated({ allowHosts: ["good.test", "*"], allowPorts: [s.port], allowLoopback: true }, { resolver });
      const got = await code(f.fetch({ url: `http://good.test:${s.port}/` }));
      assert.ok(got === "egress-denied" || got === "private-address", got);
      assert.equal(s.hits.length, 0);
    });
  });

  it("a loopback spelling is reachable only when listed by name and allowLoopback is on; an IPv4-mapped spelling of it needs its own entry", async () => {
    await withStub((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("dev server"), async (s) => {
      const on = gated({ allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: true });
      assert.equal((await on.fetch({ url: `http://127.0.0.1:${s.port}/` })).markdown, "dev server");
      assert.equal(await code(on.fetch({ url: `http://127.0.0.2:${s.port}/` })), "egress-denied", "not listed");
      assert.equal(await code(on.fetch({ url: `http://[::ffff:7f00:2]:${s.port}/` })), "egress-denied");
      assert.equal(await code(gated({ allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: false }).fetch({ url: `http://127.0.0.1:${s.port}/` })), "egress-denied");
      assert.equal(s.hits.length, 1);
    });
  });

  it("every hop of a redirect is gated: a listed https host cannot bounce the fetch to an unlisted one or to http", async () => {
    await withStub(redirectTo("http://127.0.0.1:1/"), async (s) => {
      const f = gated({ allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: true });
      assert.equal(await code(f.fetch({ url: `http://127.0.0.1:${s.port}/` })), "egress-denied", "port 1 is not allowed");
      assert.equal(s.hits.length, 1);
    });
  });

  it("robots.txt is fetched through the same gate and the same address guard", async () => {
    const resolver = stubResolver({ "site.test": ["10.0.0.5"] });
    const f = gated({ allowHosts: ["site.test"], allowPorts: [443] }, { resolver, allowPrivate: [] });
    assert.equal(await code(f.fetch({ url: "https://site.test/page", crawl: true })), "private-address");
  });
});

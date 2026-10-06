// M2 acceptance 12 (SSRF suite): every private, loopback, link-local and metadata address is refused on direct
// and redirected requests — before any connection is attempted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardedRequest } from "../../../src/tools/web/http.ts";
import { makeAddressPolicy } from "../../../src/tools/web/guard.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import { startStub, stubResolver, never } from "./helpers.ts";

const strict = makeAddressPolicy([]); // default: nothing is allowlisted
const opts = (resolver = never) => ({ policy: strict, resolver, userAgent: "t", timeoutMs: 2000 });
const refused = (p: Promise<unknown>) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === "private-address");

describe("ssrf matrix: IP literals, direct", () => {
  const targets = [
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/",
    "http://[::1]/",
    "http://[::1]:9200/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://100.100.100.200/latest/meta-data/",
    "http://10.0.0.1/",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.0.1/",
    "http://192.168.255.255/",
    "http://[fd00::1]/",
    "http://[fd12:3456:789a::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[0:0:0:0:0:ffff:10.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://0.0.0.0/",
    "http://0/",
    // decimal / octal / hex / short notations of loopback and metadata
    "http://2130706433/",
    "http://017700000001/",
    "http://0x7f000001/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://localhost/",
    "http://LOCALHOST:8080/",
    "http://anything.localhost/",
    "http://localhost./",
  ];
  for (const url of targets) it(url, async () => refused(guardedRequest(url, opts())));
});

describe("ssrf matrix: names that resolve to internal addresses", () => {
  const cases: Record<string, string[]> = {
    "loop.test": ["127.0.0.1"],
    "loop6.test": ["::1"],
    "meta.test": ["169.254.169.254"],
    "ten.test": ["10.9.8.7"],
    "ula.test": ["fd00::5"],
    "mapped.test": ["::ffff:127.0.0.1"],
    "mixed.test": ["93.184.216.34", "192.168.1.1"],
    "mixed-last.test": ["192.168.1.1", "93.184.216.34"],
    "weird.test": ["not-an-ip"],
  };
  for (const [name, answers] of Object.entries(cases)) {
    it(`${name} -> ${answers.join(", ")}`, async () => {
      const resolver = stubResolver(cases);
      await refused(guardedRequest(`http://${name}/`, opts(resolver)));
      assert.deepEqual(resolver.calls, [name]);
    });
  }
});

describe("ssrf matrix: DNS rebinding", () => {
  it("a name that answers public first and private later is judged on the one answer set it is pinned to", async () => {
    // Every resolution is checked and only the checked answer is dialled, so the flip is irrelevant: either the
    // first answer set is all-public (and the connect uses it), or it contains a private address and is refused.
    let n = 0;
    const flip = async () => (++n === 1 ? [{ address: "93.184.216.34", family: 4 as const }, { address: "127.0.0.1", family: 4 as const }] : [{ address: "93.184.216.34", family: 4 as const }]);
    await refused(guardedRequest("http://rebind.test/", opts(flip)));
    assert.equal(n, 1);
  });

  it("a redirect hop is a fresh resolution and is checked again", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "http://rebind.test/next" }).end());
    const resolver = stubResolver({ "rebind.test": ["10.0.0.9"] });
    try {
      await assert.rejects(
        guardedRequest(`http://127.0.0.1:${s.port}/`, { policy: makeAddressPolicy(["127.0.0.1/32"]), resolver, userAgent: "t", timeoutMs: 2000 }),
        (e: unknown) => e instanceof WebFailure && e.code === "private-address",
      );
    } finally {
      await s.close();
    }
  });
});

describe("ssrf matrix: redirects to internal addresses", () => {
  const internal = [
    "http://127.0.0.1:1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://10.0.0.1/",
    "http://172.16.5.5/",
    "http://192.168.1.1/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://localhost:8080/",
  ];
  for (const target of internal) {
    it(`public -> ${target}`, async () => {
      // The first hop is a local stub the policy admits explicitly; the Location it returns is not admitted.
      const s = await startStub((req, res) => res.writeHead(302, { location: target }).end());
      try {
        await refused(guardedRequest(`http://127.0.0.1:${s.port}/`, { policy: makeAddressPolicy(["127.0.0.1/32"]), resolver: never, userAgent: "t", timeoutMs: 2000 }));
        assert.equal(s.hits.length, 1);
      } finally {
        await s.close();
      }
    });
  }

  it("the allowlist is an exact range, not 'all loopback' by accident", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "http://127.0.0.2/" }).end());
    try {
      await refused(guardedRequest(`http://127.0.0.1:${s.port}/`, { policy: makeAddressPolicy(["127.0.0.1/32"]), resolver: never, userAgent: "t", timeoutMs: 2000 }));
    } finally {
      await s.close();
    }
  });
});

describe("ssrf matrix: the refusal happens before any connection", () => {
  it("a stub server on loopback sees zero hits when the policy refuses it", async () => {
    const s = await startStub((req, res) => res.end("secret"));
    try {
      await refused(guardedRequest(`http://127.0.0.1:${s.port}/`, opts()));
      await refused(guardedRequest(`http://localhost:${s.port}/`, opts()));
      await refused(guardedRequest(`http://[::ffff:127.0.0.1]:${s.port}/`, opts()));
      await refused(guardedRequest(`http://2130706433:${s.port}/`, opts()));
      await refused(guardedRequest(`http://0x7f.1:${s.port}/`, opts(stubResolver({}))));
      assert.equal(s.hits.length, 0);
    } finally {
      await s.close();
    }
  });
});

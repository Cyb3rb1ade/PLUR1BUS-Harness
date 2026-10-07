import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { guardedRequest, makePinnedLookup } from "../../../src/tools/web/http.ts";
import { makeAddressPolicy, systemResolver } from "../../../src/tools/web/guard.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import { startStub, stubResolver, never } from "./helpers.ts";

const loopback = makeAddressPolicy(["127.0.0.0/8"]);
const base = { policy: loopback, resolver: systemResolver, userAgent: "PLUR1BUS/test (+https://plur1bus.app/bot)", timeoutMs: 5000 };
const fails = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code, `expected ${code}`);

describe("http: happy path", () => {
  it("fetches from a local stub, sends only the fixed headers, returns body and metadata", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("hello");
    });
    try {
      const r = await guardedRequest(`http://127.0.0.1:${s.port}/a?b=1`, base);
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), "hello");
      assert.equal(r.url, `http://127.0.0.1:${s.port}/a?b=1`);
      assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
      const h = s.hits[0]!.headers;
      assert.equal(h["user-agent"], base.userAgent);
      assert.equal(h.host, `127.0.0.1:${s.port}`);
      assert.equal(h.cookie, undefined);
      assert.equal(h.authorization, undefined);
    } finally {
      await s.close();
    }
  });

  it("decodes gzip, deflate and br bodies", async () => {
    const s = await startStub((req, res) => {
      const enc = req.url!.slice(1);
      const raw = Buffer.from("compressed hello");
      const body = enc === "gzip" ? gzipSync(raw) : enc === "deflate" ? deflateSync(raw) : brotliCompressSync(raw);
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": enc });
      res.end(body);
    });
    try {
      for (const enc of ["gzip", "deflate", "br"]) {
        const r = await guardedRequest(`http://127.0.0.1:${s.port}/${enc}`, base);
        assert.equal(r.body.toString(), "compressed hello", enc);
      }
    } finally {
      await s.close();
    }
  });

  it("returns non-2xx responses to the caller without a body", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("nope");
    });
    try {
      const r = await guardedRequest(`http://127.0.0.1:${s.port}/`, base);
      assert.equal(r.status, 404);
      assert.equal(r.body.length, 0);
    } finally {
      await s.close();
    }
  });

  it("an unknown content-encoding is refused as unsupported-type", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
      res.end("x");
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, base), "unsupported-type");
    } finally {
      await s.close();
    }
  });
});

describe("http: the connect is pinned to the vetted address", () => {
  it("connects to the resolver's address for a name the system cannot resolve", async () => {
    const s = await startStub((req, res) => res.end("pinned"));
    const resolver = stubResolver({ "pinned.test": ["127.0.0.1"] });
    try {
      const r = await guardedRequest(`http://pinned.test:${s.port}/`, { ...base, resolver });
      assert.equal(r.body.toString(), "pinned");
      assert.equal(s.hits[0]!.headers.host, `pinned.test:${s.port}`, "Host header keeps the name");
      assert.deepEqual(resolver.calls, ["pinned.test"]);
    } finally {
      await s.close();
    }
  });

  it("DNS rebinding: a resolver that flips to another address after the check is never asked again", async () => {
    let a: Awaited<ReturnType<typeof startStub>>;
    try {
      a = await startStub((req, res) => res.end("A"), "127.0.0.1");
    } catch {
      return;
    }
    let b: Awaited<ReturnType<typeof startStub>> | undefined;
    try {
      b = await startStub((req, res) => res.end("B"), "127.0.0.2", a.port);
    } catch {
      await a.close();
      return; // 127.0.0.2 is not bindable on this OS (macOS): the unit test of the lookup below still covers the pin
    }
    let calls = 0;
    const flipping = async () => [{ address: ++calls === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 as const }];
    try {
      const r = await guardedRequest(`http://flip.test:${a.port}/`, { ...base, resolver: flipping });
      assert.equal(r.body.toString(), "A");
      assert.equal(calls, 1);
      assert.equal(b.hits.length, 0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("the lookup handed to the socket can only ever return the pinned address", () => {
    const lookup = makePinnedLookup({ address: "203.0.113.7", family: 4 });
    lookup("attacker.example", {}, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, "203.0.113.7");
      assert.equal(family, 4);
    });
    lookup("other.example", { all: true }, (err, list) => {
      assert.equal(err, null);
      assert.deepEqual(list, [{ address: "203.0.113.7", family: 4 }]);
    });
  });
});

describe("http: redirects", () => {
  it("follows a chain, resolving relative Location, and reports the hops", async () => {
    const s = await startStub((req, res) => {
      if (req.url === "/a") return void res.writeHead(301, { location: "/b" }).end();
      if (req.url === "/b") return void res.writeHead(302, { location: `http://127.0.0.1:${s.port}/c` }).end();
      res.writeHead(200, { "content-type": "text/plain" }).end("end");
    });
    try {
      const r = await guardedRequest(`http://127.0.0.1:${s.port}/a`, base);
      assert.equal(r.body.toString(), "end");
      assert.equal(r.url, `http://127.0.0.1:${s.port}/c`);
      assert.deepEqual(r.redirects, [`http://127.0.0.1:${s.port}/a`, `http://127.0.0.1:${s.port}/b`]);
    } finally {
      await s.close();
    }
  });

  it("limits the number of hops", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "/loop" }).end());
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/loop`, { ...base, maxRedirects: 3 }), "too-many-redirects");
      assert.equal(s.hits.length, 4); // initial + 3 followed hops
    } finally {
      await s.close();
    }
  });

  it("default limit is 10 hops", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "/loop" }).end());
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/loop`, base), "too-many-redirects");
      assert.equal(s.hits.length, 11);
    } finally {
      await s.close();
    }
  });

  it("re-checks every hop: a redirect to the metadata address is refused and never dialled", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end());
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, base), "private-address");
    } finally {
      await s.close();
    }
  });

  it("re-checks every hop: a redirect to a name that resolves to a private address is refused", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "http://internal.test/admin" }).end());
    const resolver = stubResolver({ "internal.test": ["10.1.2.3"] });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, resolver }), "private-address");
      assert.deepEqual(resolver.calls, ["internal.test"]);
    } finally {
      await s.close();
    }
  });

  it("refuses a redirect to a non-http scheme", async () => {
    for (const loc of ["file:///etc/passwd", "ftp://127.0.0.1/x", "gopher://127.0.0.1/"]) {
      const s = await startStub((req, res) => res.writeHead(302, { location: loc }).end());
      try {
        await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, base), "egress-denied");
      } finally {
        await s.close();
      }
    }
  });

  it("refuses credentials smuggled in via a redirect", async () => {
    const s = await startStub((req, res) => res.writeHead(302, { location: "http://user:pw@example.test/" }).end());
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, resolver: never }), "invalid-url");
    } finally {
      await s.close();
    }
  });

  it("a redirect without Location is returned as-is", async () => {
    const s = await startStub((req, res) => res.writeHead(302).end());
    try {
      assert.equal((await guardedRequest(`http://127.0.0.1:${s.port}/`, base)).status, 302);
    } finally {
      await s.close();
    }
  });
});

describe("http: input URL validation", () => {
  it("refuses non-http schemes, credentials and garbage before any lookup", async () => {
    const opts = { ...base, resolver: never };
    await fails(guardedRequest("file:///etc/passwd", opts), "egress-denied");
    await fails(guardedRequest("ftp://example.test/", opts), "egress-denied");
    await fails(guardedRequest("javascript:alert(1)", opts), "egress-denied");
    await fails(guardedRequest("http://user:pw@example.test/", opts), "invalid-url");
    await fails(guardedRequest("not a url", opts), "invalid-url");
    await fails(guardedRequest("http://", opts), "invalid-url");
  });
});

describe("http: size limits", () => {
  it("refuses when Content-Length already exceeds the cap, without reading the body", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "5000" });
      res.write("x".repeat(100)); // never finishes
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, maxBytes: 1000 }), "too-large");
    } finally {
      await s.close();
    }
  });

  it("stops a chunked body that grows past the cap", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const t = setInterval(() => res.write("y".repeat(400)), 5);
      res.on("close", () => clearInterval(t));
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, maxBytes: 1000 }), "too-large");
    } finally {
      await s.close();
    }
  });

  it("counts DECOMPRESSED bytes: a small gzip bomb is refused", async () => {
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x61));
    assert.ok(bomb.length < 20_000);
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(bomb);
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, maxBytes: 64 * 1024 }), "too-large");
    } finally {
      await s.close();
    }
  });

  it("a body exactly at the cap is accepted", async () => {
    const s = await startStub((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("z".repeat(1000)));
    try {
      assert.equal((await guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, maxBytes: 1000 })).body.length, 1000);
    } finally {
      await s.close();
    }
  });
});

describe("http: time limits", () => {
  it("times out a server that never answers", async () => {
    const s = await startStub(() => {});
    try {
      const t0 = Date.now();
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, timeoutMs: 150 }), "timeout");
      assert.ok(Date.now() - t0 < 2000);
    } finally {
      await s.close();
    }
  });

  it("the deadline covers a slow-drip body, not just the first byte", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const t = setInterval(() => res.write("."), 20);
      res.on("close", () => clearInterval(t));
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, timeoutMs: 200 }), "timeout");
    } finally {
      await s.close();
    }
  });

  it("the deadline is shared across redirect hops", async () => {
    const s = await startStub((req, res) => {
      const n = Number(req.url!.slice(1));
      setTimeout(() => res.writeHead(302, { location: `/${n + 1}` }).end(), 60);
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/0`, { ...base, timeoutMs: 250 }), "timeout");
    } finally {
      await s.close();
    }
  });

  it("an already-aborted caller signal is honoured", async () => {
    const s = await startStub((req, res) => res.end("x"));
    try {
      const ac = new AbortController();
      ac.abort();
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, signal: ac.signal }), "timeout");
    } finally {
      await s.close();
    }
  });
});

describe("http: content-type gate", () => {
  it("rejects before reading the body when acceptType says no", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("binary");
    });
    try {
      await fails(guardedRequest(`http://127.0.0.1:${s.port}/`, { ...base, acceptType: (ct) => ct?.startsWith("text/") === true }), "unsupported-type");
    } finally {
      await s.close();
    }
  });
});

describe("http: network errors", () => {
  it("connection refused is a typed network-error", async () => {
    const s = await startStub(() => {});
    const port = s.port;
    await s.close();
    await fails(guardedRequest(`http://127.0.0.1:${port}/`, base), "network-error");
  });
});

describe("http: TLS keeps verifying the hostname while connecting to the pinned address", () => {
  const dir = mkdtempSync(join(tmpdir(), "p1-tls-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let cert = "";
  let key = "";
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=secure.test", "-addext", "subjectAltName=DNS:secure.test"], { stdio: "ignore" });
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    key = readFileSync(join(dir, "k.pem"), "utf8");
  } catch {
    /* openssl unavailable: the tests below skip */
  }
  const skip = cert === "" ? "openssl not available" : false;

  async function tlsStub(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = https.createServer({ cert, key }, (req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("secure"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  }

  it("accepts a certificate for the NAME (SNI + verification) when it is trusted", { skip }, async () => {
    const s = await tlsStub();
    try {
      const r = await guardedRequest(`https://secure.test:${s.port}/`, { ...base, resolver: stubResolver({ "secure.test": ["127.0.0.1"] }), tlsCa: cert });
      assert.equal(r.body.toString(), "secure");
    } finally {
      await s.close();
    }
  });

  it("an untrusted certificate is a tls-error", { skip }, async () => {
    const s = await tlsStub();
    try {
      await fails(guardedRequest(`https://secure.test:${s.port}/`, { ...base, resolver: stubResolver({ "secure.test": ["127.0.0.1"] }) }), "tls-error");
    } finally {
      await s.close();
    }
  });

  it("a certificate for another name is a tls-error even when trusted", { skip }, async () => {
    const s = await tlsStub();
    try {
      await fails(guardedRequest(`https://other.test:${s.port}/`, { ...base, resolver: stubResolver({ "other.test": ["127.0.0.1"] }), tlsCa: cert }), "tls-error");
    } finally {
      await s.close();
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWebFetch, DocStore, type WebFetchResult } from "../../../src/tools/web/fetch.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import { HostPacer } from "../../../src/tools/web/robots.ts";
import { startStub } from "./helpers.ts";

const allow = ["127.0.0.0/8"];
const mk = (extra: Record<string, unknown> = {}) => createWebFetch({ allowPrivate: allow, timeoutMs: 5000, version: "9.9.9", ...extra });
const fails = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code, `expected ${code}`);

const page = (body: string, head = "") => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const send = (ct: string, body: string | Buffer, status = 200, extra: Record<string, string> = {}) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(status, { "content-type": ct, ...extra });
  res.end(body);
};

describe("web.fetch: happy path", () => {
  it("returns Markdown, metadata, sections and a provenance envelope; sends the honest User-Agent", async () => {
    const s = await startStub(send("text/html; charset=utf-8", page("<main><h1>Hello</h1><p>World <a href='/x'>link</a></p></main>")));
    try {
      const url = `http://127.0.0.1:${s.port}/p`;
      const r = await mk({ now: () => Date.parse("2026-10-06T10:00:00Z") }).fetch({ url });
      assert.equal(r.markdown, `# Hello\n\nWorld [link](http://127.0.0.1:${s.port}/x)`);
      assert.equal(r.finalUrl, url);
      assert.equal(r.status, 200);
      assert.equal(r.contentType, "text/html");
      assert.equal(r.title, "T");
      assert.equal(r.lang, "en");
      assert.equal(r.renderUsed, false);
      assert.equal(r.fromCache, false);
      assert.equal(r.fetchedAt, "2026-10-06T10:00:00.000Z");
      assert.deepEqual(r.provenance, { source: "web", url, fetchedAt: "2026-10-06T10:00:00.000Z", trust: "untrusted" });
      assert.deepEqual(r.sections.map((x) => x.title), ["Hello"]);
      assert.equal(r.cursor, undefined);
      assert.equal(s.hits[0]!.headers["user-agent"], "PLUR1BUS/9.9.9 (+https://plur1bus.app/bot)");
      assert.equal(s.hits.length, 1, "a single page does not consult robots.txt");
    } finally {
      await s.close();
    }
  });

  it("detects the charset from the header", async () => {
    const s = await startStub(send("text/html; charset=iso-8859-1", Buffer.concat([Buffer.from("<html><body><p>caf"), Buffer.from([0xe9]), Buffer.from("</p></body></html>")])));
    try {
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${s.port}/` })).markdown, "café");
    } finally {
      await s.close();
    }
  });

  it("JSON is pretty-printed, plain text and Markdown are returned as they are", async () => {
    const s = await startStub((req, res) => {
      if (req.url === "/j") return send("application/vnd.api+json", '{"a":1,"b":[2]}')(req, res);
      if (req.url === "/t") return send("text/plain", "plain  text\nline2")(req, res);
      if (req.url === "/m") return send("text/markdown", "# Doc\n\ntext")(req, res);
      if (req.url === "/x") return send("application/xml", "<a><b>1</b></a>")(req, res);
      send("text/csv", "a,b\n1,2")(req, res);
    });
    try {
      const f = mk();
      const u = (p: string) => `http://127.0.0.1:${s.port}${p}`;
      assert.equal((await f.fetch({ url: u("/j") })).markdown, '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
      assert.equal((await f.fetch({ url: u("/t") })).markdown, "plain  text\nline2");
      assert.equal((await f.fetch({ url: u("/m") })).markdown, "# Doc\n\ntext");
      assert.equal((await f.fetch({ url: u("/x") })).markdown, "<a><b>1</b></a>");
      assert.equal((await f.fetch({ url: u("/c") })).markdown, "a,b\n1,2");
    } finally {
      await s.close();
    }
  });

  it("mode raw returns the decoded HTML untouched", async () => {
    const html = page("<p>x</p>");
    const s = await startStub(send("text/html", html));
    try {
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${s.port}/`, mode: "raw" })).markdown, html);
    } finally {
      await s.close();
    }
  });

  it("redirects are followed and finalUrl reports where it ended", async () => {
    const s = await startStub((req, res) => (req.url === "/old" ? void res.writeHead(301, { location: "/new" }).end() : send("text/plain", "ok")(req, res)));
    try {
      const r = await mk().fetch({ url: `http://127.0.0.1:${s.port}/old` });
      assert.equal(r.finalUrl, `http://127.0.0.1:${s.port}/new`);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: content-type allowlist", () => {
  const cases: Array<[string, string | Buffer]> = [
    ["application/pdf", "%PDF-1.7"],
    ["image/png", Buffer.from([0x89, 0x50])],
    ["application/octet-stream", "x"],
    ["application/zip", "PK"],
    ["text/javascript", "alert(1)"],
    ["video/mp4", "x"],
  ];
  for (const [ct, body] of cases) {
    it(`${ct} → unsupported-type`, async () => {
      const s = await startStub(send(ct, body));
      try {
        await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/` }), "unsupported-type");
      } finally {
        await s.close();
      }
    });
  }
  it("a missing content type is sniffed: text passes, binary is refused", async () => {
    const s = await startStub((req, res) => {
      res.writeHead(200);
      res.end(req.url === "/bin" ? Buffer.from([1, 2, 0, 3, 0, 0]) : "just text");
    });
    try {
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${s.port}/t` })).markdown, "just text");
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/bin` }), "unsupported-type");
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: typed failures carry a hint and a userAction", () => {
  const cases: Array<[number, string, Record<string, string>?]> = [
    [404, "not-found"],
    [410, "gone"],
    [401, "auth-required"],
    [403, "auth-required"],
    [402, "paywall"],
    [429, "rate-limited", { "retry-after": "120" }],
    [408, "timeout"],
    [500, "http-error"],
    [503, "http-error"],
    [418, "http-error"],
  ];
  for (const [status, code, headers] of cases) {
    it(`HTTP ${status} → ${code}`, async () => {
      const s = await startStub((req, res) => res.writeHead(status, headers ?? {}).end("x"));
      try {
        await assert.rejects(mk().fetch({ url: `http://127.0.0.1:${s.port}/` }), (e: unknown) => {
          assert.ok(e instanceof WebFailure);
          assert.equal(e.code, code);
          assert.ok(e.hint.length > 10 && e.userAction.length > 10);
          assert.equal(e.extra.status, status);
          if (status === 429) assert.equal(e.extra.retryAfterSeconds, 120);
          return true;
        });
      } finally {
        await s.close();
      }
    });
  }
  it("Retry-After as an HTTP date is converted against the injected clock", async () => {
    const s = await startStub((req, res) => res.writeHead(429, { "retry-after": "Tue, 06 Oct 2026 10:02:00 GMT" }).end());
    try {
      await assert.rejects(mk({ now: () => Date.parse("2026-10-06T10:00:00Z") }).fetch({ url: `http://127.0.0.1:${s.port}/` }), (e: unknown) => (e as WebFailure).extra.retryAfterSeconds === 120);
    } finally {
      await s.close();
    }
  });
  it("a client-rendered shell and an empty page are needs-render, never an empty success", async () => {
    const s = await startStub((req, res) => send("text/html", req.url === "/empty" ? page("") : page('<div id="root"></div><script src="/app.js"></script>'))(req, res));
    try {
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/spa` }), "needs-render");
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/empty` }), "needs-render");
    } finally {
      await s.close();
    }
  });
  it("too-large for the download and for the extracted text", async () => {
    const s = await startStub(send("text/plain", "a".repeat(5000)));
    try {
      await fails(mk({ maxBytes: 1000 }).fetch({ url: `http://127.0.0.1:${s.port}/` }), "too-large");
      await fails(mk({ maxExtractedTokens: 100 }).fetch({ url: `http://127.0.0.1:${s.port}/` }), "too-large");
    } finally {
      await s.close();
    }
  });
  it("timeout, network error, TLS, invalid arguments", async () => {
    const hang = await startStub(() => {});
    try {
      await fails(mk({ timeoutMs: 120 }).fetch({ url: `http://127.0.0.1:${hang.port}/` }), "timeout");
    } finally {
      await hang.close();
    }
    const port = hang.port;
    await fails(mk().fetch({ url: `http://127.0.0.1:${port}/` }), "network-error");
    await fails(mk().fetch({ url: "ftp://example.test/" }), "egress-denied");
    await fails(mk().fetch({ url: "" }), "invalid-arguments");
    await fails(mk().fetch({ url: "http://x.test/", mode: "render" as never }), "invalid-arguments");
    await fails(mk().fetch({ url: "http://x.test/", maxTokens: 0 }), "invalid-arguments");
  });
  it("the failure result is a structured isError value without a stack", () => {
    const r = new WebFailure("private-address", "x").toResult();
    assert.equal(r.isError, true);
    assert.deepEqual(Object.keys(r.error).sort(), ["code", "hint", "message", "userAction"]);
  });
});

describe("web.fetch: private addresses are refused by default", () => {
  it("no allowlist → the loopback stub is never contacted", async () => {
    const s = await startStub(send("text/plain", "secret"));
    try {
      await fails(createWebFetch({}).fetch({ url: `http://127.0.0.1:${s.port}/` }), "private-address");
      await fails(createWebFetch({}).fetch({ url: `http://localhost:${s.port}/` }), "private-address");
      assert.equal(s.hits.length, 0);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: sections, never silent truncation", () => {
  const para = (n: number) => `Paragraph ${n}. ` + "lorem ipsum dolor sit amet ".repeat(30);
  const longDoc = (sections: number) => page("<main>" + Array.from({ length: sections }, (_, i) => `<h2>Part ${i}</h2><p>${para(i)}</p><p>${para(i + 100)}</p>`).join("") + "</main>");

  it("a long document comes back in chunks; following the cursor reassembles all of it", async () => {
    const s = await startStub(send("text/html", longDoc(12)));
    try {
      const f = mk();
      const url = `http://127.0.0.1:${s.port}/long`;
      const first = await f.fetch({ url, maxTokens: 500 });
      assert.ok(first.cursor, "first chunk carries a cursor");
      assert.equal(first.sections.length, 12, "the full table of contents is in the first answer");
      assert.ok(first.sections.every((x) => x.tokens > 0));
      const parts = [first.markdown];
      let cursor: string | undefined = first.cursor;
      let guard = 0;
      let last: WebFetchResult = first;
      while (cursor && guard++ < 100) {
        last = await f.fetch({ url, cursor, maxTokens: 500 });
        assert.equal(last.fromCache, true);
        assert.ok(Math.ceil(last.markdown.length / 4) <= 500 + 5);
        parts.push(last.markdown);
        cursor = last.cursor;
      }
      assert.equal(s.hits.length, 1, "the continuation does not refetch");
      const whole = (await mk().fetch({ url, maxTokens: 50_000 })).markdown;
      assert.equal(parts.join("\n\n"), whole, "no byte of the document is lost");
    } finally {
      await s.close();
    }
  });

  it("the default budget is 6 000 tokens", async () => {
    const s = await startStub(send("text/html", longDoc(60)));
    try {
      const r = await mk().fetch({ url: `http://127.0.0.1:${s.port}/` });
      assert.ok(r.cursor);
      assert.ok(Math.ceil(r.markdown.length / 4) <= 6005);
    } finally {
      await s.close();
    }
  });

  it("section jumps to one section by id (and by title)", async () => {
    const s = await startStub(send("text/html", longDoc(5)));
    try {
      const f = mk();
      const url = `http://127.0.0.1:${s.port}/`;
      const r = await f.fetch({ url, section: "s2" });
      assert.ok(r.markdown.startsWith("## Part 2"));
      assert.ok(!r.markdown.includes("Part 3"));
      assert.ok((await f.fetch({ url, section: "part 4" })).markdown.startsWith("## Part 4"));
      await assert.rejects(f.fetch({ url, section: "nope" }), (e: unknown) => e instanceof WebFailure && e.code === "invalid-arguments" && /s0/.test(e.message));
    } finally {
      await s.close();
    }
  });

  it("cursors expire with the injected clock, are bound to the agent, and garbage is refused", async () => {
    const s = await startStub(send("text/html", longDoc(12)));
    let t = 0;
    try {
      const store = new DocStore({ ttlMs: 60_000, now: () => t });
      const f = mk({ store, now: () => t });
      const url = `http://127.0.0.1:${s.port}/`;
      const first = await f.fetch({ url, maxTokens: 300 }, { agentId: "a" });
      await fails(f.fetch({ url, cursor: first.cursor!, maxTokens: 300 }, { agentId: "b" }), "cursor-expired");
      await fails(f.fetch({ url, cursor: "bogus", maxTokens: 300 }, { agentId: "a" }), "cursor-expired");
      await fails(f.fetch({ url, cursor: first.cursor!.replace(/[0-9a-f]$/, "!"), maxTokens: 300 }, { agentId: "a" }), "cursor-expired");
      assert.ok((await f.fetch({ url, cursor: first.cursor!, maxTokens: 300 }, { agentId: "a" })).markdown.length > 0);
      t += 61_000;
      await fails(f.fetch({ url, cursor: first.cursor!, maxTokens: 300 }, { agentId: "a" }), "cursor-expired");
    } finally {
      await s.close();
    }
  });

  it("the store is bounded", () => {
    const store = new DocStore({ maxDocs: 2, ttlMs: 1000, now: () => 0 });
    const ids = [1, 2, 3].map((n) => store.put("a", { text: `d${n}`, meta: {} as never }));
    assert.equal(store.get("a", ids[0]!), undefined);
    assert.ok(store.get("a", ids[2]!));
  });
});

describe("web.fetch: crawl mode honours robots.txt and paces", () => {
  const site = (robots: { status: number; body?: string }) =>
    startStub((req, res) => {
      if (req.url === "/robots.txt") return void res.writeHead(robots.status, { "content-type": "text/plain" }).end(robots.body ?? "");
      send("text/plain", "page " + req.url)(req, res);
    });

  it("disallowed path → robots-disallowed and the page is never requested", async () => {
    const s = await site({ status: 200, body: "User-agent: *\nDisallow: /private\n" });
    try {
      const f = mk();
      await fails(f.fetch({ url: `http://127.0.0.1:${s.port}/private/a`, crawl: true }), "robots-disallowed");
      assert.deepEqual(s.hits.map((h) => h.url), ["/robots.txt"]);
      assert.equal((await f.fetch({ url: `http://127.0.0.1:${s.port}/open`, crawl: true })).markdown, "page /open");
    } finally {
      await s.close();
    }
  });
  it("a plain fetch ignores robots.txt entirely (the person asked for this page)", async () => {
    const s = await site({ status: 200, body: "User-agent: *\nDisallow: /\n" });
    try {
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${s.port}/x` })).markdown, "page /x");
      assert.deepEqual(s.hits.map((h) => h.url), ["/x"]);
    } finally {
      await s.close();
    }
  });
  it("robots.txt 404 means allowed; 5xx means disallowed (RFC 9309)", async () => {
    const a = await site({ status: 404 });
    const b = await site({ status: 503 });
    try {
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${a.port}/x`, crawl: true })).markdown, "page /x");
      await fails(mk().fetch({ url: `http://127.0.0.1:${b.port}/x`, crawl: true }), "robots-disallowed");
    } finally {
      await a.close();
      await b.close();
    }
  });
  it("robots.txt is cached per host and requests are paced on the injected clock", async () => {
    const s = await site({ status: 200, body: "User-agent: *\nCrawl-delay: 2\n" });
    let t = 0;
    const slept: number[] = [];
    const pacer = new HostPacer({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    try {
      const f = mk({ pacer, now: () => t });
      await f.fetch({ url: `http://127.0.0.1:${s.port}/1`, crawl: true });
      await f.fetch({ url: `http://127.0.0.1:${s.port}/2`, crawl: true });
      assert.equal(s.hits.filter((h) => h.url === "/robots.txt").length, 1);
      assert.deepEqual(slept, [2000]);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: the trace has URL, status, sizes, timing — never the body", () => {
  it("emits one event per fetch", async () => {
    const s = await startStub(send("text/plain", "TOP-SECRET-BODY"));
    const events: Array<Record<string, unknown>> = [];
    try {
      await mk({ trace: (e: Record<string, unknown>) => events.push(e) }).fetch({ url: `http://127.0.0.1:${s.port}/a?q=1` });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.url, `http://127.0.0.1:${s.port}/a?q=1`);
      assert.equal(events[0]!.status, 200);
      assert.equal(events[0]!.bytes, 15);
      assert.equal(typeof events[0]!.ms, "number");
      assert.ok(!JSON.stringify(events).includes("TOP-SECRET"));
    } finally {
      await s.close();
    }
  });
  it("also emits for failures, with the code", async () => {
    const s = await startStub((req, res) => res.writeHead(404).end());
    const events: Array<Record<string, unknown>> = [];
    try {
      await mk({ trace: (e: Record<string, unknown>) => events.push(e) }).fetch({ url: `http://127.0.0.1:${s.port}/` }).catch(() => {});
      assert.equal(events[0]!.error, "not-found");
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: the metadata around a chunk is bounded too (maxTokens bounds only the text)", () => {
  it("a huge title/lang/date/canonical and thousands of headings do not blow up every result", async () => {
    const big = "x".repeat(200_000);
    const headings = Array.from({ length: 5000 }, (_, i) => `<h2>${"Heading ".repeat(4)}${i}</h2><p>t</p>`).join("");
    const html = `<!doctype html><html lang="${big}"><head><title>${big}</title><meta property="article:published_time" content="${big}"><link rel="canonical" href="http://e.test/${big}"></head><body><main>${headings}</main></body></html>`;
    const s = await startStub(send("text/html", html));
    try {
      const r = await mk().fetch({ url: `http://127.0.0.1:${s.port}/`, maxTokens: 200 });
      const size = Buffer.byteLength(JSON.stringify(r));
      assert.ok(size < 40_000, `result is ${size} bytes`);
      assert.ok((r.title ?? "").length <= 300);
      assert.ok((r.lang ?? "").length <= 35);
      assert.ok((r.publishedAt ?? "").length <= 64);
      assert.ok(r.sections.length <= 200);
      assert.ok(r.sections.every((x) => x.title.length <= 120));
    } finally {
      await s.close();
    }
  });
  it("a section beyond the listed ones can still be selected by id", async () => {
    const headings = Array.from({ length: 400 }, (_, i) => `<h2>H${i}</h2><p>body ${i}</p>`).join("");
    const s = await startStub(send("text/html", page(`<main>${headings}</main>`)));
    try {
      const r = await mk().fetch({ url: `http://127.0.0.1:${s.port}/`, section: "s350" });
      assert.match(r.markdown, /body 349|body 350/);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: the egress gate applies to every request it makes", () => {
  it("a gate that refuses a port stops the page and the robots.txt request; nothing reaches the server", async () => {
    const s = await startStub(send("text/plain", "page"));
    try {
      const seen: string[] = [];
      const gate = {
        beforeResolve(u: URL) { seen.push(u.pathname); throw new WebFailure("egress-denied", "port not allowed"); },
        afterResolve() {},
      };
      await fails(mk({ gate }).fetch({ url: `http://127.0.0.1:${s.port}/a` }), "egress-denied");
      await fails(mk({ gate }).fetch({ url: `http://127.0.0.1:${s.port}/a`, crawl: true }), "robots-disallowed");
      assert.deepEqual(seen, ["/a", "/robots.txt"]);
      assert.equal(s.hits.length, 0);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch: walls, sniffing and long documents (corpus regressions)", () => {
  const html = (body: string, head = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
  const serve = async (status: number, ct: string, body: string | Buffer, headers: Record<string, string> = {}) => startStub(send(ct, body, status, headers));

  it("a CAPTCHA page is captcha whatever its status; a 429 with a CAPTCHA keeps Retry-After; a plain 429 stays rate-limited", async () => {
    const wall = html('<main><h1>Verify</h1><div class="h-captcha"></div></main>');
    const s = await serve(429, "text/html", wall, { "retry-after": "30" });
    const plain = await serve(429, "text/plain", "slow down", { "retry-after": "30" });
    try {
      await assert.rejects(mk().fetch({ url: `http://127.0.0.1:${s.port}/` }), (e: unknown) => e instanceof WebFailure && e.code === "captcha" && e.extra.status === 429 && e.extra.retryAfterSeconds === 30);
      await fails(mk().fetch({ url: `http://127.0.0.1:${plain.port}/` }), "rate-limited");
    } finally {
      await s.close();
      await plain.close();
    }
  });

  it("a 403 sign-in page and a 200 sign-in wall are both auth-required", async () => {
    const form = html('<main><h1>Sign in</h1><form><input type="password"></form></main>');
    const a = await serve(403, "text/html", form);
    const b = await serve(200, "text/html", form);
    try {
      await fails(mk().fetch({ url: `http://127.0.0.1:${a.port}/` }), "auth-required");
      await fails(mk().fetch({ url: `http://127.0.0.1:${b.port}/` }), "auth-required");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a teaser with a visible paywall prompt is paywall, with the status; the same markup in a full article is returned", async () => {
    const teaser = html('<main><article class="paywalled"><h1>Story</h1><p>Two sentences. Then it stops.</p><div class="paywall">Subscribe to keep reading</div></article></main>');
    const full = html(`<main><article><h1>Story</h1><p>${"A full paragraph of real text. ".repeat(80)}</p><div class="paywall" style="display:none">Subscribe</div></article></main>`);
    const a = await serve(200, "text/html", teaser);
    const b = await serve(200, "text/html", full);
    try {
      await assert.rejects(mk().fetch({ url: `http://127.0.0.1:${a.port}/` }), (e: unknown) => e instanceof WebFailure && e.code === "paywall" && e.extra.status === 200);
      assert.match((await mk().fetch({ url: `http://127.0.0.1:${b.port}/` })).markdown, /full paragraph/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("an HTML page labelled octet-stream or text/plain is read as HTML; other octet-streams and binary files under any label are refused", async () => {
    const page = html("<main><h1>Real page</h1><p>Content.</p></main>");
    const o = await serve(200, "application/octet-stream", page);
    const p = await serve(200, "text/plain", page);
    const pdf = await serve(200, "text/html", "%PDF-1.7\n1 0 obj");
    const zip = await serve(200, "text/plain", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    const text = await serve(200, "text/plain", "RIFF notes and GIF8 tips are ordinary text");
    try {
      assert.match((await mk().fetch({ url: `http://127.0.0.1:${o.port}/` })).markdown, /^# Real page/);
      assert.match((await mk().fetch({ url: `http://127.0.0.1:${p.port}/` })).markdown, /^# Real page/);
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${p.port}/`, mode: "raw" })).markdown, page, "raw mode never reinterprets");
      await fails(mk().fetch({ url: `http://127.0.0.1:${pdf.port}/` }), "unsupported-type");
      await fails(mk().fetch({ url: `http://127.0.0.1:${zip.port}/` }), "unsupported-type");
      assert.match((await mk().fetch({ url: `http://127.0.0.1:${text.port}/` })).markdown, /^RIFF notes/);
    } finally {
      for (const s of [o, p, pdf, zip, text]) await s.close();
    }
  });

  it("a document with more sections than the table of contents lists says how many there are, and the ids beyond the list still work", async () => {
    const body = Array.from({ length: 250 }, (_, i) => `<h2>Part ${i}</h2><p>Text of part ${i}.</p>`).join("");
    const s = await serve(200, "text/html", html(`<main><h1>Big</h1>${body}</main>`));
    try {
      const r = await mk().fetch({ url: `http://127.0.0.1:${s.port}/` });
      assert.equal(r.sections.length, 200);
      assert.equal(r.sectionsTotal, 251);
      const last = await mk().fetch({ url: `http://127.0.0.1:${s.port}/`, section: "Part 249" });
      assert.match(last.markdown, /Text of part 249/);
      assert.equal((await mk().fetch({ url: `http://127.0.0.1:${s.port}/` })).sectionsTotal, 251);
    } finally {
      await s.close();
    }
  });

  it("chunks end at a paragraph, line or word boundary: the cursor walk gives back every word", async () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    const s = await serve(200, "text/plain", words);
    try {
      const f = mk();
      let r = await f.fetch({ url: `http://127.0.0.1:${s.port}/`, maxTokens: 500 });
      const got: string[] = [r.markdown];
      while (r.cursor) {
        r = await f.fetch({ url: `http://127.0.0.1:${s.port}/`, cursor: r.cursor, maxTokens: 500 });
        got.push(r.markdown);
      }
      assert.ok(got.length > 3);
      assert.equal(got.join(" "), words);
    } finally {
      await s.close();
    }
  });

  it("an unexpected exception is traced as internal-error, not as a network error", async () => {
    const events: string[] = [];
    class Faulty extends DocStore {
      override put(): string {
        throw new Error("boom");
      }
    }
    const s = await serve(200, "text/plain", "x ".repeat(5000));
    try {
      await assert.rejects(mk({ store: new Faulty(), trace: (e: { error?: string }) => events.push(String(e.error)) }).fetch({ url: `http://127.0.0.1:${s.port}/`, maxTokens: 100 }), /boom/);
      assert.deepEqual(events, ["internal-error"]);
    } finally {
      await s.close();
    }
  });
});

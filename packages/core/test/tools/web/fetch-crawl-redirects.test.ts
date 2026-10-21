// web.fetch with crawl: every redirect station is checked against robots.txt and paced like the first request, and the
// whole call (robots.txt, pacing wait, every hop, the body) shares one deadline (docs/web-tools.md).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWebFetch } from "../../../src/tools/web/fetch.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import { HostPacer } from "../../../src/tools/web/robots.ts";
import { startStub, type Stub } from "./helpers.ts";

const allow = ["127.0.0.0/8"];
const mk = (extra: Record<string, unknown> = {}) => createWebFetch({ allowPrivate: allow, timeoutMs: 5000, version: "9.9.9", ...extra });
const fails = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code, `expected ${code}`);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const text = (res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => void res.writeHead(status, { "content-type": "text/plain", ...headers }).end(body);
const redirect = (res: ServerResponse, location: string) => text(res, "", 302, { location });
/** A site: robots.txt as given, a redirect table, everything else answers "page <path>". */
const site = (robots: string | undefined, redirects: Record<string, string> = {}, extra?: Handler) =>
  startStub((req, res) => {
    if (req.url === "/robots.txt") return robots === undefined ? text(res, "", 404) : text(res, robots);
    const to = redirects[req.url ?? ""];
    if (to !== undefined) return redirect(res, to);
    if (extra) return extra(req, res);
    text(res, `page ${req.url}`);
  });
const paths = (s: Stub) => s.hits.map((h) => h.url);
/** A pacer on a fake clock that records which hosts were paced. */
const recordingPacer = () => {
  const waited: string[] = [];
  let t = 0;
  const pacer = new HostPacer({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { t += ms; } });
  const wait = pacer.wait.bind(pacer);
  pacer.wait = async (host, delay, signal) => { waited.push(host); return wait(host, delay, signal); };
  return { pacer, waited, now: () => t };
};

describe("web.fetch crawl: redirect stations are checked against robots.txt", () => {
  it("a redirect from an allowed page to a path robots.txt disallows is robots-disallowed and the target is never requested", async () => {
    const s = await site("User-agent: *\nDisallow: /private\n", { "/open": "/private/x" });
    try {
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/open`, crawl: true }), "robots-disallowed");
      assert.deepEqual(paths(s), ["/robots.txt", "/open"]);
    } finally {
      await s.close();
    }
  });

  it("a redirect to another host consults that host's robots.txt: disallowed there → refused, the page is never requested", async () => {
    const other = await site("User-agent: *\nDisallow: /page\n");
    const s = await site(undefined, { "/open": `http://127.0.0.1:${other.port}/page` });
    try {
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/open`, crawl: true }), "robots-disallowed");
      assert.deepEqual(paths(other), ["/robots.txt"]);
    } finally {
      await s.close();
      await other.close();
    }
  });

  it("an unreachable robots.txt on the redirect target is treated as disallow (RFC 9309), like for the first host", async () => {
    const broken = await startStub((req, res) => (req.url === "/robots.txt" ? text(res, "", 503) : text(res, "page")));
    const s = await site(undefined, { "/open": `http://127.0.0.1:${broken.port}/page` });
    try {
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/open`, crawl: true }), "robots-disallowed");
      assert.deepEqual(paths(broken), ["/robots.txt"]);
    } finally {
      await s.close();
      await broken.close();
    }
  });

  it("legitimate redirects keep working: same host and other host, both allowed", async () => {
    const other = await site("User-agent: *\nDisallow: /nope\n");
    const s = await site("User-agent: *\nDisallow: /private\n", { "/a": "/b", "/far": `http://127.0.0.1:${other.port}/ok` });
    try {
      const p = recordingPacer();
      const f = mk({ pacer: p.pacer, now: p.now });
      const near = await f.fetch({ url: `http://127.0.0.1:${s.port}/a`, crawl: true });
      assert.equal(near.markdown, "page /b");
      assert.equal(near.finalUrl, `http://127.0.0.1:${s.port}/b`);
      const far = await f.fetch({ url: `http://127.0.0.1:${s.port}/far`, crawl: true });
      assert.equal(far.markdown, "page /ok");
      assert.equal(far.finalUrl, `http://127.0.0.1:${other.port}/ok`);
      assert.equal(paths(s).filter((p) => p === "/robots.txt").length, 1, "robots.txt stays cached per host");
      assert.deepEqual(paths(other), ["/robots.txt", "/ok"]);
    } finally {
      await s.close();
      await other.close();
    }
  });

  it("every station is paced per host: the redirect hop waits its turn like the first request", async () => {
    const other = await site(undefined);
    const s = await site(undefined, { "/a": "/b", "/far": `http://127.0.0.1:${other.port}/ok` });
    try {
      const p = recordingPacer();
      const f = mk({ pacer: p.pacer, now: p.now });
      await f.fetch({ url: `http://127.0.0.1:${s.port}/a`, crawl: true });
      assert.deepEqual(p.waited, [`127.0.0.1:${s.port}`, `127.0.0.1:${s.port}`]);
      p.waited.length = 0;
      await f.fetch({ url: `http://127.0.0.1:${s.port}/far`, crawl: true });
      assert.deepEqual(p.waited, [`127.0.0.1:${s.port}`, `127.0.0.1:${other.port}`]);
    } finally {
      await s.close();
      await other.close();
    }
  });

  it("without crawl a redirect is followed with no robots.txt and no pacing (the person asked for this page)", async () => {
    const s = await site("User-agent: *\nDisallow: /\n", { "/a": "/b" });
    try {
      const p = recordingPacer();
      const r = await mk({ pacer: p.pacer }).fetch({ url: `http://127.0.0.1:${s.port}/a` });
      assert.equal(r.markdown, "page /b");
      assert.deepEqual(paths(s), ["/a", "/b"]);
      assert.deepEqual(p.waited, []);
    } finally {
      await s.close();
    }
  });
});

describe("web.fetch crawl: one deadline for the whole call", () => {
  it("robots.txt and the page share timeoutMs: two slow answers that each fit alone do not fit together", async () => {
    const slow: Handler = (req, res) => void setTimeout(() => (req.url === "/robots.txt" ? text(res, "") : text(res, "page")), 200);
    const s = await startStub(slow);
    try {
      const url = `http://127.0.0.1:${s.port}/p`;
      await fails(mk({ timeoutMs: 300 }).fetch({ url, crawl: true }), "timeout");
      assert.equal((await mk({ timeoutMs: 5000 }).fetch({ url: `${url}2`, crawl: true })).markdown, "page");
    } finally {
      await s.close();
    }
  });

  it("a pacing wait that outlasts the deadline ends the call with timeout; the page is never requested", { timeout: 10_000 }, async () => {
    const s = await site(undefined);
    try {
      const stuck = {
        wait: (_host: string, _ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("the wait was cancelled")), { once: true });
        }),
      };
      const t0 = Date.now();
      await fails(mk({ timeoutMs: 300, pacer: stuck }).fetch({ url: `http://127.0.0.1:${s.port}/p`, crawl: true }), "timeout");
      assert.ok(Date.now() - t0 < 3000, "ended near the deadline");
      assert.deepEqual(paths(s), ["/robots.txt"]);
    } finally {
      await s.close();
    }
  });

  it("the deadline also covers a robots.txt check and wait on a redirect hop", { timeout: 10_000 }, async () => {
    const hang: Handler = (req, res) => { if (req.url === "/robots.txt") return; text(res, "page"); }; // robots.txt never answers
    const other = await startStub(hang);
    const s = await site(undefined, { "/open": `http://127.0.0.1:${other.port}/page` });
    try {
      const t0 = Date.now();
      await fails(mk({ timeoutMs: 400 }).fetch({ url: `http://127.0.0.1:${s.port}/open`, crawl: true }), "timeout");
      assert.ok(Date.now() - t0 < 3000, "ended near the deadline, not after the 5 s robots.txt limit");
    } finally {
      await s.close();
      await other.close();
    }
  });

  it("a caller's signal still cancels the call", { timeout: 10_000 }, async () => {
    const s = await startStub((req, res) => { if (req.url !== "/robots.txt") return; text(res, ""); });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      await fails(mk().fetch({ url: `http://127.0.0.1:${s.port}/p`, crawl: true }, { signal: ac.signal }), "timeout");
    } finally {
      await s.close();
    }
  });
});

// M2 acceptance 12 / D94 "Quality gate": the web.fetch fixture corpus.
//
// `fixtures/web-fetch/` holds at least 60 synthetic pages (hand-written, no copied content) and a golden for each.
// Every page is served by an offline fixture server on loopback; the web.fetch under test is the production
// `createWebFetch`, configured to reach 127.0.0.0/8 only because this suite allowlists it. Nothing here needs a network.
//
// The gate, per golden: >= 95 % of its main-text tokens survive, every heading (same level, same order) and every
// table (same rows and cells) survives, links stay absolute, boilerplate named by the fixture does not leak. Every
// typed failure of D94 is produced by at least one fixture, checked against the failure enum.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebFetch, DocStore, type TraceEvent, type WebFetchResult } from "../../../../src/tools/web/fetch.ts";
import { WEB_FAILURE_CODES, WebFailure, type WebFailureCode } from "../../../../src/tools/web/failure.ts";
import { createWebTools } from "../../../../src/tools/web/tools.ts";
import { FIXED_NOW, loadManifest, readFixture, startCorpusServer, type CorpusCase, type CorpusServer } from "./server.ts";
import { linkTargets, missingHeadings, missingTables, recall, headings } from "./metrics.ts";
import { longLine, manual500 } from "./generators.ts";

const GATE = 0.95;
const cases = loadManifest();
const goldenText = (c: CorpusCase): string => readFixture(c.golden).toString("utf8");

/** The sources a web.fetch call runs through; a typed failure that is named in none of them cannot come out of web.fetch. */
const FETCH_PATH = ["fetch.ts", "http.ts", "guard.ts", "robots.ts", "html.ts"].map((f) => new URL(`../../../../src/tools/web/${f}`, import.meta.url));
const GATE_SOURCE = new URL("../../../../src/egress/gate.ts", import.meta.url);

/** Codes web.fetch can throw: those its own code path names. Search-only codes (D95: no-provider, provider-failed, and anything web.search adds later) are not in this list by construction. */
export const FETCH_CODES: readonly WebFailureCode[] = (() => {
  const text = [...FETCH_PATH, GATE_SOURCE].map((u) => readFileSync(u, "utf8")).join("\n");
  return WEB_FAILURE_CODES.filter((c) => text.includes(`"${c}"`));
})();
export const SEARCH_ONLY: readonly WebFailureCode[] = ["no-provider", "provider-failed"];

describe("corpus: shape", () => {
  it("has at least 60 fixtures and every one has a golden file", () => {
    assert.ok(cases.length >= 60, `only ${cases.length} fixtures`);
    for (const c of cases) assert.ok(readFixture(c.golden).length > 0, `${c.id}: empty golden`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "duplicate fixture ids");
  });

  it("covers the case families the quality bar names", () => {
    const text = cases.map((c) => `${c.id} ${c.category} ${c.note}`).join("\n").toLowerCase();
    for (const word of ["article", "blog", "docs", "spa", "pdf", "scanned", "docx", "500-page", "paywall", "cookie", "redirect", "table", "code", "nested", "rtl", "cjk", "long-line", "broken", "content-type", "gzip", "brotli", "charset", "captcha"])
      assert.ok(text.includes(word), `no fixture mentions ${word}`);
  });

  it("every golden and page file on disk belongs to a manifest entry", async () => {
    const { readdirSync } = await import("node:fs");
    const { FIXTURE_DIR } = await import("./server.ts");
    const referenced = new Set<string>();
    for (const c of cases) {
      referenced.add(c.golden);
      if (c.response.file) referenced.add(c.response.file);
    }
    for (const dir of ["goldens", "pages"]) for (const f of readdirSync(join(FIXTURE_DIR, dir))) assert.ok(referenced.has(`${dir}/${f}`), `orphan fixture file ${dir}/${f}`);
  });

  it("no fixture or golden is large enough to bloat the repository (generated ones are not checked in)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { FIXTURE_DIR } = await import("./server.ts");
    for (const dir of ["goldens", "pages"]) for (const f of readdirSync(join(FIXTURE_DIR, dir))) assert.ok(statSync(join(FIXTURE_DIR, dir, f)).size < 100_000, `${dir}/${f} is too large to check in`);
  });
});

describe("corpus: metrics sanity (the gate can fail)", () => {
  const golden = "# Title\n\nOne two three four five six seven eight nine ten.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## Part\n\nEleven twelve.\n";
  it("identical text scores 1 and mangled formatting does not matter", () => {
    assert.equal(recall(golden, golden), 1);
    assert.equal(recall(golden, "Title one two three four five six seven eight nine ten a b 1 2 part eleven twelve"), 1);
  });
  it("dropping more than 5 % of the tokens fails the threshold", () => {
    assert.ok(recall(golden, "# Title\n\nOne two three four five six seven eight nine ten.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## Part\n") < GATE);
  });
  it("a missing heading, a changed heading level and a damaged table are reported", () => {
    assert.deepEqual(missingHeadings(golden, golden), []);
    assert.equal(missingHeadings(golden, golden.replace("## Part", "")).length, 1);
    assert.equal(missingHeadings(golden, golden.replace("## Part", "### Part")).length, 1);
    assert.deepEqual(missingTables(golden, golden), []);
    assert.equal(missingTables(golden, golden.replace("| 1 | 2 |", "| 1 | 3 |")).length, 1);
    assert.equal(missingTables(golden, golden.replace(/\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|\n/, "a b 1 2\n")).length, 1);
  });
  it("tokenisation handles CJK, RTL and mixed scripts without collapsing to nothing", () => {
    assert.ok(recall("日本語のテキストです。", "日本語のテキストです。") === 1);
    assert.ok(recall("日本語のテキストです。", "") === 0);
    assert.ok(recall("مرحبا بالعالم", "مرحبا") < 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("corpus: every fixture through web.fetch", () => {
  const observed = new Map<WebFailureCode, string[]>();
  const recalls: Array<{ id: string; recall: number }> = [];
  const traces: TraceEvent[] = [];
  let server: CorpusServer;
  const robotsServers = new Map<string, CorpusServer>();
  let tls: { port: number; close: () => Promise<void> } | undefined;
  let refusedPort = 0;
  const tmp = mkdtempSync(join(tmpdir(), "p3-corpus-"));
  let opensslOk = true;

  before(async () => {
    server = await startCorpusServer(cases);
    for (const c of cases) if (c.response.robots !== undefined) robotsServers.set(c.id, await startCorpusServer(cases, { robots: c.response.robots }));
    // a port nothing listens on
    const dead = await startCorpusServer([]);
    refusedPort = dead.stub.port;
    await dead.close();
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem"), "-days", "2", "-subj", "/CN=corpus.test", "-addext", "subjectAltName=DNS:corpus.test"], { stdio: "ignore" });
      const s = https.createServer({ cert: readFileSync(join(tmp, "c.pem")), key: readFileSync(join(tmp, "k.pem")) }, (_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("secure"));
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      tls = { port: (s.address() as AddressInfo).port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
    } catch {
      opensslOk = false; // same precedent as http.test.ts: no openssl on the box, the TLS fixture cannot be served
    }
  });
  after(async () => {
    await server.close();
    for (const s of robotsServers.values()) await s.close();
    await tls?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseFor = (c: CorpusCase): string => robotsServers.get(c.id)?.base ?? server.base;
  const urlFor = (c: CorpusCase): string => {
    const base = baseFor(c);
    const u = c.request?.url;
    if (u === "REFUSED") return `http://127.0.0.1:${refusedPort}/`;
    if (u !== undefined) return u.replace("BASE", base);
    if (c.response.kind === "tls") return `https://127.0.0.1:${tls!.port}/`;
    if (c.request?.path) return base + c.request.path;
    return `${base}/p/${c.id}`;
  };
  const makeFetch = (c: CorpusCase, extra: Record<string, unknown> = {}) =>
    createWebFetch({
      allowPrivate: c.strict ? [] : ["127.0.0.0/8"],
      timeoutMs: 5000,
      now: () => FIXED_NOW,
      version: "9.9.9",
      trace: (e) => traces.push(e),
      ...(c.config as object),
      ...extra,
    });

  async function readAll(f: ReturnType<typeof makeFetch>, url: string, args: Record<string, unknown>): Promise<{ first: WebFetchResult; markdown: string; calls: number }> {
    const first = await f.fetch({ url, ...args } as never);
    let markdown = first.markdown;
    let calls = 1;
    let r = first;
    while (r.cursor) {
      r = await f.fetch({ url, cursor: r.cursor, ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}) } as never);
      markdown += `\n\n${r.markdown}`;
      calls++;
      assert.ok(calls < 400, "cursor walk does not terminate");
    }
    return { first, markdown, calls };
  }

  for (const c of cases) {
    if (c.expect === "ok") {
      it(`ok · ${c.id} (${c.category})`, async () => {
        const url = urlFor(c);
        const golden = goldenText(c).replaceAll("{{BASE}}", server.base);
        const { first, markdown } = await readAll(makeFetch(c), url, (c.request?.args ?? {}) as Record<string, unknown>);
        const got = markdown;
        const r = recall(golden, got);
        recalls.push({ id: c.id, recall: r });
        const ctx = `\n--- golden ---\n${golden.slice(0, 1500)}\n--- got ---\n${got.slice(0, 1500)}`;
        assert.ok(r >= GATE, `${c.id}: only ${(r * 100).toFixed(1)} % of the main-text tokens survived${ctx}`);
        assert.deepEqual(missingHeadings(golden, got), [], `${c.id}: headings lost${ctx}`);
        assert.deepEqual(missingTables(golden, got), [], `${c.id}: tables damaged${ctx}`);
        for (const target of linkTargets(golden)) assert.ok(got.includes(`(${target})`), `${c.id}: link target ${target} lost${ctx}`);
        for (const bad of c.mustNotContain ?? []) assert.ok(!got.includes(bad), `${c.id}: boilerplate leaked: ${JSON.stringify(bad)}${ctx}`);
        if (!golden.includes("�")) assert.ok(!got.includes("�"), `${c.id}: replacement characters in the output${ctx}`);
        if (c.rawText) assert.equal(got.trimEnd(), golden.trimEnd(), `${c.id}: non-HTML text must come back as written`);
        for (const [k, v] of Object.entries(c.meta ?? {})) assert.equal((first as unknown as Record<string, unknown>)[k], v.replaceAll("{{BASE}}", server.base), `${c.id}: meta ${k}`);
        assert.equal(first.status, 200);
        assert.equal(first.renderUsed, false);
        assert.deepEqual(first.provenance, { source: "web", url: first.finalUrl, fetchedAt: first.fetchedAt, trust: "untrusted" });
        if (c.expectFinalPath) assert.equal(first.finalUrl, server.base + c.expectFinalPath, `${c.id}: final URL after redirects`);
        if (c.chain) assert.ok(server.stub.hits.filter((h) => h.url.startsWith(`/r/${c.id}/`)).length >= c.chain.length, `${c.id}: not every hop was requested`);
      });
      continue;
    }

    if (c.expect === "generated-ok") {
      it(`ok · ${c.id} (${c.category})`, async () => {
        const g = JSON.parse(readFixture(c.golden).toString("utf8")) as { markdownSha256: string; markdownChars: number; headings?: number };
        const gen = c.response.name === "manual-500" ? manual500() : longLine();
        assert.equal(createHash("sha256").update(gen.markdown).digest("hex"), g.markdownSha256, "the generator drifted from its recorded golden");
        assert.equal(gen.markdown.length, g.markdownChars);
        const f = makeFetch(c);
        const { first, markdown, calls } = await readAll(f, urlFor(c), {});
        assert.ok(calls > 1, "a long document must arrive in chunks");
        const norm = (s: string): string => s.replace(/\s+/g, ""); // a cut inside an enormous token cannot be re-joined with a separator, so whitespace is ignored
        assert.equal(norm(markdown), norm(gen.markdown), "the cursor walk must reproduce the whole document, nothing lost");
        recalls.push({ id: c.id, recall: recall(gen.markdown, markdown) });
        if (g.headings !== undefined) {
          assert.deepEqual(missingHeadings(gen.markdown, markdown), []);
          assert.equal(headings(gen.markdown).length, g.headings);
          assert.equal(first.sectionsTotal, g.headings, "the table of contents must say how many sections exist");
          assert.ok(first.sections.length <= 200);
          // a jump by section id returns that page and its table, nothing else
          const page250 = await f.fetch({ url: urlFor(c), section: /^## (Page 250: .*)$/m.exec(gen.markdown)![1]! });
          assert.match(page250.markdown, /^## Page 250: /);
          assert.match(page250.markdown, /Torque \(Nm\)/);
          assert.ok(!page250.markdown.includes("## Page 251"));
        }
      });
      continue;
    }

    // expected failure
    it(`fails · ${c.id} -> ${(JSON.parse(readFixture(c.golden).toString("utf8")) as { code: string }).code}`, async (t) => {
      if (c.response.kind === "tls" && !opensslOk) return t.skip("openssl is not available on this machine");
      const want = JSON.parse(readFixture(c.golden).toString("utf8")) as { code: WebFailureCode; status?: number; retryAfterSeconds?: number };
      const url = urlFor(c);
      if (c.special === "cursor-other-agent") {
        const f = makeFetch(c);
        const a = await f.fetch({ url, maxTokens: 500 }, { agentId: "agent-a" });
        assert.ok(a.cursor, "the manual must be long enough to need a cursor");
        await assert.rejects(f.fetch({ url, cursor: a.cursor }, { agentId: "agent-b" }), (e: unknown) => {
          assert.ok(e instanceof WebFailure);
          note(want.code, c.id);
          return e.code === want.code;
        });
        return;
      }
      if (c.special === "internal-error-store") {
        class Faulty extends DocStore {
          override put(): string {
            throw new Error("secret-internal-detail /srv/state/db.sqlite");
          }
        }
        const f = makeFetch(c, { store: new Faulty() });
        const { tools } = createWebTools({ fetch: f, search: { search: async () => { throw new Error("unused"); } } as never });
        const out = await tools.find((x) => x.name === "web.fetch")!.execute({ url, maxTokens: 500 }, {});
        assert.equal(out.isError, true);
        if (!out.isError) return;
        note(out.error.code, c.id);
        assert.equal(out.error.code, want.code);
        assert.ok(!JSON.stringify(out).includes("secret-internal-detail"), "an unexpected exception must not leak its text");
        assert.ok(!JSON.stringify(out).includes("db.sqlite"));
        assert.ok(traces.at(-1)?.error === "internal-error", `the trace must record internal-error, got ${traces.at(-1)?.error}`);
        return;
      }
      const f = makeFetch(c);
      await assert.rejects(f.fetch({ url, ...(c.request?.args ?? {}) } as never), (e: unknown) => {
        assert.ok(e instanceof WebFailure, `expected a typed WebFailure, got ${String(e)}`);
        note(e.code, c.id);
        assert.equal(e.code, want.code, `${c.id}: ${e.message}`);
        if (want.status !== undefined) assert.equal(e.extra.status, want.status);
        if (want.retryAfterSeconds !== undefined) assert.equal(e.extra.retryAfterSeconds, want.retryAfterSeconds);
        assert.ok(e.hint.length > 10 && e.userAction.length > 10, "every failure carries a hint and a userAction");
        const r = e.toResult();
        assert.equal(r.isError, true);
        assert.ok(!("stack" in r.error));
        return true;
      });
      if (c.strict) assert.equal(server.stub.hits.filter((h) => h.url === `/p/${c.id}`).length, 0, "a refused address must never be dialled");
    });
  }

  function note(code: WebFailureCode, id: string): void {
    observed.set(code, [...(observed.get(code) ?? []), id]);
  }

  it("the trace carries URL, status, size and timing only: no response body ever reaches it", () => {
    const allowed = new Set(["tool", "url", "finalUrl", "status", "bytes", "ms", "fromCache", "error"]);
    assert.ok(traces.length >= cases.length);
    for (const t of traces) for (const k of Object.keys(t)) assert.ok(allowed.has(k), `unexpected trace field ${k}`);
  });

  it("GATE: every ok fixture keeps at least 95 % of its golden's main-text tokens", () => {
    assert.ok(recalls.length >= 60 - cases.filter((c) => c.expect === "fail").length);
    const worst = recalls.reduce((a, b) => (b.recall < a.recall ? b : a));
    assert.ok(worst.recall >= GATE, `${worst.id} keeps ${(worst.recall * 100).toFixed(1)} %`);
    console.log(`web.fetch corpus: ${cases.length} fixtures (${recalls.length} extraction goldens, ${cases.filter((c) => c.expect === "fail").length} typed failures); lowest retention ${(worst.recall * 100).toFixed(2)} % (${worst.id})`);
  });

  it("every typed failure web.fetch can produce is produced by at least one fixture", () => {
    const required = FETCH_CODES;
    for (const code of ["invalid-arguments", "invalid-url", "private-address", "egress-denied", "not-found", "gone", "auth-required", "paywall", "captcha", "rate-limited", "timeout", "too-large", "unsupported-type", "tls-error", "needs-render", "too-many-redirects", "robots-disallowed", "network-error", "http-error", "cursor-expired", "internal-error"] as const)
      assert.ok(required.includes(code), `${code} is not named by the web.fetch code path: the source scan is broken or the code moved`);
    for (const code of SEARCH_ONLY) assert.ok(!required.includes(code), `${code} is reachable from web.fetch now; it needs a fixture`);
    const missing = required.filter((c) => !observed.has(c));
    // Only a machine without openssl may leave tls-error unobserved; everywhere else the list must be empty.
    assert.deepEqual(missing.filter((c) => !(c === "tls-error" && !opensslOk)), [], `no fixture produced: ${missing.join(", ")}`);
    // The declared goldens (static) agree with what actually happened (dynamic).
    const declared = new Set(cases.filter((c) => c.expect === "fail").map((c) => (JSON.parse(readFixture(c.golden).toString("utf8")) as { code: WebFailureCode }).code));
    for (const code of required) assert.ok(declared.has(code), `no golden declares ${code}`);
    for (const code of declared) assert.ok(WEB_FAILURE_CODES.includes(code), `golden declares unknown code ${code}`);
  });
});

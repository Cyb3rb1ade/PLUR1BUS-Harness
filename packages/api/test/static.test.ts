import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { htmlCsp, injectNonce, newNonce, securityHeaders } from "../src/headers.ts";
import { safeSegments } from "../src/static.ts";
import { raw, start } from "./helpers.ts";

// Mirrors packages/web/index.html: a module script, a stylesheet link, no inline code.
const INDEX = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"><script type="module" src="./main.js"></script></head><body><div id="app"></div></body></html>`;
const SECRET = "TOP-SECRET-OUTSIDE-THE-WEB-ROOT";

/** A web root with a sibling secret and (where the OS allows it) a symlink that points out of the root. */
function fixture(): { root: string; cleanup(): void; symlink: boolean } {
  const base = mkdtempSync(path.join(tmpdir(), "plur1bus-web-"));
  const root = path.join(base, "dist"); mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), INDEX); writeFileSync(path.join(root, "main.js"), "console.log('app');"); writeFileSync(path.join(root, "styles.css"), "body{margin:0}");
  writeFileSync(path.join(root, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(path.join(root, ".env"), "HIDDEN=1"); mkdirSync(path.join(root, ".git")); writeFileSync(path.join(root, ".git", "config"), "x");
  writeFileSync(path.join(base, "secret.txt"), SECRET);
  writeFileSync(path.join(root, "tmpl.html"), `<html><head><meta name="csp-nonce" content="__CSP_NONCE__"><script nonce="__CSP_NONCE__">1</script><script>2</script><style>b{}</style></head></html>`);
  let symlink = true;
  try { symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt")); symlinkSync(base, path.join(root, "up"), "dir"); } catch { symlink = false; }
  return { root, symlink, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 10000, refillPerSec: 1000 }, write: { capacity: 1000, refillPerSec: 100 } };

test("the SPA is served at / with a CSP that allows only this response's nonce, strict-dynamic, no unsafe-inline", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const r = await raw(h, { path: "/" });
    assert.equal(r.status, 200); assert.match(String(r.headers["content-type"]), /^text\/html; charset=utf-8/);
    const csp = String(r.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]{22,})' 'strict-dynamic'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.ok(r.text.includes(`<script nonce="${nonce}" type="module" src="./main.js">`), "the nonce is on the script tag");
    const scriptSrc = csp.match(/script-src [^;]*/)![0];
    for (const bad of ["unsafe-inline", "unsafe-eval", "'self'", "*", "http:", "https:", "data:"]) assert.ok(!scriptSrc.includes(bad), `script-src has no ${bad}`);
    for (const bad of ["unsafe-inline", "unsafe-eval", " * ", "http:", "https:"]) assert.ok(!csp.includes(bad), `the policy has no ${bad}`);
    for (const must of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'"]) assert.ok(csp.includes(must), must);
    assert.deepEqual(csp.match(/script-src [^;]*/)![0].split(" ").filter((x) => x.startsWith("'") && !x.startsWith("'nonce-")), ["'strict-dynamic'"]);
    assert.equal(r.headers["cache-control"], "no-store");
  } finally { await h.close(); f.cleanup(); }
});

test("every page gets a fresh nonce of at least 128 bits, and the nonce in the header is the one in the body", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = await raw(h, { path: i % 2 ? "/" : "/settings/memory" });
      const n = /'nonce-([^']+)'/.exec(String(r.headers["content-security-policy"]))![1]!;
      assert.ok(Buffer.from(n, "base64").length >= 16); assert.ok(r.text.includes(`nonce="${n}"`)); seen.add(n);
    }
    assert.equal(seen.size, 6);
    assert.notEqual(newNonce(), newNonce());
  } finally { await h.close(); f.cleanup(); }
});

test("the placeholder __CSP_NONCE__ is replaced, tags that already carry a nonce are not given a second, inline styles get one", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const r = await raw(h, { path: "/tmpl.html" });
    const n = /'nonce-([^']+)'/.exec(String(r.headers["content-security-policy"]))![1]!;
    assert.ok(!r.text.includes("__CSP_NONCE__"));
    assert.ok(r.text.includes(`<meta name="csp-nonce" content="${n}">`));
    assert.equal((r.text.match(/<script nonce=/g) ?? []).length, 2); assert.ok(!/nonce="[^"]+"[^>]*nonce=/.test(r.text), "no tag has two nonces");
    assert.ok(r.text.includes(`<style nonce="${n}">`));
    assert.match(String(r.headers["content-security-policy"]), /style-src 'self' 'nonce-/);
  } finally { await h.close(); f.cleanup(); }
});

test("assets get their type and the strict JSON-style CSP; the same security headers as every response", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const [p, type] of [["/main.js", /^text\/javascript/], ["/styles.css", /^text\/css/], ["/assets/logo.svg", /^image\/svg\+xml/]] as const) {
      const r = await raw(h, { path: p });
      assert.equal(r.status, 200, p); assert.match(String(r.headers["content-type"]), type, p);
      assert.equal(r.headers["content-security-policy"], securityHeaders(false)["Content-Security-Policy"], p);
      for (const [k, v] of Object.entries(securityHeaders(false))) assert.equal(r.headers[k.toLowerCase()], v, `${p} ${k}`);
    }
    assert.equal((await raw(h, { path: "/main.js" })).text, "console.log('app');");
    assert.equal((await raw(h, { path: "/main.js?v=1&x=%2e%2e" })).status, 200, "a query string is not part of the path");
  } finally { await h.close(); f.cleanup(); }
});

test("no way out of the web root: dot segments, encodings, backslashes, NUL, dotfiles and symlinks all end in an error, never in a file", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const paths = ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/a/../../secret.txt", "/..\\secret.txt", "/%5c..%5csecret.txt", "/%252e%252e/secret.txt", "/main.js%00.png", "/%00", "/assets/../../secret.txt", "/.env", "/.git/config", "/assets/.env", "/%2eenv", "/main.js/..", "/C:/Windows/win.ini", "/main.js::$DATA", "/main.js.", "/%ff", "/" + "a".repeat(300) + ".js"];
    if (f.symlink) paths.push("/leak.txt", "/up/secret.txt", "/up/dist/.env");
    for (const p of paths) {
      const r = await raw(h, { path: p });
      assert.ok([400, 404].includes(r.status) || (r.status === 200 && r.text.includes("<div id=\"app\">")), `${p} -> ${r.status}`);
      assert.ok(!r.text.includes(SECRET) && !r.text.includes("HIDDEN=1"), `${p} leaked`);
    }
  } finally { await h.close(); f.cleanup(); }
});

test("client-side routes (no file extension) get the app shell; a missing file or anything under /api is a JSON 404, never the shell", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const p of ["/settings/memory", "/chat", "/agents/main/"]) { const r = await raw(h, { path: p }); assert.equal(r.status, 200, p); assert.ok(r.text.includes('<div id="app">'), p); }
    for (const p of ["/missing.js", "/assets/none.svg", "/api/v1/nope", "/api/nope/x", "/api/"]) {
      const r = await raw(h, { path: p });
      assert.equal(r.status, 404, p); assert.equal(r.json?.schema, "error/1", p);
    }
  } finally { await h.close(); f.cleanup(); }
});

test("only GET and HEAD read files; HEAD has no body; other methods are 405 with Allow; with no webRoot configured / is the old JSON 404", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const head = await raw(h, { method: "HEAD", path: "/" }); assert.equal(head.status, 200); assert.equal(head.text, ""); assert.ok(head.headers["content-security-policy"]);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await raw(h, { method, path: "/main.js" });
      assert.equal(r.status, 405, method); assert.equal(r.headers.allow, "GET, HEAD"); assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
  } finally { await h.close(); f.cleanup(); }
  const bare = await start();
  try { const r = await raw(bare, { path: "/" }); assert.deepEqual([r.status, r.json.schema, r.json.reason], [404, "error/1", "route"]); } finally { await bare.close(); }
});

test("the static routes obey the same gates as the API: Host, Origin and rate limit", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: { ...wide, read: { capacity: 3, refillPerSec: 0.001 } } });
  try {
    assert.equal((await raw(h, { path: "/", headers: { host: "evil.example" } })).status, 421);
    assert.equal((await raw(h, { path: "/", headers: { origin: "https://evil.example" } })).status, 403);
    const codes: number[] = []; for (let i = 0; i < 6; i++) codes.push((await raw(h, { path: "/main.js" })).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]); assert.ok(codes.slice(3).every((c) => c === 429), JSON.stringify(codes));
  } finally { await h.close(); f.cleanup(); }
});

test("safeSegments: the pure path rules", () => {
  assert.deepEqual(safeSegments("/"), ["index.html"]);
  assert.deepEqual(safeSegments("//assets///logo.svg"), ["assets", "logo.svg"], "empty segments collapse, they never become a root-relative path");
  assert.deepEqual(safeSegments("/a%20b/c.js"), ["a b", "c.js"]);
  for (const bad of ["/../x", "/a/../x", "/%2e%2e/x", "/a%2fb", "/a%5cb", "/a\\b", "/%00", "/.env", "/a/.b", "/%25", "/%252e", "/%zz", "/a:b", "/a.", "/a ", "/\u0001", "/" + "x".repeat(256)]) assert.equal(safeSegments(bad), undefined, JSON.stringify(bad));
});

test("injectNonce and htmlCsp: pure behaviour", () => {
  assert.equal(injectNonce('<script src="a"></script><script nonce="x" src="b"></script><SCRIPT>1</SCRIPT><scripted>', "N"), '<script nonce="N" src="a"></script><script nonce="x" src="b"></script><SCRIPT nonce="N">1</SCRIPT><scripted>');
  assert.equal(injectNonce("__CSP_NONCE__ and __CSP_NONCE__", "N"), "N and N");
  assert.match(htmlCsp("abc"), /^default-src 'self'; script-src 'nonce-abc' 'strict-dynamic'; style-src 'self' 'nonce-abc'; /);
});

test("the real packages/web/index.html (read only, not changed) gets the nonce on its module script and keeps working under the policy", () => {
  const real = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  const out = injectNonce(real, "NONCE123");
  assert.ok(/<script nonce="NONCE123" type="module" src="\.\/main\.js">/.test(out), out.slice(0, 400));
  assert.ok(!/<script(?![^>]*nonce=)/i.test(out), "no script tag is left without a nonce");
  assert.ok(!/<[a-z]+[^>]*\sstyle=/i.test(out), "the page has no inline style attributes, which a nonce could not cover");
  assert.ok(!/\son[a-z]+=/i.test(out), "no inline event handlers");
  assert.ok(real.length === out.length - ' nonce="NONCE123"'.length, "exactly one tag was touched");
});

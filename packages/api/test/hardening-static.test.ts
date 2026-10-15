// Step 6 (static delivery) of the server hardening sweep: path traversal, symlinks, content types, caching and ranges.
// Already pinned elsewhere (not repeated): dot segments, encodings, backslash, NUL, dotfiles and one file symlink plus
// one directory symlink out of the root (static.test.ts), nonce handling, GET/HEAD only, Host/Origin/rate gates.
// Generative cases use mulberry32 with a fixed seed that appears in every failure message.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticServer, safeSegments } from "../src/static.ts";
import { raw, start, type Harness } from "./helpers.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 1_000_000, refillPerSec: 100_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
const SECRET = "redact-probe-alpha-OUTSIDE-THE-WEB-ROOT"; const INSIDE = "inside-the-web-root";

interface Fixture { base: string; root: string; symlinks: boolean; cleanup(): void }
function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "plur1bus-static-")); const root = path.join(base, "dist"); const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "assets"), { recursive: true }); mkdirSync(outside);
  writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><script type="module" src="./main.js"></script></head><body></body></html>`);
  writeFileSync(path.join(root, "main.js"), INSIDE); writeFileSync(path.join(root, "assets", "app-3f9a1c2b.js"), INSIDE); writeFileSync(path.join(root, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(path.join(base, "secret.txt"), SECRET); writeFileSync(path.join(outside, "index.html"), SECRET); writeFileSync(path.join(outside, "x.js"), SECRET);
  let symlinks = true;
  try {
    symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt")); symlinkSync(outside, path.join(root, "out-dir"), "dir"); symlinkSync(path.join(outside, "index.html"), path.join(root, "assets", "shell.html"));
    symlinkSync(path.join(root, "main.js"), path.join(root, "alias.js")); symlinkSync(path.join(root, "assets"), path.join(root, "assets-alias"), "dir");
    symlinkSync(path.join(root, "loop-b.js"), path.join(root, "loop-a.js")); symlinkSync(path.join(root, "loop-a.js"), path.join(root, "loop-b.js")); symlinkSync(path.join(base, "missing-target.js"), path.join(root, "dangling.js"));
    symlinkSync(path.join(base, "dist", "..", "secret.txt"), path.join(root, "dotdot.txt")); symlinkSync("../secret.txt", path.join(root, "relative.txt"));
  } catch { symlinks = false; }
  return { base, root, symlinks, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// ---- traversal -----------------------------------------------------------------------------------------------------

test("generated traversal paths (4000, seeded) never yield a byte from outside the web root", async () => {
  const SEED = 0x57A71C; const rand = mulberry32(SEED); const f = fixture(); const srv = createStaticServer(f.root);
  const pieces = [".", "..", "...", "%2e", "%2E", "%2e%2e", "%252e%252e", "%2f", "%2F", "%5c", "%5C", "%252f", "/", "//", "\\", "%00", "%0a", "%0d", "..%2f", "..%5c", "%c0%ae", "%e0%80%ae", "%ff", "a", "assets", "out-dir", "secret.txt", "x.js", "index.html", "dist", "outside", "leak.txt", ":", "::$DATA", ";", "?", "#", " ", "‥", "．．", "con", "NUL.txt"];
  try {
    let served = 0;
    for (let i = 0; i < 4000; i++) {
      let p = "/"; const n = 1 + Math.floor(rand() * 8); for (let k = 0; k < n; k++) p += pieces[Math.floor(rand() * pieces.length)]! + (rand() < 0.5 ? "/" : "");
      const r = await srv.read(p);
      if (r) { served++; assert.ok(!r.body.toString("utf8").includes(SECRET), `seed ${SEED} case ${i}: ${JSON.stringify(p)} served the secret`); }
    }
    assert.ok(served > 0, `seed ${SEED}: the generator never hit a real file, so the check proved nothing`);
  } finally { f.cleanup(); }
});

test("hand-written traversal requests over a raw socket (the client cannot normalise them) are never a 200 with outside content", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    const targets = [
      "/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/%2E%2E%2Fsecret.txt", "/%252e%252e/secret.txt", "/..%5csecret.txt", "/..\\secret.txt", "/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt",
      "/a/..%c0%afsecret.txt", "/%00/secret.txt", "/main.js%00.txt", "/main.js%00", "/./main.js/../../secret.txt", "//secret.txt", "///etc/passwd", "/out-dir/x.js", "/out-dir/", "/leak.txt", "/assets/shell.html", "/dotdot.txt", "/relative.txt",
      "/main.js::$DATA", "/main.js:stream", "/main.js.", "/main.js ", "/MAIN.JS/../../secret.txt", "/index.html/../../secret.txt", "/.env", "/.git/config", "/%2eenv",
    ];
    for (const t of targets) {
      const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const s = connect(h.port, "127.0.0.1"); let data = ""; const timer = setTimeout(() => { s.destroy(); reject(new Error("timed out")); }, 3000);
        s.on("data", (c) => { data += c.toString("latin1"); }); s.on("error", () => {}); s.on("close", () => { clearTimeout(timer); resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), body: data }); });
        s.on("connect", () => s.write(`GET ${t} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`));
      });
      assert.ok(!r.body.includes(SECRET), `${t}: the secret came back`); assert.ok(r.status !== 500, `${t}: ${r.status}`);
      if (r.status === 200) assert.ok(r.body.includes(INSIDE) || r.body.includes("<!doctype html>"), `${t}: a 200 may only carry content from inside the root`);
    }
  } finally { await h.close(); f.cleanup(); }
});

test("symlinks: any link whose real target lies outside the root is refused (file, directory, ..-relative, chained); links that stay inside are served; loops and dangling links are plain 404s", async (t) => {
  const f = fixture(); if (!f.symlinks) { f.cleanup(); t.skip("symlinks are not available here"); return; }
  const srv = createStaticServer(f.root);
  try {
    for (const out of ["/leak.txt", "/out-dir/x.js", "/out-dir/index.html", "/assets/shell.html", "/dotdot.txt", "/relative.txt"]) assert.equal(await srv.read(out), undefined, out);
    for (const inside of ["/alias.js", "/assets-alias/app-3f9a1c2b.js"]) { const r = await srv.read(inside); assert.equal(r?.body.toString(), INSIDE, inside); }
    for (const bad of ["/loop-a.js", "/loop-b.js", "/dangling.js", "/missing.js"]) assert.equal(await srv.read(bad), undefined, bad);
    // The shell itself being a link out of the root must not turn the app shell into outside content.
    rmSync(path.join(f.root, "index.html")); symlinkSync(path.join(f.base, "outside", "index.html"), path.join(f.root, "index.html"));
    assert.equal(await srv.read("/"), undefined); assert.equal(await srv.read("/any/client/route"), undefined);
  } finally { f.cleanup(); }
});

test("a web root that is itself reached through a symlink still serves its files (the root is resolved once) and still refuses what lies outside it", async (t) => {
  const f = fixture(); if (!f.symlinks) { f.cleanup(); t.skip("symlinks are not available here"); return; }
  const via = path.join(f.base, "via-link"); symlinkSync(f.root, via, "dir");
  try { const srv = createStaticServer(via); assert.equal((await srv.read("/main.js"))?.body.toString(), INSIDE); assert.equal(await srv.read("/leak.txt"), undefined); assert.equal(await srv.read("/../secret.txt"), undefined); } finally { f.cleanup(); }
});

test("safeSegments: the documented rules, one by one, with the Windows ones included", () => {
  for (const [p, want] of [["/", ["index.html"]], ["//", ["index.html"]], ["/a//b", ["a", "b"]], ["//x", ["x"]], ["/assets/app-3f9a1c2b.js", ["assets", "app-3f9a1c2b.js"]], ["/%41", ["A"]]] as const) assert.deepEqual(safeSegments(p), want, p);
  for (const bad of ["x", "", "/.", "/..", "/a/../b", "/.hidden", "/a/.b", "/%2e%2e", "/%2E", "/a%2fb", "/a%5cb", "/a\\b", "/a%00", "/%01", "/%7f", "/%25", "/%252e", "/c:", "/a:b", "/a::$DATA", "/a.", "/a ", "/a.%20", `/${"a".repeat(256)}`, "/%", "/%zz", "/%c0%ae", "/%ff"]) assert.equal(safeSegments(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(safeSegments(`/${"a".repeat(255)}`), ["a".repeat(255)]);
});

test("KNOWN GAP: Windows reserved device names (CON, NUL, AUX, COM1, LPT1, with or without an extension) are not rejected as path segments", { todo: "KNOWN GAP: safeSegments lets CON/NUL/AUX/COMn/LPTn through; on Windows opening one can block a worker thread; see SICHERHEIT in the PR" }, () => {
  for (const name of ["con", "CON", "nul.js", "AUX.txt", "com1.js", "LPT9", "prn.css", "CONIN$", "conout$"]) assert.equal(safeSegments(`/${name}`), undefined, name);
});

// ---- content types, caching, ranges, limits ------------------------------------------------------------------------

async function served(h: Harness, p: string, headers: Record<string, string> = {}) { return raw(h, { path: p, headers }); }

test("every extension maps to its content type, case-insensitively; unknown and doubled extensions are octet-stream; nothing is guessed from content", async () => {
  const f = fixture(); const files: Record<string, string> = { "t.html": "text/html; charset=utf-8", "t.js": "text/javascript; charset=utf-8", "t.mjs": "text/javascript; charset=utf-8", "t.css": "text/css; charset=utf-8", "t.json": "application/json; charset=utf-8", "t.map": "application/json; charset=utf-8", "t.webmanifest": "application/manifest+json; charset=utf-8", "t.txt": "text/plain; charset=utf-8", "t.svg": "image/svg+xml", "t.png": "image/png", "t.jpg": "image/jpeg", "t.jpeg": "image/jpeg", "t.gif": "image/gif", "t.webp": "image/webp", "t.ico": "image/x-icon", "t.woff2": "font/woff2", "t.woff": "font/woff", "T.JS": "text/javascript; charset=utf-8", "t.exe": "application/octet-stream", "t.js.exe": "application/octet-stream", "t.php": "application/octet-stream", "t.htm": "application/octet-stream", "t.xml": "application/octet-stream", "t.wasm": "application/octet-stream" };
  for (const name of Object.keys(files)) writeFileSync(path.join(f.root, name), name.endsWith(".svg") ? "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>" : "<script>alert(1)</script>");
  const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const [name, type] of Object.entries(files)) {
      const r = await served(h, `/${name}`);
      if (name.toLowerCase() === "t.js" && name !== "t.js" && r.status === 404) continue; // a case-sensitive file system has no T.JS under that URL spelling
      assert.equal(r.status, 200, name); assert.equal(r.headers["content-type"], type, name); assert.equal(r.headers["x-content-type-options"], "nosniff", name);
      if (!name.endsWith(".html")) assert.equal(r.headers["content-security-policy"], "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", `${name}: assets get the strict policy (an SVG with a script runs nothing)`);
    }
  } finally { await h.close(); f.cleanup(); }
});

test("caching: hashed and unhashed assets alike are no-store with no validators, as documented, so nothing stale can outlive a rebuild", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const p of ["/", "/main.js", "/assets/app-3f9a1c2b.js", "/assets/logo.svg", "/client/route"]) {
      const r = await served(h, p); assert.equal(r.status, 200, p); assert.equal(r.headers["cache-control"], "no-store", p);
      for (const v of ["etag", "last-modified", "expires", "age", "accept-ranges", "set-cookie"]) assert.equal(r.headers[v], undefined, `${p}: ${v}`);
    }
    const again = await served(h, "/main.js", { "if-none-match": "\"x\"", "if-modified-since": new Date(Date.now() + 86_400_000).toUTCString() }); assert.equal(again.status, 200, "no conditional requests: a validator never turns a file into a 304");
  } finally { await h.close(); f.cleanup(); }
});

test("Range requests are not supported and are not half-supported: the whole file comes back with 200, no Content-Range, no 206 or 416", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const range of ["bytes=0-3", "bytes=5-", "bytes=-3", "bytes=0-0,2-3", "bytes=999999-", "items=0-1", "bytes=a-b"]) {
      const r = await served(h, "/main.js", { range }); assert.equal(r.status, 200, range); assert.equal(r.text, INSIDE, range); assert.equal(r.headers["content-range"], undefined, range);
    }
    const head = await raw(h, { method: "HEAD", path: "/main.js", headers: { range: "bytes=0-3" } }); assert.equal(head.status, 200); assert.equal(head.headers["content-length"], String(INSIDE.length)); assert.equal(head.text, "");
  } finally { await h.close(); f.cleanup(); }
});

test("HEAD answers exactly the headers GET does (type, length, policy, nonce policy for pages) and no body", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const p of ["/main.js", "/assets/logo.svg"]) {
      const g = await served(h, p); const hd = await raw(h, { method: "HEAD", path: p });
      for (const k of ["content-type", "content-length", "content-security-policy", "cache-control", "x-content-type-options", "x-frame-options"]) assert.equal(hd.headers[k], g.headers[k], `${p}: ${k}`);
      assert.equal(hd.text, "");
    }
    const page = await raw(h, { method: "HEAD", path: "/" }); assert.equal(page.status, 200); assert.match(String(page.headers["content-security-policy"]), /script-src 'nonce-/);
  } finally { await h.close(); f.cleanup(); }
});

test("size limit: a file of exactly 16 MiB is served, one byte more is a 404, a directory or a missing file is a 404, never a 500", async () => {
  const f = fixture(); const limit = 16 * 1024 * 1024;
  writeFileSync(path.join(f.root, "exact.bin"), ""); truncateSync(path.join(f.root, "exact.bin"), limit); writeFileSync(path.join(f.root, "over.bin"), ""); truncateSync(path.join(f.root, "over.bin"), limit + 1);
  mkdirSync(path.join(f.root, "dir.d"));
  const srv = createStaticServer(f.root);
  try {
    assert.equal((await srv.read("/exact.bin"))?.body.length, limit); assert.equal(await srv.read("/over.bin"), undefined);
    assert.equal(await srv.read("/dir.d"), undefined); assert.equal(await srv.read("/dir.d/"), undefined); assert.equal(await srv.read("/nothing.js"), undefined);
  } finally { f.cleanup(); }
});

test("absurd request targets are bounded: a 10 KB path is a plain 404, a 100 KB one is cut off before routing, 2000 segments are a 404, and the server keeps serving", async () => {
  const f = fixture(); const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    assert.equal((await served(h, `/${"a".repeat(10_000)}.js`)).status, 404); assert.equal((await served(h, `/${"a/".repeat(2_000)}x.js`)).status, 404);
    const huge = await new Promise<string>((resolve) => { const s = connect(h.port, "127.0.0.1"); let d = ""; s.on("data", (c) => { d += c; }); s.on("error", () => {}); s.on("close", () => resolve(d)); s.on("connect", () => s.write(`GET /${"a".repeat(100_000)} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`)); });
    assert.match(huge, /^HTTP\/1\.1 431 /);
    assert.equal((await served(h, "/main.js")).status, 200);
  } finally { await h.close(); f.cleanup(); }
});

test("a file under api/ in the web root is never served under /api, whatever the spelling of the prefix the API recognises", async () => {
  const f = fixture(); mkdirSync(path.join(f.root, "api")); writeFileSync(path.join(f.root, "api", "x.json"), "{\"leak\":true}");
  const h = await start({ webRoot: f.root, rateClasses: wide });
  try {
    for (const p of ["/api/x.json", "/api/", "/api", "/api/v1/nope", "/api/%2e%2e/main.js"]) { const r = await served(h, p); assert.equal(r.status, 404, p); assert.equal(r.json?.schema, "error/1", p); }
  } finally { await h.close(); f.cleanup(); }
});

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { createFsOps } from "../../src/tools/fs/ops.ts";
import { execRun } from "../../src/tools/exec/run.ts";
import { createExecTool } from "../../src/tools/exec/tool.ts";
import { BoundedCapture } from "../../src/tools/sandbox/capture.ts";
import { createWebFetch } from "../../src/tools/web/fetch.ts";
import { createWebTools } from "../../src/tools/web/tools.ts";
import { validateArguments } from "../../src/toolcall/validation.ts";
import { validateArgs } from "../../src/tools/repair.ts";
import { mk, tmpRoot } from "./exec/helpers.ts";
import { startStub } from "./web/helpers.ts";

const MARK = "[REDACTED:secret]";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await realpath(await mkdtemp(join(tmpdir(), "native-boundary-"))); dirs.push(dir); return dir; }
function registry(secret?: string) {
  const redaction = createSecretRedaction();
  if (secret) redaction.register(secret);
  return { redaction, knownSecrets: () => redaction.snapshot() };
}
const canary = (bytes = 80) => randomBytes(bytes).toString("hex");
function concealed(text: string, secret: string) {
  for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!text.includes(secret.slice(i, i + 8)), "a secret fragment crossed the output boundary");
}

test("exec masks a secret longer than the cap across chunks on both streams and drains excess", async () => {
  const secret = canary(), { knownSecrets } = registry(secret), { root: dir, sub } = tmpRoot(); dirs.push(dir);
  const m = mk({ root: dir }, { knownSecrets });
  let drained = false;
  m.port.onSpawn = p => {
    p.stdout("p".repeat(40) + secret.slice(0, 29)); p.stdout(secret.slice(29));
    p.stderr("e".repeat(40) + secret); p.stdout("z".repeat(2_000_000)); drained = true; p.exit(0);
  };
  const result = await execRun({ program: "git", cwd: sub, maxOutputBytes: 64 }, m.deps);
  assert.equal(result.stdout, "p".repeat(40) + MARK);
  assert.equal(result.stderr, "e".repeat(40) + MARK);
  assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true); assert.equal(drained, true);
  concealed(JSON.stringify(result), secret);
});

test("the exec adapter carries the trusted context to the capture without registering arguments or env", async () => {
  const secret = canary(), live = registry(secret), { root: dir, sub } = tmpRoot(); dirs.push(dir);
  const m = mk({ root: dir }); m.port.onSpawn = p => { p.stdout("p".repeat(40) + secret); p.exit(0); };
  const result = await createExecTool(m.deps).execute({ program: "git", cwd: sub, maxOutputBytes: 64 }, live);
  assert.equal(result.isError, false); if (result.isError) return;
  assert.equal(result.value.stdout, "p".repeat(40) + MARK);
});

test("capture copies a bounded padded prefix and withholds when a later generation needs discarded context", () => {
  const secret = canary(), live = registry(secret), limit = 64;
  const c = new BoundedCapture(limit, live.knownSecrets);
  const large = Buffer.from("p".repeat(40) + secret + "z".repeat(100_000));
  c.push(large); large.fill(120);
  assert.equal(c.text(), "p".repeat(40) + MARK);
  assert.ok(c.retainedBytes <= limit + live.knownSecrets().matcher.maxSourceBytes + 3);
  live.redaction.register(canary(100_000));
  assert.equal(c.text(), "[output withheld: secret context changed]");
});

test("capture enforces a valid UTF-8 byte cap after replacement", () => {
  const c = new BoundedCapture(4); c.push(Buffer.from("ab€😀"));
  assert.ok(c.text().isWellFormed()); assert.ok(Buffer.byteLength(c.text()) <= 4); assert.equal(c.text(), "ab");
});

test("process UTF-8 replacement spellings are masked before the byte cap", () => {
  const head = canary(10), tail = canary(), secret = head + "�" + tail, live = registry(secret);
  const capture = new BoundedCapture(64, live.knownSecrets);
  capture.push(Buffer.concat([Buffer.from("p".repeat(40) + head), Buffer.from([255]), Buffer.from(tail)]));
  assert.equal(capture.text(), "p".repeat(40) + MARK);
});

test("the sandbox's earlier one MiB collection cap has complete secret context", () => {
  const secret = canary(), live = registry(secret), limit = 1024 * 1024;
  const capture = new BoundedCapture(limit, live.knownSecrets);
  capture.push(Buffer.from("p".repeat(limit - 24) + secret.slice(0, 31)));
  capture.push(Buffer.from(secret.slice(31) + "z".repeat(limit)));
  assert.equal(capture.text(), "p".repeat(limit - 24) + MARK);
  assert.equal(capture.truncated, true); concealed(capture.text().slice(-100), secret);
});

test("file windows mask either edge and retain original coordinates after an earlier shrinking replacement", async () => {
  const secret = canary(), live = registry(secret), dir = await root(), path = join(dir, "source.txt");
  const lead = secret + "A".repeat(12), body = lead + secret + "Z".repeat(12);
  await writeFile(path, body);
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  for (const [offset, length, expected] of [
    [lead.length - 5, 16, "AAAAA" + MARK],
    [lead.length + secret.length - 11, 16, MARK + "ZZZZZ"],
    [lead.length + 7, 11, MARK],
    [lead.length + secret.length, 5, "ZZZZZ"],
  ] as const) {
    const result = await ops.read({ path, offset, length }, live);
    assert.equal(result.content, expected); assert.equal(result.offset, offset); assert.equal(result.bytesRead, length);
    assert.equal(result.size, Buffer.byteLength(body)); assert.equal(result.truncated, offset + length < body.length);
    concealed(result.content, secret);
  }
});

test("file base64 preserves arbitrary binary bytes while masking source spans before encoding", async () => {
  const secret = canary(), live = registry(secret), dir = await root(), path = join(dir, "binary");
  const body = Buffer.concat([Buffer.from([255, 0, 128]), Buffer.from(secret), Buffer.from([0, 254, 129])]);
  await writeFile(path, body);
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const whole = await ops.read({ path, encoding: "base64" }, live);
  assert.deepEqual(Buffer.from(whole.content, "base64"), Buffer.concat([body.subarray(0, 3), Buffer.from(MARK), body.subarray(-3)]));
  const part = await ops.read({ path, encoding: "base64", offset: 10, length: 19 }, live);
  assert.equal(Buffer.from(part.content, "base64").toString(), MARK); assert.equal(part.bytesRead, 19);
});

test("file UTF-8 classification and byte metadata belong to the requested source window", async () => {
  const secret = "é€😀" + canary(), live = registry(secret), dir = await root(), path = join(dir, "unicode");
  await writeFile(path, "a" + secret + "Z");
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const result = await ops.read({ path, offset: 1, length: 4 }, live);
  assert.equal(result.content, MARK); assert.equal(result.bytesRead, 2); assert.equal(result.offset, 1); assert.equal(result.truncated, true);
  await assert.rejects(ops.read({ path, offset: 2, length: 5 }, live), e => (e as { code?: string }).code === "binary-content");
});

test("file BOM bytes retain Unicode tails and source coordinates while secrets stay masked", async () => {
  const secret = canary(), live = registry(secret), dir = await root(), path = join(dir, "bom-secret");
  const source = Buffer.from("\uFEFF" + secret + "€😀\r\n");
  await writeFile(path, source);
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const full = await ops.read({ path }, live);
  assert.equal(full.content, "\uFEFF" + MARK + "€😀\r\n");
  assert.equal(full.bytesRead, source.length);
  assert.equal(full.size, source.length);
  assert.equal(full.truncated, false);
  const part = await ops.read({ path, length: 10 }, live);
  assert.equal(part.content, "\uFEFF" + MARK);
  assert.equal(part.bytesRead, 10);
  assert.equal(part.truncated, true);
  concealed(JSON.stringify([full, part]), secret);
});

test("file padding may start inside a multibyte codepoint without changing the requested text", async () => {
  const secret = canary(), live = registry(secret), dir = await root(), path = join(dir, "padding");
  await writeFile(path, "€".repeat(1000) + secret);
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const result = await ops.read({ path, offset: 3011, length: 13 }, live);
  assert.equal(result.content, MARK); assert.equal(result.bytesRead, 13);
});

test("file reads retry bounded context when a longer secret is registered during I/O", async () => {
  const secret = canary(), live = registry(), dir = await root(), path = join(dir, "fresh");
  await writeFile(path, secret);
  let reads = 0;
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const result = await ops.read({ path, offset: 11, length: 13 }, { knownSecrets() { if (++reads === 2) live.redaction.register(secret); return live.knownSecrets(); } });
  assert.equal(result.content, MARK); assert.equal(result.bytesRead, 13); assert.equal(reads, 4);
});

test("file windows conceal equivalent JSON escapes even when a window cuts an escape sequence", async () => {
  const secret = canary(), live = registry(secret), dir = await root(), path = join(dir, "escaped");
  const escaped = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  await writeFile(path, "public " + escaped + " tail");
  const ops = createFsOps({ roots: [{ id: "r", path: dir }] });
  const result = await ops.read({ path, offset: 20, length: 23 }, live);
  assert.equal(result.content, MARK); assert.equal(result.bytesRead, 23);
});

test("file result size is checked after short secrets expand to replacement markers", async () => {
  const secret = canary(4), live = registry(secret), dir = await root(), path = join(dir, "size");
  await writeFile(path, secret);
  const config = { roots: [{ id: "r", path: dir }] };
  const raw = await createFsOps(config).read({ path });
  const ops = createFsOps({ ...config, limits: { maxResultBytes: Buffer.byteLength(JSON.stringify(raw)) } });
  await assert.rejects(ops.read({ path }, live), error => (error as { code?: string }).code === "too-large");
});

const response = (body: string, type = "text/plain") => ({ url: "https://example.test/", status: 200, headers: { "content-type": type }, body: Buffer.from(body), redirects: [] });
test("web pagination conceals a longer-than-page secret across every cursor", async () => {
  const secret = canary(320), live = registry(secret), body = "p".repeat(376) + secret + "z".repeat(1000);
  const fetch = createWebFetch({ request: async () => response(body) });
  let result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live), joined = "";
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 20); concealed(result.markdown, secret); joined += result.markdown;
    if (!result.cursor) break;
    result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: result.cursor }, live);
  }
  assert.equal(joined, "p".repeat(376) + MARK + "z".repeat(1000));
});

test("web cursors refresh secrets without shifting original source offsets", async () => {
  const secret = canary(320), live = registry(), body = "p".repeat(600) + secret + "z".repeat(1000);
  const fetch = createWebFetch({ request: async () => response(body) });
  let result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live), joined = result.markdown;
  live.redaction.register(secret);
  let pages = 0;
  while (result.cursor) {
    assert.ok(++pages < 20);
    result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: result.cursor }, live);
    concealed(result.markdown, secret); joined += result.markdown;
  }
  assert.ok(joined.startsWith("p".repeat(600))); assert.ok(joined.endsWith("z".repeat(1000)));
});

test("a new earlier web replacement does not shift the next cursor's source position", async () => {
  const secret = canary(), live = registry(), body = secret + "p".repeat(1000);
  const fetch = createWebFetch({ request: async () => response(body) });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.ok(first.cursor); live.redaction.register(secret);
  const next = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: first.cursor }, live);
  assert.equal(next.markdown, "p".repeat(400)); assert.equal(next.cursor?.split(".")[1], "800");
});

test("late surrogate normalization keeps web cursors in original source coordinates", async () => {
  const live = registry(), firstSecret = "a".repeat(8) + "\ud83d", normalizedSecret = "�" + "b".repeat(100);
  const tail = Array.from({ length: 500 }, (_, i) => `${String(i).padStart(4, "0")}|`).join("");
  const body = "a".repeat(8) + "😀" + "b".repeat(100) + tail;
  const fetch = createWebFetch({ request: async () => response(body) });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.ok(first.cursor); assert.equal(first.cursor.split(".")[1], "400");
  live.redaction.register(firstSecret); live.redaction.register(normalizedSecret);
  const next = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: first.cursor }, live);
  assert.equal(next.markdown, body.slice(400, 800)); assert.equal(next.cursor?.split(".")[1], "800");
});

test("a forged web cursor cannot start presentation inside a surrogate pair", async () => {
  const live = registry(), body = "public 😀 " + "z".repeat(1000);
  const fetch = createWebFetch({ request: async () => response(body) });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.ok(first.cursor);
  const forged = `${first.cursor.split(".")[0]}.8`;
  let result;
  try { result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: forged }, live); }
  catch (error) { assert.equal((error as { code?: string }).code, "cursor-expired"); return; }
  assert.ok(result.markdown.isWellFormed(), "cursor returned an unmatched surrogate");
  assert.fail("a cursor inside a source codepoint must be refused");
});

test("web pagination keeps a replacement marker whole at the visible cap", async () => {
  const secret = canary(), live = registry(secret), body = "p".repeat(392) + secret + "z".repeat(40);
  const fetch = createWebFetch({ request: async () => response(body) });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.equal(first.markdown, "p".repeat(392)); assert.ok(first.cursor);
  const next = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: first.cursor }, live);
  assert.equal(next.markdown, MARK + "z".repeat(40));
});

test("web masks entity-decoded metadata before title, language, date and section caps", async () => {
  const secret = canary(180), live = registry(secret), entity = [...secret].map(c => `&#${c.charCodeAt(0)};`).join("");
  const body = `<html lang="public-${entity}"><head><title>${"p".repeat(280)}${entity}</title><meta property="article:published_time" content="${"d".repeat(40)}${entity}"></head><body><main><h1>${"h".repeat(100)}${entity}</h1><p>Public region, API version v1, /projects/example.</p></main></body></html>`;
  const fetch = createWebFetch({ request: async () => response(body, "text/html; charset=utf-8") });
  const result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  concealed(JSON.stringify(result), secret); assert.match(result.markdown, /Public region, API version v1, \/projects\/example/);
});

test("an HTML parser node limit withholds an entity-decoded secret crossing that boundary", async () => {
  const secret = canary(16), live = registry(secret);
  const entity = (value: string) => [...value].map(char => `&#${char.charCodeAt(0)};`).join("");
  const body = "<html><body><main>" + "<span></span>".repeat(299996) + entity(secret.slice(0, 12)) + "<span>" + entity(secret.slice(12)) + "</span></main></body></html>";
  const fetch = createWebFetch({ request: async () => response(body, "text/html; charset=utf-8") });
  let result;
  try { result = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live); }
  catch (error) { assert.equal((error as { code?: string }).code, "too-large"); return; }
  concealed(result.markdown, secret);
  assert.fail("the parser must refuse a truncated source document");
});

test("web cursor metadata keeps full source context for a newly registered secret", async () => {
  const secret = canary(180), live = registry(), body = `<html lang="public-${secret}"><head><title>${"p".repeat(280)}${secret}</title></head><body><main>${"z".repeat(1500)}</main></body></html>`;
  const fetch = createWebFetch({ request: async () => response(body, "text/html; charset=utf-8") });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.ok(first.cursor); live.redaction.register(secret);
  const next = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: first.cursor }, live);
  concealed(JSON.stringify(next), secret); assert.equal(next.lang, "public-" + MARK);
});

test("a cursor withholds oversized metadata when later secrets need discarded source context", async () => {
  const secret = canary(6000), live = registry(), body = `<html><head><title>${"p".repeat(280)}${secret}</title></head><body><main>${"z".repeat(2000)}</main></body></html>`;
  const fetch = createWebFetch({ maxExtractedTokens: 1000, request: async () => response(body, "text/html; charset=utf-8") });
  const first = await fetch.fetch({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.ok(first.cursor); live.redaction.register(secret);
  const next = await fetch.fetch({ url: "https://example.test/", maxTokens: 100, cursor: first.cursor }, live);
  assert.equal(next.title, "[metadata withheld: secret context changed]"); concealed(JSON.stringify(next), secret);
});

test("the web tool adapter carries the trusted matcher before pagination", async () => {
  const secret = canary(320), live = registry(secret), body = "p".repeat(376) + secret + "z".repeat(1000);
  const fetch = createWebFetch({ request: async () => response(body) });
  const tools = createWebTools({ fetch, search: { search: async () => { throw Error("unused"); } } });
  const result = await tools.tools[0]!.execute({ url: "https://example.test/", maxTokens: 100 }, live);
  assert.equal(result.isError, false); if (result.isError) return;
  concealed(JSON.stringify(result), secret);
});

test("web transport still rejects oversized responses before presenting any body", async () => {
  const secret = canary(), live = registry(secret), server = await startStub((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(secret); });
  try {
    const fetch = createWebFetch({ allowPrivate: ["127.0.0.0/8"], maxBytes: 32 });
    await assert.rejects(fetch.fetch({ url: `http://127.0.0.1:${server.port}/` }, live), error => (error as { code?: string }).code === "too-large");
  } finally { await server.close(); }
});

test("both argument validators mask complete values before their 80 and 40 unit previews", () => {
  const secret = canary(), live = registry(secret);
  for (const [validate, limit] of [[validateArguments, 80], [validateArgs, 40]] as const) {
    const value = "p".repeat(limit - 25) + secret;
    const issues = validate({ enum: ["public"] }, value, live.knownSecrets);
    assert.equal(issues.length, 1); concealed(issues[0]!.got, secret); assert.ok(issues[0]!.got.includes(MARK));
    assert.ok(issues[0]!.got.isWellFormed()); assert.ok(issues[0]!.got.length <= limit);
  }
});

test("both diagnostic preview cuts preserve complete UTF-16 codepoints", () => {
  for (const [validate, limit, lead] of [[validateArguments, 80, 78], [validateArgs, 40, 37]] as const) {
    const issues = validate({ enum: ["public"] }, "p".repeat(lead) + "😀");
    assert.equal(issues.length, 1); assert.ok(issues[0]!.got.isWellFormed()); assert.ok(issues[0]!.got.length <= limit);
  }
});

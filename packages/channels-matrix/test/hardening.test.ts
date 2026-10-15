import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MatrixApi, MatrixApiError, FileSyncTokenStore, MemorySyncTokenStore, parseMxc } from "../src/index.ts";
import { resolveConfig, type MatrixConfig } from "../src/config.ts";
import { mentionsBot } from "../src/events.ts";
import { toMatrixText } from "../src/markdown.ts";
import { redactString } from "../src/redact.ts";
import { ALICE, BOT, FakeMatrix, ROOM } from "./helpers/fake-matrix.ts";
import { Rig, newFake } from "./helpers/rig.ts";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------- markdown: bounded recursion, bounded event size

test("markdown: deeply nested quotes, lists and links never overflow the stack", () => {
  const hostile = ["> ".repeat(7900) + "x", "- ".repeat(7900) + "x", "[".repeat(3000) + "x" + "](https://a.b)".repeat(3000), "*_".repeat(3000) + "x" + "_*".repeat(3000)];
  for (const md of hostile) {
    assert.doesNotThrow(() => toMatrixText(md), md.slice(0, 12));
    const html = toMatrixText(md).formattedBody ?? "";
    for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) assert.ok(["blockquote", "p", "ul", "li", "a", "em", "strong", "br"].includes(m[1]!.toLowerCase()), m[1]);
  }
});

test("markdown: nesting below the depth limit keeps its structure", () => {
  assert.equal(toMatrixText("> > x").formattedBody, "<blockquote><blockquote><p>x</p></blockquote></blockquote>");
  assert.equal(toMatrixText("- a\n  - b").formattedBody, "<ul><li><p>a</p><ul><li>b</li></ul></li></ul>");
});

test("markdown: HTML escaping must not push an event over the Matrix size cap (formatted_body is dropped, the plain body is kept)", () => {
  for (const ch of ['"', "&", "'", "<"]) {
    const out = toMatrixText(`**b** ${ch.repeat(15_000)}`);
    assert.ok(bytes(out.body) + bytes(out.formattedBody ?? "") <= 60_000, `${ch}: ${bytes(out.body)} + ${bytes(out.formattedBody ?? "")}`);
    assert.ok(out.body.includes(ch.repeat(100)), "plain body is intact");
  }
  const small = toMatrixText('**b** "q"');
  assert.equal(small.formattedBody, "<strong>b</strong> &quot;q&quot;", "small messages keep their formatting");
  const tight = toMatrixText("**b** " + "x".repeat(500), 400);
  assert.equal(tight.formattedBody, undefined, "an explicit budget is honoured");
});

const open: { fake: FakeMatrix; rig: Rig }[] = [];
afterEach(async () => {
  for (const { rig, fake } of open.splice(0)) {
    await rig.close().catch(() => {});
    await fake.close().catch(() => {});
  }
});
async function setup(over: ConstructorParameters<typeof Rig>[1] = {}, store?: ConstructorParameters<typeof Rig>[2]): Promise<Rig> {
  const fake = await newFake();
  const rig = new Rig(fake, over, store);
  open.push({ fake, rig });
  await rig.start();
  return rig;
}

test("send/prompt/edit: every event stays under the 64 KiB cap even for escape-heavy text", async () => {
  const rig = await setup({ allowlist: [ROOM] });
  const text = `**b** ${'"'.repeat(15_500)}`;
  await rig.ch.send({ chatId: ROOM, text });
  const ref = await rig.ch.sendTurn({ chatId: ROOM, text: "first" });
  await rig.ch.edit(ref[0]!, text);
  for (const s of rig.fake.sent) assert.ok(bytes(JSON.stringify(s.content)) < 65_536, `${s.type} ${bytes(JSON.stringify(s.content))}`);
});

// ---------------------------------------------------------------- media references

test("mxc: a server part made of dots would climb out of the media path and is refused", () => {
  for (const bad of ["mxc://../abc", "mxc://./abc", "mxc://.../abc"]) assert.equal(parseMxc(bad), undefined, bad);
  assert.deepEqual(parseMxc("mxc://a..b.test/x"), { server: "a..b.test", mediaId: "x" });
});

// ---------------------------------------------------------------- mentions

test("legacy mentions: another user's mxid with the same localpart or a longer server name is not a mention of the bot", () => {
  const who = { userId: "@bot:hs.test" };
  for (const body of ["ask @bot:evil.example", "ask @bot:hs.test.evil.example", "ask @bot:hs.test:8448", "ask @bot:hs.test-evil.org"])
    assert.equal(mentionsBot({}, body, who), false, body);
  for (const body of ["@bot: hi", "@bot, hi", "hi @bot.", "(@bot:hs.test)", "@bot:hs.test, hi", "end @bot:hs.test."])
    assert.equal(mentionsBot({}, body, who), true, body);
});

// ---------------------------------------------------------------- config

test("config: a missing or non-array allowlist is a RangeError with fixed text, not a raw TypeError", () => {
  const base: MatrixConfig = { homeserverUrl: "https://hs.example.org", userId: BOT, accessTokenSecret: "matrix/bot-token", allowlist: [ROOM], dmAllowlist: [ALICE] };
  const bad: Partial<Record<keyof MatrixConfig, unknown>>[] = [{ allowlist: undefined }, { dmAllowlist: undefined }, { allowlist: "!a:b" }, { dmAllowlist: null }, { userAllowlist: "@a:b" }];
  for (const over of bad) assert.throws(() => resolveConfig({ ...base, ...over } as MatrixConfig), (e: unknown) => e instanceof RangeError, JSON.stringify(over));
});

// ---------------------------------------------------------------- sync store

test("file store: temp files left behind by a crash are swept on the next save, fresh ones are kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "matrix-sync-d07-"));
  try {
    const s = new FileSyncTokenStore(dir);
    await s.save("s1");
    const stale = join(dir, "matrix-sync.json.11111111-2222-3333-4444-555555555555.tmp");
    const fresh = join(dir, "matrix-sync.json.66666666-7777-8888-9999-000000000000.tmp");
    const other = join(dir, "unrelated.tmp");
    for (const f of [stale, fresh, other]) await writeFile(f, "{");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale, old, old);
    await s.save("s2");
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [fresh, other, "matrix-sync.json"].map((f) => f.split("/").pop()!).sort());
    assert.equal(await s.load(), "s2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- health while the sync position cannot be stored

test("a sync store that cannot save makes the channel unhealthy until it can again", async () => {
  let failing = false;
  const inner = new MemorySyncTokenStore();
  const store = {
    load: () => inner.load(),
    save: async (t: string) => {
      if (failing) throw new Error("disk full");
      await inner.save(t);
    },
  };
  const rig = await setup({ sleep: (_ms: number) => new Promise((r) => setTimeout(r, 5)) }, store);
  assert.equal((await rig.ch.health()).ok, true);
  failing = true;
  rig.fake.deliverNoWait(ROOM, [rig.fake.message(ROOM, ALICE, { msgtype: "m.text", body: "x" })]);
  const until = async (want: boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if ((await rig.ch.health()).ok === want) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`health never became ${want}`);
  };
  await until(false);
  failing = false;
  await until(true);
});

// ---------------------------------------------------------------- api: bounded error bodies, multipart overhead

function streamOf(total: number, chunk: number, counter: { pulled: number }): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      counter.pulled += n;
      c.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
}

test("api: an error response is read with a bound, not to its end", async () => {
  const counter = { pulled: 0 };
  const fetchFn = (async () => new Response(streamOf(32 * 1024 * 1024, 16 * 1024, counter), { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch;
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fetchFn });
  await assert.rejects(api.whoami(new AbortController().signal), (e: MatrixApiError) => e.kind === "http" && e.status === 500);
  assert.ok(counter.pulled <= 256 * 1024, `pulled ${counter.pulled} bytes`);
});

test("api: errcode of a normal error body is still read", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ errcode: "M_FORBIDDEN", error: "no" }), { status: 403 })) as typeof fetch;
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fetchFn });
  await assert.rejects(api.whoami(new AbortController().signal), (e: MatrixApiError) => e.errcode === "M_FORBIDDEN");
});

test("api: multipart framing does not count against the media size limit", async () => {
  const media = Buffer.alloc(200, 0x61);
  const body = Buffer.concat([
    Buffer.from("--B\r\nContent-Type: application/json\r\n\r\n{}\r\n--B\r\nContent-Type: image/png\r\n\r\n"),
    media,
    Buffer.from("\r\n--B--\r\n"),
  ]);
  const fetchFn = (async () => new Response(body, { status: 200, headers: { "content-type": "multipart/mixed; boundary=B" } })) as typeof fetch;
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fetchFn });
  const r = await api.downloadMedia("mxc://hs.test/abc", 250, new AbortController().signal);
  assert.equal(r.data.length, 200);
  const over = await api.downloadMedia("mxc://hs.test/abc", 150, new AbortController().signal).catch((e: MatrixApiError) => e);
  assert.ok(over instanceof MatrixApiError && over.kind === "too-large", "a part over the limit is still refused");
});

// ---------------------------------------------------------------- redaction

test("redaction: the exact token is also removed in URL-encoded and JSON-escaped form", () => {
  const tok = 'abc/def+ghi=jkl"mno\\pqr_12345';
  const forms = [encodeURIComponent(tok), JSON.stringify(tok).slice(1, -1), tok];
  for (const f of forms) {
    const out = redactString(`failed: ...?x=${f} and ${f}`, tok);
    assert.ok(!out.includes(f), `${f} survived: ${out}`);
  }
});

// ---------------------------------------------------------------- KNOWN GAPs (need a change outside this module's remit)

test("KNOWN GAP: a crash between handing a batch to the handlers and saving its next_batch delivers those events again after the restart", { todo: "the de-duplication set is in memory only; remembering delivered event ids across restarts needs a new field in the sync-state file (a stored format change), or a SyncTokenStore port change" }, async () => {
  assert.fail("events of an unsaved batch are replayed to onMessage handlers and the host after a restart");
});

test("KNOWN GAP: after a restart the first sync of an encrypted room carries no m.room.encryption state, so a plaintext m.room.message sent there is processed", { todo: "needs the room's encryption state to be persisted or fetched per room (an extra GET /state call); the sync filter alone cannot supply it" }, async () => {
  assert.fail("plaintext events in a room that has encryption enabled are accepted until an m.room.encrypted event is seen");
});

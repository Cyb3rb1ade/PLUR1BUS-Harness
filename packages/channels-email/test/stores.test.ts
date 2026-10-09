import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileUidStore, MemoryUidStore } from "../src/uid-store.ts";
import { FileThreadStore, MemoryThreadStore, capReferences, chainFor, replySubject, threadKey } from "../src/threading.ts";
import { truncateBody, splitMessage, EMAIL_MAX_BODY_CHARS } from "../src/split.ts";
import { EmailError } from "../src/wire.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "email-state-"));
}

test("FileUidStore: round trip, atomic replace leaves no temp files, missing is undefined", async () => {
  const dir = await tempDir();
  try {
    const s = new FileUidStore(dir);
    assert.equal(await s.load(), undefined);
    await s.save({ folder: "INBOX", uidValidity: 7, lastUid: 42 });
    await s.save({ folder: "INBOX", uidValidity: 7, lastUid: 43 });
    assert.deepEqual(await s.load(), { folder: "INBOX", uidValidity: 7, lastUid: 43 });
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const BAD_UID = [
  "not json",
  '{"folder":"INBOX","uidValidity":-1,"lastUid":2}',
  '{"folder":"","uidValidity":1,"lastUid":2}',
  '{"folder":"INBOX","uidValidity":1.5,"lastUid":2}',
  '{"uidValidity":1,"lastUid":2}',
  "[]",
];
for (const body of BAD_UID) {
  test(`FileUidStore: corrupt state fails closed (${body.slice(0, 20)})`, async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, "email-uid.json"), body);
      await assert.rejects(new FileUidStore(dir).load(), (e: unknown) => e instanceof Error && !e.message.includes(body));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("MemoryUidStore copies state", async () => {
  const s = new MemoryUidStore();
  const st = { folder: "INBOX", uidValidity: 1, lastUid: 1 };
  await s.save(st);
  st.lastUid = 99;
  assert.equal((await s.load())?.lastUid, 1);
});

test("FileThreadStore: persists, fails closed on corrupt state, keeps names out of the file key", async () => {
  const dir = await tempDir();
  try {
    const s = new FileThreadStore(dir);
    const key = threadKey("root@example.test");
    assert.match(key, /^t-[0-9a-f]{32}$/);
    assert.equal(await s.get(key), undefined);
    await s.put(key, { peer: "alice@example.test", subject: "Plan", chain: ["root@example.test"] });
    assert.deepEqual(await new FileThreadStore(dir).get(key), { peer: "alice@example.test", subject: "Plan", chain: ["root@example.test"] });
    await writeFile(join(dir, "email-threads.json"), '{"t-zz":1}');
    await assert.rejects(s.get(key), EmailError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MemoryThreadStore: copies on read and write", async () => {
  const s = new MemoryThreadStore();
  const rec = { peer: "a@b.test", subject: "s", chain: ["x@y"] };
  await s.put("k", rec);
  rec.chain.push("z@y");
  assert.deepEqual((await s.get("k"))?.chain, ["x@y"]);
});

const SUBJECTS: [string, string][] = [
  ["Plan", "Re: Plan"],
  ["re: Plan", "re: Plan"],
  ["RE: Plan", "RE: Plan"],
  ["  spaced  ", "Re: spaced"],
  ["", "Re:"],
  ["multi\r\nline", "Re: multi line"],
];
for (const [input, want] of SUBJECTS) {
  test(`replySubject: ${JSON.stringify(input)}`, () => {
    assert.equal(replySubject(input), want);
  });
}

test("capReferences keeps the root and drops the oldest middle entries first", () => {
  const long = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(3, "0")}-${"x".repeat(40)}@example.test`);
  const capped = capReferences(long, 900);
  assert.equal(capped[0], long[0]);
  assert.equal(capped.at(-1), long.at(-1));
  assert.ok(capped.reduce((n, x) => n + x.length + 3, 0) <= 900);
  assert.deepEqual(capReferences(["a@x"]), ["a@x"]);
});

test("chainFor: references then own Message-ID, no duplicate", () => {
  assert.deepEqual(chainFor(["r@x", "p@x"], "m@x"), ["r@x", "p@x", "m@x"]);
  assert.deepEqual(chainFor(["r@x", "m@x"], "m@x"), ["r@x", "m@x"]);
  assert.deepEqual(chainFor([], undefined), []);
});

test("truncateBody and splitMessage never tear surrogate pairs", () => {
  const emoji = "🙂".repeat(EMAIL_MAX_BODY_CHARS);
  const t = truncateBody(emoji, "[cut]");
  assert.equal(t.truncated, true);
  assert.ok(!/[\ud800-\udbff]$/.test(t.text.replace("\n\n[cut]", "")));
  const parts = splitMessage("ab🙂".repeat(10), 7);
  for (const p of parts) assert.ok(!/[\ud800-\udbff]$/.test(p), p);
  assert.equal(truncateBody("short", "[cut]").text, "short");
});

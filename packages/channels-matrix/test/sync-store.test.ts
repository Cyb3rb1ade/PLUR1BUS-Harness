import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FileSyncTokenStore, MemorySyncTokenStore } from "../src/index.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "matrix-sync-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("file store: missing state loads as undefined; saved token round-trips", async () => {
  const s = new FileSyncTokenStore(join(dir, "a"));
  assert.equal(await s.load(), undefined);
  await s.save("s123_abc-DEF");
  assert.equal(await s.load(), "s123_abc-DEF");
});

test("file store: the write is atomic and leaves no temp files behind", async () => {
  const d = join(dir, "atomic");
  const s = new FileSyncTokenStore(d);
  await s.save("s1");
  await s.save("s2");
  assert.deepEqual((await readdir(d)).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(JSON.parse(await readFile(join(d, "matrix-sync.json"), "utf8")).nextBatch, "s2");
});

for (const [name, content] of [
  ["invalid JSON", "{not json"],
  ["wrong shape", JSON.stringify({ offset: 4 })],
  ["empty token", JSON.stringify({ nextBatch: "" })],
  ["token with whitespace", JSON.stringify({ nextBatch: "s 1" })],
  ["non-string token", JSON.stringify({ nextBatch: 7 })],
] as const) {
  test(`file store: corrupt state (${name}) fails closed without echoing the file`, async () => {
    const d = join(dir, `corrupt-${name.replace(/\W+/g, "-")}`);
    await writeFile(join(dir, "placeholder"), "");
    const s = new FileSyncTokenStore(d);
    await (await import("node:fs/promises")).mkdir(d, { recursive: true });
    await writeFile(join(d, "matrix-sync.json"), content);
    await assert.rejects(s.load(), (e: Error) => {
      assert.ok(e.message.startsWith("matrix sync state is"));
      assert.ok(!e.message.includes(content));
      return true;
    });
  });
}

test("file store: unreadable state (a directory where the file should be) fails closed", async () => {
  const d = join(dir, "unreadable");
  await (await import("node:fs/promises")).mkdir(join(d, "matrix-sync.json"), { recursive: true });
  await assert.rejects(new FileSyncTokenStore(d).load(), /unreadable/);
});

test("file store: an invalid token is never written", async () => {
  await assert.rejects(new FileSyncTokenStore(join(dir, "w")).save("bad token"), /invalid/);
});

test("memory store: same contract", async () => {
  const m = new MemorySyncTokenStore();
  assert.equal(await m.load(), undefined);
  await m.save("s9");
  assert.equal(await m.load(), "s9");
  await assert.rejects(m.save(""), /invalid/);
});

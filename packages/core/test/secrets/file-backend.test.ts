import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileBackend, FILE_SCHEMA } from "../../src/secrets/file-backend.ts";
import { SecretError } from "../../src/secrets/types.ts";
import { MARKER, secure } from "./helpers.ts";

const now = new Date("2026-10-06T10:00:00.000Z");
const setup = (extra: Partial<Parameters<typeof createFileBackend>[0]> = {}) => {
  const dir = join(tempDir("p1b-sec-"), "secrets");
  return { dir, b: createFileBackend({ dir, secure, ...extra }), store: join(dir, "store.json"), key: join(dir, "store.key") };
};
const readStore = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const corrupt = (e: unknown) => e instanceof SecretError && e.code === "corrupt";

describe("encrypted file backend", () => {
  it("never writes the value in the clear and uses a fresh nonce per write", async () => {
    const { b, store, key } = setup();
    await b.put("k", MARKER, now); const first = readStore(store).entries.k;
    await b.put("k", MARKER, now); const second = readStore(store).entries.k;
    assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ct, second.ct);
    assert.ok(!readFileSync(store, "utf8").includes(MARKER));
    assert.ok(!readFileSync(key, "utf8").includes(MARKER));
    assert.equal(readStore(store).schema, FILE_SCHEMA);
  });
  it("creates the store, key and directory private (POSIX 0600/0700)", async (t) => {
    if (process.platform === "win32") return t.skip("ACLs are covered by securePath's own tests");
    const { b, dir, store, key } = setup();
    await b.put("k", MARKER, now);
    assert.equal(statSync(store).mode & 0o777, 0o600); assert.equal(statSync(key).mode & 0o777, 0o600); assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
  const tamper: [string, (store: string, key: string) => void][] = [
    ["a flipped ciphertext byte", (s) => { const d = readStore(s); const c = Buffer.from(d.entries.a.ct, "base64"); c[0] = c[0]! ^ 1; d.entries.a.ct = c.toString("base64"); writeFileSync(s, JSON.stringify(d)); }],
    ["a flipped tag byte", (s) => { const d = readStore(s); const c = Buffer.from(d.entries.a.tag, "base64"); c[3] = c[3]! ^ 0x80; d.entries.a.tag = c.toString("base64"); writeFileSync(s, JSON.stringify(d)); }],
    ["a changed nonce", (s) => { const d = readStore(s); d.entries.a.nonce = Buffer.alloc(12, 7).toString("base64"); writeFileSync(s, JSON.stringify(d)); }],
    ["a truncated tag", (s) => { const d = readStore(s); d.entries.a.tag = Buffer.alloc(4).toString("base64"); writeFileSync(s, JSON.stringify(d)); }],
    ["a ciphertext moved to another name", (s) => { const d = readStore(s); d.entries.a = { ...d.entries.a, ct: d.entries.b.ct, nonce: d.entries.b.nonce, tag: d.entries.b.tag }; writeFileSync(s, JSON.stringify(d)); }],
    ["a different key", (_s, k) => writeFileSync(k, `${Buffer.alloc(32, 9).toString("base64")}\n`)],
    ["a key of the wrong length", (_s, k) => writeFileSync(k, `${Buffer.alloc(16, 9).toString("base64")}\n`)],
    ["a missing key file", (_s, k) => { renameSync(k, `${k}.gone`); }],
    ["a truncated store", (s) => writeFileSync(s, readFileSync(s, "utf8").slice(0, 40))],
    ["a foreign schema", (s) => { const d = readStore(s); d.schema = "other/9"; writeFileSync(s, JSON.stringify(d)); }],
    ["an entry missing fields", (s) => { const d = readStore(s); delete d.entries.a.tag; writeFileSync(s, JSON.stringify(d)); }],
  ];
  for (const [what, mutate] of tamper) {
    it(`fails closed on ${what}`, async () => {
      const { b, store, key } = setup();
      await b.put("a", `${MARKER}-a`, now); await b.put("b", `${MARKER}-b`, now);
      mutate(store, key);
      await assert.rejects(() => b.get("a"), (e) => { assert.ok(corrupt(e), String(e)); assert.ok(!String((e as Error).message).includes(MARKER)); assert.ok(!String((e as Error).stack).includes(MARKER)); return true; });
    });
  }
  it("does not regenerate the key over existing entries", async () => {
    const { b, store, key } = setup();
    await b.put("a", MARKER, now);
    renameSync(key, `${key}.gone`);
    await assert.rejects(() => b.put("c", "x", now), corrupt);
    assert.ok(!existsSync(key)); assert.ok(Object.keys(readStore(store).entries).includes("a"));
  });
  it("probe reports a corrupt store as unavailable instead of throwing", async () => {
    const { b, store } = setup();
    await b.put("a", MARKER, now); writeFileSync(store, "{not json");
    assert.deepEqual(await b.probe(), { available: false, reason: "corrupt" });
  });
  it("a failed rename leaves the old store intact and no temp file behind", async () => {
    let fail = false;
    const { b, dir, store } = setup({ rename: (f, t) => { if (fail) throw Object.assign(new Error("EXDEV details with /secret/path"), { code: "EXDEV" }); renameSync(f, t); } });
    await b.put("a", `${MARKER}-1`, now);
    const before = readFileSync(store, "utf8");
    fail = true;
    await assert.rejects(() => b.put("a", `${MARKER}-2`, now), (e) => e instanceof SecretError && e.code === "storage" && !e.message.includes("/secret/path"));
    assert.equal(readFileSync(store, "utf8"), before);
    assert.deepEqual(readdirSync(dir).sort(), ["store.json", "store.key"]);
    fail = false;
    assert.equal(await b.get("a"), `${MARKER}-1`);
  });
});

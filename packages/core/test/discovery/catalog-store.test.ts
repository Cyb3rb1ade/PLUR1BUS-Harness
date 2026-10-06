import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCatalogStore, validateCatalog, CatalogWriteError } from "../../src/discovery/catalog-store.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogFile, CatalogModel } from "../../src/discovery/types.ts";
import { FakeClock } from "../../src/discovery/testing.ts";
import { createPlatformCapabilities } from "../../src/platform.ts";

const win = process.platform === "win32";
const REV = "2026-10-03.1";
const logger = { info() {}, warn() {} };

function model(id: string, provider = "p"): CatalogModel {
  return { provider, id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available", firstSeen: "2026-10-03T00:00:00.000Z", lastSeen: "2026-10-03T00:00:00.000Z", source: "scan", overrides: {} };
}
function setup(extra: { securePath?: (p: string) => unknown; hooks?: { beforeRename?: () => void } } = {}) {
  const dir = tempDir("p1b-cat-");
  const path = join(dir, "catalog", "models.json");
  const secured: string[] = [];
  const securePath = (p: string) => { secured.push(p); return extra.securePath?.(p); };
  const mk = () => createCatalogStore({ path, tableRevision: REV, clock: new FakeClock(1_000), securePath, logger, ...(extra.hooks ? { hooks: extra.hooks } : {}) });
  return { dir, path, secured, mk };
}
const add = (id: string) => (c: CatalogFile) => ({ next: { ...c, models: [...c.models, model(id)] }, result: id });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
import { mkdirSync } from "node:fs";

describe("catalog store", () => {
  it("creates models.json 0600 with the schema id and revision 1", { skip: win }, async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await store.mutate(add("a"));
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
    const parsed = json(s.path);
    assert.equal(parsed.schema, "plur1bus.model-catalog/1");
    assert.equal(parsed.revision, 1);
  });

  it("secures the temp file before the rename and the .prev copy", async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await store.mutate(add("a")); await store.mutate(add("b"));
    assert.match(s.secured[0]!, /models\.json\.tmp-\d+$/);
    assert.ok(s.secured.some((p) => p.endsWith("models.json.prev")));
  });

  it("keeps exactly one .prev", async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await store.mutate(add("a")); await store.mutate(add("b")); await store.mutate(add("c"));
    assert.equal(json(s.path).revision, 3);
    assert.equal(json(`${s.path}.prev`).revision, 2);
    assert.deepEqual(readdirSync(join(s.dir, "catalog")).filter((f) => f.includes(".tmp-")), []);
  });

  it("a kill between write and rename leaves the old file intact", async () => {
    let armed = false;
    const s = setup({ hooks: { beforeRename: () => { if (armed) throw new Error("killed"); } } });
    mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await store.mutate(add("a")); await store.mutate(add("b"));
    armed = true;
    await assert.rejects(store.mutate(add("c")), CatalogWriteError);
    assert.equal(json(s.path).revision, 2);
    assert.ok(readdirSync(join(s.dir, "catalog")).some((f) => f.includes(".tmp-")), "the temp file is left, as a kill would");
    const again = s.mk(); again.load();
    assert.deepEqual(readdirSync(join(s.dir, "catalog")).filter((f) => f.includes(".tmp-")), []);
    assert.equal(again.read().revision, 2);
  });

  it("a failed write advances no state and releases the lock", async () => {
    let fail = true;
    const s = setup({ hooks: { beforeRename: () => { if (fail) throw new Error("disk full"); } } });
    mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await assert.rejects(store.mutate(add("a")), CatalogWriteError);
    assert.equal(store.read().revision, 0);
    assert.equal(store.read().models.length, 0);
    fail = false;
    await store.mutate(add("a"));
    assert.equal(store.read().revision, 1);
  });

  it("mutations are serialised", async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    const store = s.mk(); store.load();
    await Promise.all([store.mutate(add("a")), store.mutate(add("b"))]);
    assert.equal(store.read().revision, 2);
    assert.deepEqual(store.read().models.map((m) => m.id).sort(), ["a", "b"]);
  });

  it("quarantines an invalid file and starts from a valid .prev", async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    const first = s.mk(); first.load();
    await first.mutate((c) => ({ next: { ...c, providers: { p: { lastScanAt: "2026-10-03T00:00:00.000Z", lastResult: "ok" } }, models: [model("a")] }, result: 0 }));
    await first.mutate(add("b"));
    writeFileSync(s.path, "{ not json");
    const second = s.mk(); const r = second.load();
    assert.equal(r.recovered, "prev");
    assert.ok(readdirSync(join(s.dir, "catalog")).some((f) => /^models\.json\.corrupt-\d+$/.test(f)));
    for (const st of Object.values(second.read().providers)) assert.equal(st.lastScanAt, undefined);
    assert.equal(second.read().models.length, 1);
  });

  it("both files invalid starts empty", async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    writeFileSync(s.path, "garbage"); writeFileSync(`${s.path}.prev`, "garbage too");
    const store = s.mk(); const r = store.load();
    assert.equal(r.recovered, "empty");
    assert.equal(store.read().revision, 0);
    assert.deepEqual(store.read().models, []);
  });

  it("validateCatalog refuses", () => {
    const good = { ...emptyCatalog(REV), models: [model("a")] };
    assert.equal(validateCatalog(good).ok, true);
    assert.equal(validateCatalog({ ...good, schema: "other/1" }).ok, false);
    assert.equal(validateCatalog({ ...good, models: [{ ...model("a"), status: "deleted" }] }).ok, false);
    assert.equal(validateCatalog({ ...good, models: [model("a"), model("a")] }).ok, false);
    const { models: _m, ...noModels } = good; void _m;
    assert.equal(validateCatalog(noModels).ok, false);
  });

  it("refuses a models.json larger than 16 MiB", () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    writeFileSync(s.path, JSON.stringify({ ...emptyCatalog(REV), pad: "x".repeat(17 * 1024 * 1024) }));
    const store = s.mk(); const r = store.load();
    assert.equal(r.recovered, "empty");
    assert.ok(existsSync(s.path) === false || statSync(s.path).size < 1024 * 1024);
  });

  it("the real securePath applies a user+SYSTEM DACL on win32", { skip: !win }, async () => {
    const s = setup(); mkdirSync(join(s.dir, "catalog"));
    writeFileSync(s.path, "{}"); // securePath of a missing path is { applied: false, reason: "missing" }
    const sp = createPlatformCapabilities({}).securePath;
    assert.equal((sp(s.path) as { applied?: boolean } | undefined)?.applied, true);
  });

  it("securePath returning applied:false fails closed (State I6)", async () => {
    const s = setup({
      securePath: () => ({ applied: false }),
    });
    mkdirSync(join(s.dir, "catalog"));
    const store = s.mk();
    await assert.rejects(
      () => store.mutate((c) => ({ next: c, result: null })),
      (err: any) => err.name === "CatalogWriteError",
    );
    assert.equal(existsSync(s.path), false);
  });
});

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { startFakeSupervisor, type FakeSupervisor } from "../../module-api/test/helpers/fake-supervisor.ts";
import { flattenPatch, openConfigSource, type ConfigSource } from "../src/config-source.ts";
import type { HarnessLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const cleanup: { close(): Promise<void> }[] = [];
after(async () => { for (const c of cleanup.splice(0)) await c.close(); });

function capture(): HarnessLogger & { records: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const records: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const make = (): any => ({
    debug: (msg: string, fields?: Record<string, unknown>) => records.push({ level: "debug", msg, ...(fields ? { fields } : {}) }),
    info: (msg: string, fields?: Record<string, unknown>) => records.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
    warn: (msg: string, fields?: Record<string, unknown>) => records.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    error: (msg: string, fields?: Record<string, unknown>) => records.push({ level: "error", msg, ...(fields ? { fields } : {}) }),
    child: () => make(), setLevel: () => {}, setRotation: () => {}, close: async () => {},
  });
  return Object.assign(make(), { records });
}

function homeWith(config: HarnessConfig): string {
  const home = tempDir("p1b-cfgsrc-");
  writeFileSync(layout(home).configPath, JSON.stringify(config));
  return home;
}
const until = async (pred: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("condition not met in time"); await new Promise((r) => setTimeout(r, 10)); } };
const withLevel = (level: HarnessConfig["core"]["logLevel"]): HarnessConfig => { const c = defaults(); c.core.logLevel = level; return c; };

async function supervised(home: string, config: HarnessConfig, logger = capture()): Promise<{ sup: FakeSupervisor; source: ConfigSource; logger: ReturnType<typeof capture> }> {
  const sup = await startFakeSupervisor({ home, config: config as unknown as Record<string, unknown> }); cleanup.push(sup);
  const source = await openConfigSource({ layout: layout(home), supervised: true, logger, attempts: 1, connectTimeoutMs: 500 }); cleanup.push(source);
  return { sup, source, logger };
}

describe("config source (B7)", () => {
  it("supervised source serves the snapshot, not the file", async () => {
    const home = homeWith(withLevel("info"));
    const { sup, source } = await supervised(home, withLevel("debug"));
    assert.equal(source.source, "supervisor");
    assert.equal(source.current().core.logLevel, "debug");
    assert.equal(source.revision(), sup.revision);
    assert.equal(source.restartPending(), false);
    const seen: string[][] = [];
    source.onChange((prev, next, plan) => { seen.push([prev.core.logLevel, next.core.logLevel, ...plan.restart.live]); });
    sup.push(withLevel("warn") as unknown as Record<string, unknown>);
    await until(() => seen.length === 1);
    assert.deepEqual(seen, [["debug", "warn", "core.logLevel"]]);
    assert.equal(source.revision(), sup.revision);
  });

  it("an invalid pushed config is ignored and logged", async () => {
    const home = homeWith(defaults());
    const { sup, source, logger } = await supervised(home, withLevel("info"));
    const before = source.revision();
    let changes = 0; source.onChange(() => { changes++; });
    sup.pushRaw({ revision: "bad", previousRevision: before, changed: ["core.logLevel"], restart: { live: ["core.logLevel"], core: false, modules: [] }, config: { ...withLevel("info"), core: { logLevel: "loud" } }, source: "file" });
    await until(() => logger.records.some((r) => r.msg === "pushed configuration is invalid; ignored"));
    assert.equal(source.current().core.logLevel, "info");
    assert.equal(source.revision(), before);
    assert.equal(changes, 0);
  });

  it("unreachable supervisor falls back to the file", async () => {
    const home = homeWith(withLevel("warn"));
    const logger = capture();
    const source = await openConfigSource({ layout: layout(home), supervised: true, logger, attempts: 1, connectTimeoutMs: 100 }); cleanup.push(source);
    assert.equal(source.source, "file");
    assert.equal(source.current().core.logLevel, "warn");
    assert.equal(source.revision(), null);
    assert.equal(source.set([{ key: "core.logLevel", value: "info" }]), null, "no supervisor to send a change to");
    assert.ok(logger.records.some((r) => r.level === "warn" && r.msg === "supervisor configuration unavailable; reading config.json"), JSON.stringify(logger.records));
  });

  it("restartPending follows a core-class change", async () => {
    const home = homeWith(defaults());
    const built = defaults();
    const { sup, source } = await supervised(home, built);
    const changed = structuredClone(built); changed.engine = { ...changed.engine, duplicateThreshold: 1.01 };
    sup.push(changed as unknown as Record<string, unknown>);
    await until(() => source.revision() === sup.revision);
    assert.equal(source.restartPending(), true);
    sup.push(withLevel("debug") as unknown as Record<string, unknown>); // back to the engine the core was built with
    await until(() => source.revision() === sup.revision);
    assert.equal(source.restartPending(), false, "a live-only difference is not pending");
  });

  it("re-watching applies a push behind the reply and one sent while the old watch closes (I1)", async () => {
    const home = homeWith(defaults());
    const { sup, source } = await supervised(home, withLevel("info"));
    const seen: string[] = []; source.onChange((_p, next) => { seen.push(next.core.logLevel); });
    await sup.stopListening(); // supervisor A goes away; its connection to the core stays open for now
    let b: FakeSupervisor | null = null;
    b = await startFakeSupervisor({
      home, config: withLevel("warn") as unknown as Record<string, unknown>,
      onWatch: () => {
        b!.push(withLevel("error") as unknown as Record<string, unknown>); // same chunk as the reply
        setImmediate(() => b!.push(withLevel("debug") as unknown as Record<string, unknown>)); // during the old close
      },
    }); cleanup.push(b);
    await source.resubscribe();
    await until(() => source.revision() === b!.revision);
    assert.equal(source.current().core.logLevel, "debug");
    assert.equal(source.source, "supervisor");
    assert.equal(seen.at(-1), "debug");
    await sup.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(source.source, "supervisor", "closing A's old connection is not a lost watch");
  });

  it("a lost watch falls back to the file and re-watches with backoff (M1)", async () => {
    const home = homeWith(withLevel("warn"));
    const sup = await startFakeSupervisor({ home, config: withLevel("debug") as unknown as Record<string, unknown> });
    const logger = capture();
    const source = await openConfigSource({ layout: layout(home), supervised: true, logger, attempts: 1, connectTimeoutMs: 200, rewatchMs: { initial: 50, max: 200 } }); cleanup.push(source);
    assert.equal(source.current().core.logLevel, "debug");
    await sup.close();
    await until(() => source.source === "file");
    assert.equal(source.current().core.logLevel, "warn", "config.json runs now");
    assert.equal(source.revision(), null);
    assert.equal(source.set([{ key: "core.logLevel", value: "info" }]), null);
    assert.ok(logger.records.some((r) => r.msg === "supervisor configuration watch lost; reading config.json and re-watching"));
    const next = await startFakeSupervisor({ home, config: withLevel("error") as unknown as Record<string, unknown> }); cleanup.push(next);
    await until(() => source.source === "supervisor", 5000);
    assert.equal(source.current().core.logLevel, "error");
    assert.equal(source.revision(), next.revision);
  });

  it("a failed resubscribe reads the file (M1)", async () => {
    const home = homeWith(withLevel("warn"));
    const logger = capture();
    const source = await openConfigSource({ layout: layout(home), supervised: true, logger, attempts: 1, connectTimeoutMs: 100, rewatchMs: { initial: 60_000, max: 60_000 } }); cleanup.push(source);
    assert.equal(source.source, "file");
    writeFileSync(layout(home).configPath, JSON.stringify(withLevel("error"))); // edited meanwhile
    await source.resubscribe();
    assert.equal(source.source, "file");
    assert.equal(source.current().core.logLevel, "error", "the file is read again");
    assert.ok(logger.records.some((r) => r.msg === "supervisor configuration re-watch failed"));
  });

  it("flattenPatch yields leaf keys", () => {
    assert.deepEqual(flattenPatch("engine", { recall: { x: 1 }, tags: ["a"] }), [{ key: "engine.recall.x", value: 1 }, { key: "engine.tags", value: ["a"] }]);
    assert.deepEqual(flattenPatch("engine", {}), []);
    assert.deepEqual(flattenPatch("engine", { a: null, b: { c: { d: false } } }), [{ key: "engine.a", value: null }, { key: "engine.b.c.d", value: false }]);
  });
});

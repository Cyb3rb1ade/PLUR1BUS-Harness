import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { ConfigInvalid, loadConfig, readConfigFile, validateConfig, writeConfigAtomic } from "../src/config-load.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const MARK = "zxq-plain-marker-value";
const file = (name = "config.json") => join(tempDir("p1b-cfg-hard-"), name);

describe("config-load hardening (c10)", () => {
  it("a JSON syntax error never echoes file content (the parser quotes a snippet)", () => {
    for (const load of [loadConfig, readConfigFile]) {
      const p = file();
      writeFileSync(p, `{"channels": {"telegram": {"webhook": {"secret": ${MARK}}}}}`);
      assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid && !e.message.includes(MARK) && !e.errors.join().includes(MARK));
    }
  });

  it("a file that cannot be read is a ConfigInvalid, not a raw errno exception", () => {
    for (const load of [loadConfig, readConfigFile]) {
      const p = file(); mkdirSync(p); // config.json is a directory
      assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid);
    }
  });

  it("a huge file is refused before it is read into memory and parsed", () => {
    for (const load of [loadConfig, readConfigFile]) {
      const p = file();
      writeFileSync(p, `{"schemaVersion":1,"pad":"${"a".repeat(9 * 1024 * 1024)}"}`);
      assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid && /too large/.test(e.message));
    }
  });

  it("__proto__ keys in free-form sections are refused (they poison Object.assign/merge consumers)", () => {
    const raw = `{"schemaVersion":1,"engine":{"__proto__":{"polluted":1}}}`;
    for (const load of [loadConfig, readConfigFile]) {
      const p = file(); writeFileSync(p, raw);
      assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid && e.errors.some((s: string) => s.includes("/engine/__proto__")));
    }
    const nested = JSON.parse(`{"schemaVersion":1,"modules":{"m":{"enabled":true,"deep":[{"__proto__":{}}]}}}`);
    const r = validateConfig(nested);
    assert.equal(r.ok, false);
  });

  it("absurd nesting yields a ConfigInvalid, not a stack overflow", () => {
    const p = file();
    writeFileSync(p, `{"schemaVersion":1,"engine":{"x":${"[".repeat(200_000)}${"]".repeat(200_000)}}}`);
    assert.throws(() => loadConfig(p), (e: any) => e instanceof ConfigInvalid);
  });

  it("the migration backup is as private as config.json (0600)", { skip: process.platform === "win32" }, () => {
    const p = file();
    const d: any = defaults(); delete d.modelProfiles; // a pre-C4 file: the additive migration applies
    writeFileSync(p, JSON.stringify(d), { mode: 0o600 });
    const old = process.umask(0o022);
    try { loadConfig(p); } finally { process.umask(old); }
    const bak = readdirSync(join(p, "..")).find(n => n.includes(".bak-"));
    assert.ok(bak, "backup written");
    assert.equal(statSync(join(p, "..", bak!)).mode & 0o777, 0o600);
  });

  it("a stale temp file with loose permissions does not make config.json world-readable", { skip: process.platform === "win32" }, () => {
    const p = file(); const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, "stale"); chmodSync(tmp, 0o644);
    writeConfigAtomic(p, defaults());
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  it("a failed rename leaves no temp file behind", () => {
    const p = file(); mkdirSync(p); // rename over a directory fails
    assert.throws(() => writeConfigAtomic(p, defaults()));
    assert.deepEqual(readdirSync(join(p, "..")).filter(n => n.includes(".tmp-")), []);
  });
});

describe("config cross-field rules", () => {
  // The same rule lives in crates/plur1bus-config (validate); the two must agree or core and supervisor disagree about one file.
  const recall = (soft: number, hard: number) => { const c: any = defaults(); c.core.recall.softBudgetMs = soft; c.core.recall.hardBudgetMs = hard; return c; };

  it("core.recall.softBudgetMs above hardBudgetMs is refused, at or below it is accepted", () => {
    for (const [soft, hard] of [[601, 600], [5000, 100], [1_000_000, 999_999]] as const) {
      const r = validateConfig(recall(soft, hard));
      assert.equal(r.ok, false, `${soft} > ${hard}`);
      assert.ok(!r.ok && r.errors.some(e => e === "/core/recall softBudgetMs must not exceed hardBudgetMs"), JSON.stringify(r));
    }
    for (const [soft, hard] of [[600, 600], [400, 600], [50, 100], [50, 50_000]] as const) assert.equal(validateConfig(recall(soft, hard)).ok, true, `${soft} <= ${hard}`);
  });

  it("the rule holds for a config file, with either value taken from the schema default", () => {
    for (const patch of [{ softBudgetMs: 700 }, { hardBudgetMs: 300 }]) { // default soft 400 / hard 600
      const p = file();
      writeFileSync(p, JSON.stringify({ schemaVersion: 1, core: { recall: patch } }));
      for (const load of [loadConfig, readConfigFile]) assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid && e.errors.some((s: string) => s.includes("softBudgetMs must not exceed hardBudgetMs")));
    }
    const ok = file();
    writeFileSync(ok, JSON.stringify({ schemaVersion: 1, core: { recall: { softBudgetMs: 500, hardBudgetMs: 800 } } }));
    assert.equal(loadConfig(ok).config.core.recall.hardBudgetMs, 800);
  });
});

describe("config schema bounds", () => {
  // The limits themselves are pinned in packages/config-schema/test/schema-bounds.test.ts; this is the path a config file takes.
  const refuses = (patch: Record<string, unknown>, mentions: string) => {
    const p = file();
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, ...patch }));
    for (const load of [loadConfig, readConfigFile]) assert.throws(() => load(p), (e: any) => e instanceof ConfigInvalid && e.errors.some((s: string) => s.includes(mentions)), mentions);
  };

  it("a config file with an unbounded number, list or string is refused", () => {
    refuses({ logs: { keep: 2_000_000_000 } }, "/logs/keep");
    refuses({ core: { recall: { capChars: 1e15 } } }, "/core/recall/capChars");
    refuses({ session: { compaction: { summaryMaxTokens: 1e12 } } }, "/session/compaction/summaryMaxTokens");
    refuses({ memory: { mediaEmbedding: { dimensions: 1_000_000 } } }, "/memory/mediaEmbedding/dimensions");
    refuses({ auth: { openai: { federated: { command: "tool", args: Array.from({ length: 1000 }, () => "x") } } } }, "/auth/openai/federated/args");
    refuses({ agents: { bernd: { skills: { pinned: Array.from({ length: 5000 }, () => "s") } } } }, "/agents/bernd/skills/pinned");
    refuses({ modelRoles: { chat: "m".repeat(100_000) } }, "/modelRoles/chat");
  });

  it("generous but plausible values still load", () => {
    const p = file();
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, logs: { keep: 100, maxBytes: 1_073_741_824 }, core: { recall: { capChars: 500_000 } }, session: { compaction: { summaryMaxTokens: 200_000, maxMessageTokens: 200_000 } }, memory: { mediaEmbedding: { dimensions: 3072 } }, agents: { bernd: { skills: { pinned: ["a", "b"] } } } }));
    const { config } = loadConfig(p);
    assert.equal(config.logs.keep, 100);
    assert.equal(config.session.compaction.summaryMaxTokens, 200_000);
  });
});

describe("config validation gaps (KNOWN GAP)", () => {
  it.todo("KNOWN GAP: engine.baseDbPathOverride has no minLength/absolute-path constraint in the schema (engine-config.ts only ignores blank values)");
});

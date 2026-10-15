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

describe("config validation gaps (KNOWN GAP)", () => {
  it.todo("KNOWN GAP: core.recall.softBudgetMs above hardBudgetMs is accepted (needs the same cross-field rule in crates/plur1bus-config, else core and supervisor disagree)");
  it.todo("KNOWN GAP: numbers without maximum (logs.keep, core.recall.capChars, session.compaction.*Tokens, media dimensions) and arrays/strings without maxItems/maxLength (auth.openai.federated.args, skills.pinned) need schema bounds");
  it.todo("KNOWN GAP: engine.baseDbPathOverride has no minLength/absolute-path constraint in the schema (engine-config.ts only ignores blank values)");
});

import { defaults } from "@plur1bus/config-schema";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { connectRun } from "../../packages/core/test/helpers/connect.ts";
import { layout } from "../../packages/core/src/paths.ts";
import { BIN, home, startCore, stopCore, coreEnv } from "./helpers.ts";
import { ABSENT_EXPORTS, REDACTION_CHANNELS, MARKERS, files, forms, leaks, put, tarEntries, zipEntries } from "./redaction-fixture.ts";

const schema = JSON.parse(readFileSync(new URL("../../packages/rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
test("M2 C8: every export/backup/bundle/report RPC is classified", () => {
  const methods = Object.keys(schema.$defs.methods).filter(n => /export|backup|bundle|report/i.test(n));
  assert.deepEqual(Object.values(REDACTION_CHANNELS).flat().sort(), methods.sort());
  for (const n of ABSENT_EXPORTS) assert.equal(n in schema.$defs.methods, false, `${n} now exists: add it to the sweep`);
});
test("M2 C8: scanner catches every marker representation without disclosing its value", () => {
  for (const marker of MARKERS) for (const form of forms(marker)) {
    const result = leaks("control", "entry", form);
    assert.ok(result.length > 0); assert.ok(!result.join().includes(marker));
  }
});
test("M2 C8: one home, secrets, logs, RPC views, exports, backup, import reports and diagnostic bundle", { timeout: 120_000 }, async () => {
  const h = home(), source = home(), found: string[] = [], seen = new Set<string>();
  const env = coreEnv({ PLUR1BUS_SECRETS_KEYRING: "off", PLUR1BUS_IMPORT_JS: new URL("../../packages/core/dist/import.js", import.meta.url).pathname });
  const scan = (channel: string, path: string, data: string | Buffer) => { seen.add(channel); found.push(...leaks(channel, path, data)); };
  const run = (channel: string, args: string[], input?: string): any => {
    const r = spawnSync(BIN, ["--json", "--home", h, ...args], { encoding: "utf8", env, timeout: 30_000, input: input ?? "" });
    scan(channel, `${args[0]}.stdout`, r.stdout); scan(channel, `${args[0]}.stderr`, r.stderr);
    assert.equal(r.status, 0, `${channel}: command failed (exit ${r.status}, reason ${JSON.parse(r.stdout || "{}").reason ?? "unknown"}, detail ${MARKERS.flatMap(forms).reduce((s, v) => s.replaceAll(v, "[marker]"), r.stdout + r.stderr)})`);
    return JSON.parse(r.stdout);
  };
  put(join(h, "config.json"), JSON.stringify({ ...defaults(), schemaVersion: 1, secrets: { fileFallback: { enabled: true } }, providers: { fixture: { secret_ref: "provider.fixture" } }, channels: { telegram: { tokenSecret: "channel.fixture" } } }));
  // Metadata references only; secret values live in the vault. No real MCP server or channel is started.
  const oc = String.fromCharCode(111) + "penclaw";
  put(join(source, oc, `${oc}.json`), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" }, agents: { list: [{ id: "imported" }] }, models: { providers: { fixture: { apiKey: MARKERS[4] } } } }));
  put(join(source, oc, ".env"), `FIXTURE_KEY=${MARKERS[4]}\n`);
  put(join(source, "hermes", "config.yaml"), `_config_version: 45\nmodel:\n  provider: fixture\n  api_key: ${JSON.stringify(MARKERS[4])}\n`);
  put(join(source, "hermes", "auth.json"), JSON.stringify({ token: MARKERS[4] }));
  // Real importer entry, dry-run and persisted reports. Values in source credential stores are never migrated.
  for (const kind of [oc, "hermes"]) run("importReports", ["import", kind, "--source", join(source, kind), "--apply"]);
  for (const f of files(join(h, "imports"))) scan("importReports", relative(h, f), readFileSync(f));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore(h, env);
    for (const [i, name] of ["vault.fixture", "provider.fixture", "channel.fixture", "mcp.fixture", "import.fixture"].entries()) run("api", ["secret", "set", name], MARKERS[i]);
    for (const args of [["secret", "ls"], ["secret", "status"], ["secret", "get", "provider.fixture"], ["config", "get"], ["agent", "list"]]) run("api", args);
    run("api", ["agent", "create", "alpha"]);
  put(join(h, "agents", "alpha", "mcp.json"), JSON.stringify({ servers: { fixture: { env: { FIXTURE_KEY: { secret: "mcp.fixture" } } } } }));
    const exp = run("agentExport", ["agent", "export", "alpha"]);
    assert.ok(exp.bundle?.files.length > 0, "agent export must contain files");
    const backup = run("backup", ["backup", "create"]);
    const entries = tarEntries(backup.path); assert.ok(entries.length > 1);
    for (const [path, data] of entries) { scan("backup", path, data); assert.ok(!/state\/secrets|store\.key/.test(path), "vault and encryption key must be excluded from backup"); }
    const vault = JSON.parse(readFileSync(join(h, "state", "secrets", "store.json"), "utf8"));
    assert.ok(Object.values(vault.entries).every((e: any) => typeof e.ct === "string" && e.ct.length > 0), "vault must contain ciphertext");
    scan("backup", "encrypted vault (not archived)", JSON.stringify(vault));
    const client = await connectRun(layout(h), core.ready.address);
    try {
      try { scan("doctor", "doctor.report", JSON.stringify(await client.call("doctor.report", {}))); }
      catch (e: any) { assert.equal(e.reason, "firstaid-unavailable"); scan("doctor", "doctor.report refusal without supervisor", JSON.stringify(e)); }
    } finally { await client.close(); }
    const bundle = run("bundle", ["1staid", "bundle"]);
    const zipped = zipEntries(bundle.path); assert.ok(zipped.some(([p]) => p === "config.json"));
    for (const [path, data] of zipped) scan("bundle", path, data);
    scan("logs", "core.stderr", core.stderr());
    for (const f of files(join(h, "logs"))) scan("logs", relative(h, f), readFileSync(f));
    assert.ok(readFileSync(join(h, "logs", "audit.log")).length > 0);
    assert.deepEqual([...seen].sort(), Object.keys(REDACTION_CHANNELS).sort());
    assert.deepEqual(found, [], `redaction leaks: ${found.join("; ")}`);
  } finally { if (core) await stopCore(core); rmSync(h, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});

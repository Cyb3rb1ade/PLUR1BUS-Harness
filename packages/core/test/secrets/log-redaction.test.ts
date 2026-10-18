// A secret that is set, rotated or leased is masked in every log line and audit entry from then on (core log, discovery
// writer, exec output writer, policy audit, log queries). Wiring under test: the store's registry fans out to each sink.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createCoreLog } from "../../src/logs/bootstrap.ts";
import { createWriter } from "../../src/logs/writer.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { createCoreSecretStore } from "../../src/secrets/runtime.ts";
import { layout } from "../../src/paths.ts";
import { secure } from "./helpers.ts";

const VALUE = "wired-secret-value-4c1d9e7a";
const ROTATED = "wired-rotated-value-b82f03d6";
const EXTRA = "wired-other-process-value-6a55e1";
const owner = { kind: "owner" as const, id: "tester" }, core = { kind: "core" as const };
const env = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "memory" };
const logText = (dir: string): string => readdirSync(dir).filter(n => n.endsWith(".log") && n !== "audit.log").map(n => readFileSync(join(dir, n), "utf8")).join("\n");

function rig() {
  const home = tempDir("p1b-logred-"), l = layout(home);
  const store = createCoreSecretStore({ layout: l, securePath: secure, fileFallback: () => false, env });
  const log = createCoreLog({ dir: l.logs, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, timers: false });
  store.redaction.subscribe(v => log.registerSecret(v));
  return { home, l, store, log };
}

describe("secret values never reach a log line in clear", () => {
  it("a secret is set, a line carrying it is logged: the log holds only the redaction marker", async () => {
    const { l, store, log } = rig();
    await store.set(owner, "provider.key", VALUE);
    log.info(`provider rejected ${VALUE}`, { detail: `Bearer-less echo ${VALUE}`, nested: { text: VALUE } });
    log.error("failed", { err: new Error(`upstream said ${VALUE}`) });
    await log.close();
    const text = logText(l.logs);
    assert.ok(!text.includes(VALUE), "clear value in core.log");
    assert.ok(text.includes("[REDACTED:secret]"), "marker present");
    assert.ok(!text.includes(Buffer.from(VALUE).toString("base64")));
  });

  it("a rotated value is masked, and the retired one stays masked", async () => {
    const { l, store, log } = rig();
    await store.set(owner, "provider.key", VALUE);
    await store.set(owner, "provider.key", ROTATED);
    log.warn(`old ${VALUE} new ${ROTATED}`);
    await log.close();
    const text = logText(l.logs);
    assert.ok(!text.includes(VALUE) && !text.includes(ROTATED));
  });

  it("a value that exists only in the store (set by an earlier process) is masked once it is leased or revealed", async () => {
    const { l, store, log } = rig();
    await store.set(owner, "a", EXTRA);
    // a later start: a fresh store over the same state registers nothing until a value is read
    const fresh = createCoreSecretStore({ layout: l, securePath: secure, fileFallback: () => true, env: { ...env, PLUR1BUS_SECRETS_KEYRING: "off" } });
    const freshLog = createCoreLog({ dir: l.logs, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, timers: false });
    fresh.redaction.subscribe(v => freshLog.registerSecret(v));
    await fresh.set(owner, "b", ROTATED);
    const lease = await fresh.lease(core, "b", { purpose: "embedding", profileId: "p" });
    freshLog.info(`leased ${lease.value}`);
    freshLog.info(`revealed ${(await fresh.reveal(owner, "b")).value}`);
    await freshLog.close(); await log.close();
    assert.ok(!logText(l.logs).includes(ROTATED));
  });

  it("every sink that subscribes late still receives the values registered before it (discovery and exec writers)", async () => {
    const { l, store, log } = rig();
    await store.set(owner, "k", VALUE);
    const discovery = createWriter({ dir: l.logs, role: "disc", source: { kind: "harness", id: "discovery", version: "0.1.0" }, timers: false });
    store.redaction.subscribe(v => discovery.registerSecret(v));
    discovery.writeLegacy("warn", `discovery failed ${VALUE}`, { detail: VALUE });
    discovery.close(); await log.close();
    assert.ok(!logText(l.logs).includes(VALUE));
  });

  it("the policy audit and a live redactor mask values registered after they were created", async () => {
    const registry = createSecretRedaction();
    const sink = memoryAuditSink();
    const audit = createPolicyAudit({ sink, clock: { now: () => 1 }, host: "h", redactor: registry.redactor() });
    const live = registry.redactor();
    audit.record("policy.decision", { tool: "t", outcome: "allowed", reason: `before ${VALUE}` });
    registry.register(VALUE);
    audit.record("policy.decision", { tool: "t", outcome: "allowed", reason: `after ${VALUE}` });
    assert.ok(JSON.stringify(sink.events[0]).includes(VALUE), "an unregistered value is not known to anyone");
    assert.ok(!JSON.stringify(sink.events[1]).includes(VALUE));
    assert.equal(live.text(`x ${VALUE}`), "x [REDACTED:secret]");
    assert.deepEqual(live.value({ a: [VALUE] }), { a: ["[REDACTED:secret]"] });
  });

  it("an authorization header value registers both the header and the bare credential; short values are ignored", () => {
    const registry = createSecretRedaction(); const seen: string[] = [];
    registry.subscribe(v => seen.push(v));
    registry.register(`Bearer ${VALUE}`); registry.register("short"); registry.register(VALUE);
    assert.deepEqual(seen, [`Bearer ${VALUE}`, VALUE]);
  });
});

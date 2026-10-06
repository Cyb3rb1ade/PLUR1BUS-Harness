// ADR-005 action 8 / M2 acceptance 8: a known marker value must appear in no log, no JSON document and no error.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileAuditSink } from "../../src/secrets/audit.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import type { SecretPrincipal } from "../../src/secrets/types.ts";
import { MARKER, fakeClock, fakeKeyring, secure } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };

function files(dir: string): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; }); }
function show(e: unknown): string { return e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}\n${JSON.stringify({ ...e })}` : String(e); }

describe("redaction", () => {
  it("the marker value is in no log line, audit line, status, listing, error or file on disk (file backend)", async () => {
    const home = tempDir("p1b-red-");
    const seen: string[] = []; // everything a caller, a log or an error could observe
    const logger = { debug: (m: string, f?: object) => seen.push(m + JSON.stringify(f)), info: (m: string, f?: object) => seen.push(m + JSON.stringify(f)), warn: (m: string, f?: object) => seen.push(m + JSON.stringify(f)) };
    const kr = fakeKeyring(); kr.down = true;
    const store = createSecretStore({
      keyring: createKeyringBackend({ service: "s", load: async () => kr }), file: createFileBackend({ dir: join(home, "state", "secrets"), secure }),
      fileFallback: () => true, audit: createFileAuditSink({ file: join(home, "logs", "audit.log"), secure }), clock: fakeClock(), logger,
    });
    const note = (x: unknown) => seen.push(JSON.stringify(x));
    const attempt = async (f: () => unknown) => { try { note(await f()); } catch (e) { seen.push(show(e)); } };

    await attempt(() => store.set(owner, "api.key", MARKER));
    await attempt(() => store.status(owner)); await attempt(() => store.list(owner)); await attempt(() => store.meta(owner, "api.key"));
    const lease = await store.lease(core, "api.key", { purpose: "embedding", profileId: "p" });
    await attempt(() => store.activeLeases(owner));
    store.revokeLease(owner, lease.leaseId);
    // every failure path, with the marker as the offending value
    await attempt(() => store.set(owner, "api.key", `${MARKER}\u0000`));
    await attempt(() => store.set(owner, "api.key", MARKER.repeat(8000)));
    await attempt(() => store.set(owner, MARKER + " bad name", MARKER));
    await attempt(() => store.set({ kind: "agent", agentId: "a" }, "api.key", MARKER));
    await attempt(() => store.reveal({ kind: "agent" }, "api.key"));
    await attempt(() => store.lease(core, "missing", { purpose: "a", profileId: "b" }));
    await attempt(() => store.lease(core, "api.key", { purpose: MARKER.slice(0, 20) + " x", profileId: "b" }));

    const joined = seen.join("\n");
    assert.ok(!joined.includes(MARKER), "marker leaked into an observable output");
    for (const f of files(home)) assert.ok(!readFileSync(f).includes(MARKER), `marker leaked into ${f}`);
    // sanity: the value is retrievable by the one call that may return it
    assert.equal((await store.reveal(owner, "api.key")).value, MARKER);
  });

  it("a keyring that echoes the value in its own error does not leak it through ours", async () => {
    const kr = fakeKeyring();
    const Base = kr.Entry;
    class Echo extends Base { override setPassword(p: string): void { if (!this.user.startsWith("__")) throw Object.assign(new Error(`cannot store ${p}`), { code: "EACCES" }); super.setPassword(p); } }
    const store = createSecretStore({
      keyring: createKeyringBackend({ service: "s", load: async () => ({ Entry: Echo }) }), file: createFileBackend({ dir: join(tempDir("p1b-red-"), "s"), secure }),
      fileFallback: () => false, audit: { record() {} },
    });
    await assert.rejects(() => store.set(owner, "k", MARKER), (e) => { assert.ok(!show(e).includes(MARKER)); assert.match((e as Error).message, /EACCES/); return true; });
  });
});

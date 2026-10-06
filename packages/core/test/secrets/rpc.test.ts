import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect, RpcCallError, type CoreClient } from "@plur1bus/module-api";
import { layout } from "../../src/paths.ts";
import { createLogger } from "../../src/logger.ts";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.ts";
import { buildSecretMethods, createCoreSecretStore, keyringLoaderFor, type SecretStore } from "../../src/secrets/index.ts";
import type { SecretPrincipal } from "../../src/secrets/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { MARKER, secure } from "./helpers.ts";

const TOKEN = "s".repeat(64);
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); const st = statSync(p); return st.isDirectory() ? files(p) : st.isFile() ? [p] : []; });
const failsWith = (error: string, reason?: string) => (e: unknown) => { assert.ok(e instanceof RpcCallError, String(e)); assert.equal(e.error, error); if (reason) assert.equal(e.reason, reason); assert.ok(!JSON.stringify({ ...e, m: e.message }).includes(MARKER)); return true; };

describe("secret.* over RPC", () => {
  let home: string; let server: RpcServer; let client: CoreClient; let store: SecretStore;
  let fallback = true; let who: SecretPrincipal = { kind: "owner" };

  before(async () => {
    home = tempDir("p1b-secrpc-");
    const l = layout(home);
    const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-secrpc-${process.pid}` : join(home, "core.sock");
    const log = createLogger({ file: l.logFile("core"), level: "debug", role: "core" });
    // The keyring is switched off by the seam: the encrypted file serves, and no real keychain can be reached.
    store = createCoreSecretStore({ layout: l, securePath: secure, fileFallback: () => fallback, env: { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "off" } });
    server = createRpcServer({ address, token: TOKEN, hello: () => ({ contract: "1.0.0", rpc: "1.5.0", instanceId: "i", pid: process.pid }), methods: buildSecretMethods({ store, principalOf: () => who }), logger: log });
    await server.listen();
    client = await connect({ address, token: TOKEN });
  });
  after(async () => { await client?.close(); await server?.close(); });

  it("owner: set, list, get (metadata only), get --reveal, delete", async () => {
    who = { kind: "owner" }; fallback = true;
    const st = await client.call<any>("secret.status", {});
    assert.deepEqual([st.backend, st.degraded, st.keyring.available, st.file.enabled], ["file", true, false, true]);
    const meta = await client.call<any>("secret.set", { name: "openai.key", value: MARKER });
    assert.deepEqual(Object.keys(meta).sort(), ["backend", "createdAt", "name", "updatedAt"]);
    assert.ok(!JSON.stringify(meta).includes(MARKER));
    assert.deepEqual((await client.call<any>("secret.list", {})).secrets.map((s: any) => s.name), ["openai.key"]);
    const plain = await client.call<any>("secret.get", { name: "openai.key" });
    assert.equal("value" in plain, false); assert.ok(!JSON.stringify(plain).includes(MARKER));
    assert.equal((await client.call<any>("secret.get", { name: "openai.key", reveal: false })).value, undefined);
    assert.equal((await client.call<any>("secret.get", { name: "openai.key", reveal: true })).value, MARKER);
    assert.deepEqual(await client.call("secret.delete", { name: "openai.key" }), { removed: true });
    await assert.rejects(() => client.call("secret.get", { name: "openai.key" }), failsWith("E_NOT_FOUND"));
    await assert.rejects(() => client.call("secret.delete", { name: "openai.key" }), failsWith("E_NOT_FOUND"));
  });

  it("an agent principal is refused every secret.* method with E_DENIED, and nothing changes", async () => {
    who = { kind: "owner" };
    await client.call("secret.set", { name: "kept", value: MARKER });
    for (const bad of [{ kind: "agent", agentId: "a1" }, { kind: "agent" }, { kind: "root" }, undefined] as SecretPrincipal[]) {
      who = bad;
      const calls: [string, object][] = [["secret.status", {}], ["secret.list", {}], ["secret.set", { name: "kept", value: "x" }], ["secret.get", { name: "kept" }], ["secret.get", { name: "kept", reveal: true }], ["secret.delete", { name: "kept" }]];
      for (const [m, p] of calls) await assert.rejects(() => client.call(m, p), failsWith("E_DENIED", "denied"), m);
    }
    who = { kind: "owner" };
    assert.equal((await client.call<any>("secret.get", { name: "kept", reveal: true })).value, MARKER);
    const audit = readFileSync(layout(home).logFile("audit"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.ok(audit.some((a) => a.action === "secret.denied" && a.actor.user.startsWith("agent:")));
  });

  it("validates params without echoing a value", async () => {
    who = { kind: "owner" };
    await assert.rejects(() => client.call("secret.set", { name: "bad name", value: MARKER }), failsWith("E_INVALID_PARAMS"));
    await assert.rejects(() => client.call("secret.set", { name: "ok", value: MARKER, [MARKER]: 1 }), failsWith("E_INVALID_PARAMS"));
    await assert.rejects(() => client.call("secret.set", { name: "ok", value: "" }), failsWith("E_INVALID_PARAMS"));
    await assert.rejects(() => client.call("secret.set", { name: "ok", value: `a\u0000${MARKER}` }), failsWith("E_INVALID_PARAMS", "invalid-value"));
    await assert.rejects(() => client.call("secret.get", { name: "kept", reveal: "yes" }), failsWith("E_INVALID_PARAMS"));
  });

  it("with no usable backend, answers E_NOT_AVAILABLE with the remedy", async () => {
    who = { kind: "owner" }; fallback = false;
    await assert.rejects(() => client.call("secret.set", { name: "x", value: MARKER }), (e) => { failsWith("E_NOT_AVAILABLE", "no-backend")(e); assert.match((e as Error).message, /secrets\.fileFallback\.enabled/); return true; });
    const st = await client.call<any>("secret.status", {});
    assert.equal(st.backend, "none"); assert.equal(st.count, null); assert.match(st.remedy, /fileFallback/);
    fallback = true;
  });

  it("the marker is in no log, audit line or file of the home", async () => {
    for (const f of files(home)) assert.ok(!readFileSync(f).includes(MARKER), `marker leaked into ${f}`);
  });
});

describe("keyring test seam", () => {
  it("is absent by default, refuses to work without the test-internals gate, and rejects unknown modes", () => {
    assert.equal(keyringLoaderFor({}), undefined);
    assert.throws(() => keyringLoaderFor({ PLUR1BUS_SECRETS_KEYRING: "memory" }), /ALLOW_TEST_INTERNALS/);
    assert.throws(() => keyringLoaderFor({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "real" }), /unknown/);
    assert.equal(typeof keyringLoaderFor({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "off" }), "function");
  });
  it("memory mode serves a full round trip without a keychain", async () => {
    const load = keyringLoaderFor({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "memory" })!;
    const m = await load(); const e = new m.Entry("s", "u"); e.setPassword("v"); assert.equal(new m.Entry("s", "u").getPassword(), "v");
  });
});

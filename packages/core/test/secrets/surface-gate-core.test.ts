// The same gate inside a real core (needs the engine, like every core-level test): the token-authenticated local connection
// is T1 and is where `plur1bus secret get --reveal` arrives, so it keeps working; an agent or non-owner principal does not.
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { CoreClient } from "@plur1bus/module-api";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import type { ConnectionAttestation } from "../../src/rbac/connection-surface.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { MARKER } from "./helpers.ts";

describe("secret.* surface gate (real core)", () => {
  let home: string; let core: Core; let client: CoreClient;
  let who: Principal | null | undefined; let attestation: ConnectionAttestation | undefined;
  const saved = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  before(async () => {
    process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
    home = tempDir("p1b-secsurf-");
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, duplicateThreshold: 1.01, runtime: { recallTimeoutMs: 10000 } };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    // `who` undefined = the default resolver (the token-authenticated local owner, R8).
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: (...a) => who === undefined ? { userId: "local-owner", role: "owner", kind: "person" } : who, attest: () => attestation } });
    await core.start();
    client = await connect({ address: core.address, token: core.token });
  });
  after(async () => {
    await client?.close(); await core?.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true });
    for (const [key, value] of [["PLUR1BUS_ALLOW_TEST_INTERNALS", saved.allow], ["PLUR1BUS_SECRETS_KEYRING", saved.keyring]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const audit = () => readFileSync(join(layout(home).logs, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("the local owner connection (T1, the CLI path): set, get --reveal and delete work", async () => {
    who = undefined; attestation = undefined;
    await client.call("secret.set", { name: "cli.key", value: MARKER });
    assert.equal((await client.call<any>("secret.get", { name: "cli.key", reveal: true })).value, MARKER);
    assert.deepEqual(await client.call("secret.delete", { name: "cli.key" }), { removed: true });
  });

  it("an attested owner connection (T3) keeps working too", async () => {
    who = undefined; attestation = { kind: "desktop-app" };
    await client.call("secret.set", { name: "app.key", value: MARKER });
    assert.equal((await client.call<any>("secret.get", { name: "app.key", reveal: true })).value, MARKER);
    assert.deepEqual(await client.call("secret.delete", { name: "app.key" }), { removed: true });
    attestation = undefined;
  });

  it("a connection whose principal is an agent, a non-owner or nobody is refused every write and the reveal", async () => {
    who = undefined;
    await client.call("secret.set", { name: "held.key", value: MARKER });
    for (const bad of [{ userId: "a1", role: "owner", kind: "agent" }, { userId: "m1", role: "member", kind: "person" }, { userId: "o2", role: "owner" }, null] as (Principal | null)[]) {
      who = bad;
      await assert.rejects(() => client.call("secret.get", { name: "held.key", reveal: true }), (e: any) => { assert.ok(["E_DENIED", "E_UNAUTHORIZED"].includes(e.error), e.error); assert.ok(!e.message.includes(MARKER)); return true; });
      await assert.rejects(() => client.call("secret.set", { name: "held.key", value: `${MARKER}-x` }), (e: any) => ["E_DENIED", "E_UNAUTHORIZED"].includes(e.error));
      await assert.rejects(() => client.call("secret.delete", { name: "held.key" }), (e: any) => ["E_DENIED", "E_UNAUTHORIZED"].includes(e.error));
    }
    who = undefined;
    assert.equal((await client.call<any>("secret.get", { name: "held.key", reveal: true })).value, MARKER, "nothing changed");
    assert.ok(audit().some((l) => l.action === "secret.reveal"), "the owner's own reveal is audited");
  });
});

/** E2: the actual Core mounts SSH key/setup methods and derives person authority per request. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { SshKeyStatus } from "../../src/import/ssh-service.ts";

it("registers real SSH key handlers and denies Admin/PAT ownership despite import management authority", { timeout: 60_000 }, async () => {
  const home = tempDir("p1b-E2-core-");
  const config = defaults(); config.agents.a = {};
  config.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  const previous = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  let who: Principal = { userId: "local-owner", kind: "person", role: "owner" };
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false },
    rbac: { resolve: () => who }, composition: {
      providers: { profiles: { default: [{ provider: "fixture", model: "fixture", adapter: { async *stream() {} } }] } },
      createTurnProvider: () => ({ id: "fixture", telemetry: {}, async *stream() {} }) as never,
    } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start(); client = await connect({ address: core.address, token: core.token });
    assert.deepEqual(await client.call("admin.import.ssh.key.status", {}), { configured: false });
    const key = await client.call<SshKeyStatus>("admin.import.ssh.key.generate", {});
    assert.equal(key.configured, true); assert.match(key.publicKey!, /^ssh-ed25519 /);
    assert.deepEqual(await client.call("admin.import.ssh.key.status", {}), key);
    assert.deepEqual(await client.call("admin.import.ssh.connections.list", {}), { connections: [] });
    await assert.rejects(client.call("admin.import.ssh.connections.set", { connection: {
      id: "source", host: "source.example", user: "reader", roots: ["/source"],
    } }), { error: "E_NOT_AVAILABLE", reason: "ssh-supervisor-required" });
    who = { userId: "admin", kind: "person", role: "admin" };
    await client.call("admin.import.ssh.connections.list", {});
    for (const method of ["key.status", "key.generate", "key.rotate", "key.delete"]) {
      await assert.rejects(client.call(`admin.import.ssh.${method}`, {}), { error: "E_DENIED" });
    }
    who = { userId: "local-owner", kind: "agent", role: "owner", tokenScopes: ["imports.*"] };
    await assert.rejects(client.call("admin.import.ssh.connections.list", {}), { error: "E_DENIED" });
    await assert.rejects(client.call("admin.import.ssh.key.rotate", {}), { error: "E_DENIED" });
    who = { userId: "local-owner", kind: "person", role: "owner", tokenScopes: ["imports.read"] };
    await client.call("admin.import.ssh.key.status", {});
    await assert.rejects(client.call("admin.import.ssh.key.rotate", {}), { error: "E_DENIED" });
    who = { userId: "local-owner", kind: "person", role: "owner" };
    const next = await client.call<SshKeyStatus>("admin.import.ssh.key.rotate", {});
    assert.notEqual(next.publicKey, key.publicKey);
    assert.deepEqual(await client.call("admin.import.ssh.key.delete", {}), { deleted: true });
  } finally {
    await client?.close(); await core.stop({ budgetMs: 5000 });
    if (previous.internals === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = previous.internals;
    if (previous.keyring === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING;
    else process.env.PLUR1BUS_SECRETS_KEYRING = previous.keyring;
  }
  for (const file of await readdir(join(home, "logs"))) if (/\.(log|jsonl)$/.test(file)) {
    assert.ok(!(await readFile(join(home, "logs", file), "utf8")).includes("BEGIN PRIVATE KEY"));
  }
});

it("actual Core SSH probing obeys live central host and TCP-port configuration before opening a worker", { timeout: 60_000 }, async () => {
  const home = tempDir("p1b-E3-policy-");
  const config = defaults();
  config.import = { ssh: { connections: { source: { host: "127.0.0.1", port: 2222, user: "fixture",
    roots: ["/"], allowPrivate: true } } } };
  config.egress.allowHosts = [];
  config.egress.allowPorts = [443];
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  const prior = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS,
    bin: process.env.PLUR1BUS_NATIVE_BIN, hash: process.env.PLUR1BUS_NATIVE_SHA256 };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  delete process.env.PLUR1BUS_NATIVE_BIN;
  delete process.env.PLUR1BUS_NATIVE_SHA256;
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    await assert.rejects(client.call("admin.import.ssh.hostKey.probe", { id: "source" }),
      { error: "E_DENIED", reason: "ssh-egress-denied" });
    config.egress.allowHosts = ["127.0.0.1"];
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    await assert.rejects(client.call("admin.import.ssh.hostKey.probe", { id: "source" }),
      { error: "E_DENIED", reason: "ssh-egress-denied" });
    config.egress.allowPorts = [2222];
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    await assert.rejects(client.call("admin.import.ssh.hostKey.probe", { id: "source" }),
      { error: "E_NOT_AVAILABLE", reason: "ssh-worker-unavailable" });
  } finally {
    await client?.close();
    await core.stop({ budgetMs: 5000 });
    for (const [name, value] of [["PLUR1BUS_ALLOW_TEST_INTERNALS", prior.internals],
      ["PLUR1BUS_NATIVE_BIN", prior.bin], ["PLUR1BUS_NATIVE_SHA256", prior.hash]]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
  }
});

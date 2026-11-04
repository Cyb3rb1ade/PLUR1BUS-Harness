import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createIsolatedBackend, isolatedBackendHelper } from "../../src/secrets/isolated-backend.ts";
import { createCoreSecretStore } from "../../src/secrets/runtime.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { layout } from "../../src/paths.ts";
import { secure } from "./helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("the source helper performs encrypted-file operations through the production private channel", async () => {
  const io = createIsolatedBackend({ kind: "file", dir: join(tempDir("p1b-isolated-file-"), "secrets") });
  const b = io.backend, value = randomUUID(), at = new Date("2026-11-01T12:00:00Z");
  try {
    assert.equal((await b.probe()).available, true);
    await b.put("item", value, at, "owner", "private API credential");
    assert.equal(await b.get("item"), value);
    assert.equal((await b.describe("item", "rotated metadata", at)).description, "rotated metadata");
    assert.equal((await b.list())[0]?.name, "item");
    assert.equal(await b.delete("item", at), true);
    assert.equal((await b.tombstones!()).item, at.toISOString());
    await b.clearTombstone!("item");
    assert.deepEqual(await b.tombstones!(), {});
  } finally { await io.close(); }
});

test("isolated keyring registration callbacks survive an error and failed index writes roll back", async () => {
  const io = createIsolatedBackend({ kind: "keyring", service: "plur1bus:isolated-test" }, { spawn() {
    return fork(fileURLToPath(new URL("./fixtures/isolated-memory-keyring.ts", import.meta.url)), [], {
      execArgv: ["--experimental-strip-types", "--conditions=source"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
  } });
  const b = io.backend, first = randomUUID(), replacement = randomUUID(), registrations: string[] = [];
  try {
    await b.put("item", first, new Date());
    await assert.rejects(b.put("item", replacement, new Date(), undefined, first, value => registrations.push(value)),
      error => (error as { code?: string }).code === "invalid-description" && !(error as Error).message.includes(first));
    assert.deepEqual(registrations, [first]);
    assert.equal(await b.get("item"), first);
    await assert.rejects(b.put("rollback", replacement, new Date()), error => (error as { code?: string }).code === "storage");
    assert.equal(await b.get("rollback"), null);
    assert.deepEqual((await b.list()).map(meta => meta.name), ["item"]);
  } finally { await io.close(); }
});

test("source and built helper locations stay beside their corresponding entrypoints", () => {
  assert.equal(isolatedBackendHelper("file:///installation/src/secrets/isolated-backend.ts").href,
    "file:///installation/src/secrets-isolated-bin.ts");
  assert.equal(isolatedBackendHelper("file:///installation/core.js").href,
    "file:///installation/secrets-isolated-bin.js");
});

test("a killed native helper recovers through a fresh preload and keeps every recovery snapshot pinned", async () => {
  const l = layout(tempDir("p1b-isolated-recovery-")), first = randomUUID(), second = randomUUID();
  const file = createFileBackend({ dir: l.secrets, secure });
  await file.put("item", first, new Date());
  let firstKeyring = true;
  let blockingNativeCallEntered = false;
  const store = createCoreSecretStore({ layout: l, securePath: secure, fileFallback: () => true, env: {},
    isolation: { budgetMs: 1500, retryAfterMs: 0, spawn(description) {
      const hang = description.kind === "keyring" && firstKeyring;
      if (description.kind === "keyring") firstKeyring = false;
      const child = fork(fileURLToPath(new URL(hang ? "./fixtures/isolated-keyring.ts" : "./fixtures/isolated-memory-keyring.ts", import.meta.url)), [], {
        execArgv: ["--experimental-strip-types", "--conditions=source"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      });
      if (hang) child.on("message", message => {
        if ((message as { entered?: unknown } | null)?.entered === true) blockingNativeCallEntered = true;
      });
      return child;
    } } });
  try {
    await store.preloadRedaction();
    assert.equal(store.startupStatus().state, "unavailable");
    assert.ok(blockingNativeCallEntered, "the unavailable helper reached its synchronously blocking native call");
    assert.equal(store.redaction.contains(first), false);
    await store.preloadRedaction();
    const recovered = store.startupStatus();
    assert.equal(recovered.state, "ready", JSON.stringify(recovered));
    assert.ok(store.redaction.contains(first), "recovery became available before registering its file snapshot");
    await file.put("item", second, new Date());
    store.backendUnavailable();
    await store.preloadRedaction();
    assert.equal((await store.reveal({ kind: "owner" }, "item")).value, second);
    for (let i = 0; i < 300; i++) store.redaction.register(randomUUID());
    assert.ok(store.redaction.contains(first));
    assert.ok(store.redaction.contains(second));
  } finally { await store.close(); }
});

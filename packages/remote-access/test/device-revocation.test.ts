// Revocation edges that the store tests do not reach yet: a challenge issued before the revoke, a failed durable write
// followed by a restart, and a rename that must not undo a revocation. The clock is a plain variable, no timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { DeviceStore, DeviceError } from "../src/device-store.ts";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const device = { name: "Phone", platform: "ios", publicKey, pairedBy: "alice", scope: [] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "device-revocation-"));
  const file = join(dir, "devices.json");
  const clock = { now: 1000 };
  const failure = { armed: false };
  const options = {
    file,
    clock: () => clock.now,
    audit: { append: () => {} },
    // Simulates a private-file ACL refusal on the next persist; the existing store tests use the same seam.
    securePath: () => { if (failure.armed) throw new Error("ACL refused"); },
  };
  return { file, options, failure, store: new DeviceStore(options), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const handshake = (store: DeviceStore, challenge: Buffer) => ({
  publicKey,
  challenge,
  signature: sign(null, challenge, keys.privateKey),
  close: () => {},
});

test("a challenge issued before the revoke cannot be redeemed after it", t => {
  const f = fixture(); t.after(f.clean);
  const d = f.store.recordPairing(device);
  const early = f.store.challenge();
  f.store.revoke(d.id, "alice");
  assert.throws(() => f.store.connect(handshake(f.store, early)), (e: unknown) => e instanceof DeviceError && e.code === "denied");
});

test("a rename after the revoke keeps the device revoked, in memory and after a restart", t => {
  const f = fixture(); t.after(f.clean);
  const d = f.store.recordPairing(device);
  f.store.revoke(d.id, "alice");
  f.store.rename(d.id, "Old phone", "alice");
  assert.equal(f.store.get(d.id).revoked, true);
  const restarted = new DeviceStore(f.options);
  assert.equal(restarted.get(d.id).name, "Old phone");
  assert.equal(restarted.get(d.id).revoked, true);
});

test("revoking or renaming an unknown device is refused as not-found", t => {
  const f = fixture(); t.after(f.clean);
  for (const call of [() => f.store.revoke("dev_missing", "alice"), () => f.store.rename("dev_missing", "x", "alice")]) {
    assert.throws(call, (e: unknown) => e instanceof DeviceError && e.code === "not-found");
  }
});

test("a failed durable revoke write leaves memory and disk consistent after a restart", t => {
  const f = fixture(); t.after(f.clean);
  const d = f.store.recordPairing(device);
  const before = readFileSync(f.file, "utf8");
  f.failure.armed = true;
  assert.throws(() => f.store.revoke(d.id, "alice"), (e: unknown) => e instanceof DeviceError && e.code === "storage");
  assert.equal(f.store.get(d.id).revoked, false);
  assert.deepEqual(f.store.get(d.id), d);
  assert.equal(readFileSync(f.file, "utf8"), before);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).devices, [d]);
  f.failure.armed = false;
  const restarted = new DeviceStore(f.options);
  assert.equal(restarted.get(d.id).revoked, false);
  assert.deepEqual(restarted.get(d.id), f.store.get(d.id));
  for (const store of [f.store, restarted]) {
    const challenge = store.challenge();
    assert.doesNotThrow(() => store.connect(handshake(store, challenge))());
  }
});

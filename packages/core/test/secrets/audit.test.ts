import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileAuditSink, sanitizeDetail } from "../../src/secrets/audit.ts";
import { SecretError } from "../../src/secrets/types.ts";
import { createAuditChain, ANCHOR_NAME, ACTIVE_NAME } from "../../src/audit/chain.ts";
import { MARKER, secure } from "./helpers.ts";

describe("secret audit", () => {
  it("appends crates/plur1bus/src/audit.rs-shaped lines, private, one per event", () => {
    const file = join(tempDir("p1b-aud-"), "logs", "audit.log");
    const sink = createFileAuditSink({ file, secure, clock: () => 1234 });
    sink.record({ action: "secret.set", target: "k", principal: { kind: "owner", id: "me" }, detail: { backend: "file" } });
    sink.record({ action: "secret.lease", target: "k", principal: { kind: "core" }, detail: { purpose: "embedding", profileId: "p", ttlMs: 500 } });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["action", "actor", "at", "detail", "target"]);
    assert.deepEqual([lines[0].at, lines[0].action, lines[0].target, lines[0].actor.user, lines[0].detail], [1234, "secret.set", "k", "me", { backend: "file" }]);
    assert.equal(lines[1].actor.user, "core");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  });
  it("tees the same sanitized record into the chain, including a null list target", () => {
    const dir = join(tempDir("p1b-aud-chain-"), "logs");
    const sink = createFileAuditSink({ file: join(dir, "audit.log"), secure, clock: () => 1234 });
    sink.record({ action: "secret.list", target: null, principal: { kind: "owner", id: "me" }, detail: { count: 2, value: MARKER } as never });
    const chain = createAuditChain({ dir });
    assert.deepEqual([chain.verify().ok, chain.verify().records], [true, 1]);
    const rec = JSON.parse(readFileSync(join(dir, ACTIVE_NAME), "utf8")).rec;
    assert.deepEqual(rec, JSON.parse(readFileSync(join(dir, "audit.log"), "utf8")));
    assert.equal(JSON.stringify(rec).includes(MARKER), false);
    unlinkSync(join(dir, ANCHOR_NAME));
    assert.throws(() => sink.record({ action: "secret.reveal", target: "key", principal: { kind: "owner" } }), (e) => e instanceof SecretError && e.code === "audit-unavailable");
    assert.equal(chain.verify().records, 1);
  });
  it("redacts reason and purpose the same way in the legacy audit.log and in the chain, and the chain still verifies", () => {
    const dir = join(tempDir("p1b-aud-red-"), "logs");
    const file = join(dir, "audit.log");
    const sink = createFileAuditSink({ file, secure, clock: () => 1234 });
    const held = `${MARKER}-held`;
    sink.registerSecret(held);
    // A token-shaped canary is assembled at run time so no token-like literal sits in the source.
    const shaped = ["ghp", "_", "a1B2".repeat(10)].join("");
    sink.record({ action: "secret.lease", target: "k", principal: { kind: "core" }, detail: { purpose: `embed ${held}`, reason: `provider said ${shaped}`, backend: "file" } });
    sink.record({ action: "secret.set", target: "k", principal: { kind: "owner", id: "me" }, detail: { reason: `Bearer ${"Zz9".repeat(8)}` } });
    const legacy = readFileSync(file, "utf8");
    const chainText = readFileSync(join(dir, ACTIVE_NAME), "utf8");
    for (const text of [legacy, chainText]) {
      assert.equal(text.includes(held), false);
      assert.equal(text.includes(shaped), false);
      assert.equal(text.includes("Zz9Zz9"), false);
    }
    const recs = chainText.trim().split("\n").map((l) => JSON.parse(l).rec);
    assert.deepEqual(legacy.trim().split("\n").map((l) => JSON.parse(l)), recs, "the legacy copy is the chain's record, byte for byte");
    assert.equal(recs[0].detail.backend, "file");
    assert.match(recs[0].detail.purpose, /^embed \[REDACTED:secret\]$/);
    assert.match(recs[0].detail.reason, /\[REDACTED:pattern\]/);
    assert.deepEqual([createAuditChain({ dir }).verify().ok, createAuditChain({ dir }).verify().records], [true, 2]);
  });
  it("redacts a token-shaped reason even when no secret value was registered", () => {
    const dir = join(tempDir("p1b-aud-red2-"), "logs");
    const sink = createFileAuditSink({ file: join(dir, "audit.log"), secure, clock: () => 1 });
    const shaped = ["sk", "-", "proj", "-", "Qw3rTy".repeat(5)].join("");
    sink.record({ action: "secret.denied", target: null, principal: { kind: "core" }, detail: { reason: `bad key ${shaped}` } });
    assert.equal(readFileSync(join(dir, "audit.log"), "utf8").includes(shaped), false);
    assert.equal(readFileSync(join(dir, ACTIVE_NAME), "utf8").includes(shaped), false);
  });
  it("leaves ordinary details byte-identical and keeps the line shape", () => {
    const dir = join(tempDir("p1b-aud-plain-"), "logs");
    const sink = createFileAuditSink({ file: join(dir, "audit.log"), secure, clock: () => 7 });
    const detail = { backend: "keyring", purpose: "embedding", profileId: "profile-1", leaseId: "lease-7", ttlMs: 500, reason: "owner requested rotation", count: 3, method: "secret.get" };
    sink.record({ action: "secret.lease", target: "provider.key", principal: { kind: "owner", id: "me" }, detail });
    const rec = JSON.parse(readFileSync(join(dir, "audit.log"), "utf8"));
    assert.deepEqual(rec.detail, detail);
    assert.equal(readFileSync(join(dir, "audit.log"), "utf8"), `${JSON.stringify(rec)}\n`);
    assert.equal(createAuditChain({ dir }).verify().ok, true);
  });
  it("drops any detail key it does not know, and non-primitive values", () => {
    const d = sanitizeDetail({ backend: "file", value: MARKER, secret: MARKER, purpose: { nested: MARKER } } as never);
    assert.deepEqual(d, { backend: "file" });
  });
  it("throws audit-unavailable when the line cannot be written, naming no path", (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs a non-root POSIX user to make a file unwritable");
    const file = join(tempDir("p1b-aud-"), "audit.log");
    const sink = createFileAuditSink({ file, secure });
    sink.record({ action: "secret.list", target: null, principal: { kind: "owner" } });
    chmodSync(file, 0o400);
    assert.throws(() => sink.record({ action: "secret.list", target: null, principal: { kind: "owner" } }), (e) => e instanceof SecretError && e.code === "audit-unavailable" && !e.message.includes(file));
    assert.ok(existsSync(file));
  });
  it("throws audit-unavailable when the directory cannot be created", () => {
    const base = tempDir("p1b-aud-"); const file = join(base, "f", "audit.log");
    // `f` is a file, so `f/audit.log` can never be created
    createFileAuditSink({ file: join(base, "f"), secure }).record({ action: "secret.list", target: null, principal: { kind: "owner" } });
    assert.throws(() => createFileAuditSink({ file, secure }).record({ action: "secret.list", target: null, principal: { kind: "owner" } }), (e) => e instanceof SecretError && e.code === "audit-unavailable");
  });
});

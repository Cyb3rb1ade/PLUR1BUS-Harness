import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileAuditSink, sanitizeDetail } from "../../src/secrets/audit.ts";
import { SecretError } from "../../src/secrets/types.ts";
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

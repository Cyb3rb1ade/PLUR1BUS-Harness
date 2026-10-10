// The native helper is pinned by content as well as by owner and mode: an expected SHA-256 (release build constant, handed to the
// core through PLUR1BUS_ATTEST_SHA256) and, where configured, the macOS team id (codesign) or the Windows signer (Authenticode).
// Every deviation is `unavailable` with its reason in the audit log, never a dialog. No test here reaches the network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHelper } from "./fixtures/pinned-fake.ts";
import { createAttestationService, helperFromEnv, verifyHelper, type HelperPin, type HelperSpec } from "../../src/attestation/index.ts";
import type { PolicyAuditAction, PolicyAuditFields } from "../../src/policy/audit.ts";

const T = { timeout: 20_000 };
const posix = { ...T, skip: process.platform === "win32" };
const HASH = "ab".padEnd(64, "0");
const ask = () => ({ actionHash: HASH, text: "Allow agent bernd to run shell.exec for this session", person: "christian" });
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function rig(spec: HelperSpec) {
  const audit: { action: PolicyAuditAction; fields: PolicyAuditFields }[] = [];
  const svc = createAttestationService({ helper: spec, audit: { record: (action, fields) => { audit.push({ action, fields }); } } });
  return { svc, audit };
}
const pinned = (mode: string, arg?: string): HelperSpec => { const h = fakeHelper(mode, arg); return { ...h, pin: { sha256: sha(h.path) } }; };

describe("attestation helper content pin", () => {
  it("runs a helper whose SHA-256 is the expected one", posix, async () => {
    const { svc } = rig(pinned("ok"));
    assert.equal((await svc.attest(ask())).ok, true);
    assert.deepEqual(await svc.probe(), { available: true, method: "fake-biometric" });
  });

  it("accepts the expected hash in any letter case", posix, async () => {
    const h = fakeHelper("ok");
    assert.equal((await rig({ ...h, pin: { sha256: sha(h.path).toUpperCase() } }).svc.attest(ask())).ok, true);
  });

  it("is unavailable, with the reason audited, when the hash differs; the helper never starts", posix, async () => {
    const log = join(mkdtempSync(join(tmpdir(), "att-")), "req.log");
    const h = fakeHelper("log", log);
    const { svc, audit } = rig({ ...h, pin: { sha256: "0".repeat(64) } });
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "unavailable" });
    assert.equal(existsSync(log), false, "a helper that fails its pin must not be executed");
    assert.deepEqual(audit.map((a) => a.action), ["attestation.requested", "attestation.result"]);
    assert.equal(audit[1]!.fields.attestationOutcome, "unavailable");
    assert.equal(audit[1]!.fields.reason, "helper-hash-mismatch");
    assert.deepEqual(await svc.probe(), { available: false, reason: "unavailable" });
  });

  it("is unavailable when the file was replaced after the service was created (checked at every use, not once)", posix, async () => {
    const h = pinned("ok");
    const { svc, audit } = rig(h);
    assert.equal((await svc.attest(ask())).ok, true);
    chmodSync(h.path, 0o700);
    appendFileSync(h.path, "# swapped\n");
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "unavailable" });
    assert.equal(audit.at(-1)!.fields.reason, "helper-hash-mismatch");
  });

  it("discards a confirmation when the file changed while the dialog was open", posix, async () => {
    const h = pinned("swap");
    const { svc, audit } = rig({ ...h, env: { FAKE_SWAP_TARGET: h.path } });
    assert.deepEqual(await svc.attest(ask()), { ok: false, reason: "unavailable" });
    assert.equal(audit.at(-1)!.fields.attestationOutcome, "unavailable");
    assert.equal(audit.at(-1)!.fields.reason, "helper-changed-during-run");
  });

  it("is unavailable when the expected hash is not 64 hex digits (a broken pin is never read as no pin)", posix, async () => {
    for (const bad of ["", "abc", "z".repeat(64), `${"0".repeat(63)}`]) {
      const h = fakeHelper("ok");
      assert.deepEqual(await rig({ ...h, pin: { sha256: bad } }).svc.attest(ask()), { ok: false, reason: "unavailable" }, JSON.stringify(bad));
    }
  });

  it("without any pin the owner and mode check stays the only gate (dev builds)", posix, async () => {
    assert.equal((await rig(fakeHelper("ok")).svc.attest(ask())).ok, true);
  });

  it("a file that is not a pinned file at all is refused before it is read", posix, async () => {
    const d = mkdtempSync(join(tmpdir(), "att-loose-"));
    const p = join(d, "h"); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o777);
    assert.deepEqual(await verifyHelper({ path: p, pin: { sha256: sha(p) } }), { ok: false, reason: "helper-not-pinned" });
  });
});

describe("attestation helper signature pin (injected exec; no real codesign or PowerShell is needed)", () => {
  const seen: { file: string; args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
  const execOk = (stdout = "") => async (file: string, args: readonly string[], o?: { env?: Record<string, string | undefined> }) => { seen.push({ file, args, ...(o?.env ? { env: o.env } : {}) }); return { code: 0, stdout }; };
  const spec = (pin: HelperPin): HelperSpec => ({ ...fakeHelper("ok"), pin });

  it("macOS: codesign --verify runs without a shell, with the team id inside the requirement and the path as its own argument", posix, async () => {
    seen.length = 0;
    const h = spec({ macTeamId: "ABCDE12345" });
    assert.deepEqual((await verifyHelper(h, { platform: "darwin", exec: execOk() })).ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.file, "/usr/bin/codesign");
    assert.deepEqual(seen[0]!.args.slice(0, 2), ["--verify", "--strict"]);
    assert.equal(seen[0]!.args.at(-1), h.path);
    assert.ok(seen[0]!.args.some((a) => a.includes('certificate leaf[subject.OU] = "ABCDE12345"')));
  });

  it("macOS: a failing codesign is helper-signature-invalid; a team id that could alter the requirement is refused without running anything", posix, async () => {
    seen.length = 0;
    const fail = async () => ({ code: 3, stdout: "" });
    assert.deepEqual(await verifyHelper(spec({ macTeamId: "ABCDE12345" }), { platform: "darwin", exec: fail }), { ok: false, reason: "helper-signature-invalid" });
    for (const evil of ['ABCDE12345" or anchor apple', "abcde12345", "ABC", "ABCDE12345\n"]) {
      assert.deepEqual(await verifyHelper(spec({ macTeamId: evil }), { platform: "darwin", exec: execOk() }), { ok: false, reason: "helper-signature-invalid" }, JSON.stringify(evil));
    }
    assert.equal(seen.length, 0);
  });

  it("macOS: codesign that cannot run is helper-signature-unchecked, never a pass", posix, async () => {
    const missing = async () => { throw Object.assign(new Error("spawn"), { code: "ENOENT" }); };
    assert.deepEqual(await verifyHelper(spec({ macTeamId: "ABCDE12345" }), { platform: "darwin", exec: missing }), { ok: false, reason: "helper-signature-unchecked" });
  });

  it("Windows: Authenticode must be Valid and the signer thumbprint the pinned one; the path travels in the environment, not in the script", async () => {
    seen.length = 0;
    const thumb = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678";
    const h: HelperSpec = { ...fakeHelper("ok"), pin: { winThumbprint: thumb.toLowerCase() } };
    assert.equal((await verifyHelper(h, { platform: "win32", exec: execOk(`${thumb}\r\n`) })).ok, true);
    assert.ok(/powershell\.exe$/i.test(seen[0]!.file));
    assert.ok(!seen[0]!.args.join(" ").includes(h.path), "the path must not be interpolated into the script");
    assert.equal(seen[0]!.env?.PLUR1BUS_VERIFY_PATH, h.path);
    assert.deepEqual(await verifyHelper(h, { platform: "win32", exec: execOk("0000000000000000000000000000000000000000") }), { ok: false, reason: "helper-signature-invalid" });
    assert.deepEqual(await verifyHelper(h, { platform: "win32", exec: async () => ({ code: 2, stdout: "" }) }), { ok: false, reason: "helper-signature-invalid" });
  });

  it("a team id or thumbprint pinned for another platform is ignored there (the hash pin still applies)", posix, async () => {
    seen.length = 0;
    const h = fakeHelper("ok");
    assert.equal((await verifyHelper({ ...h, pin: { sha256: sha(h.path), macTeamId: "ABCDE12345", winThumbprint: "A".repeat(40) } }, { platform: "linux", exec: execOk() })).ok, true);
    assert.equal(seen.length, 0);
  });
});

describe("attestation helper pin from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "att-env-"));
  const exe = (): string => { const p = join(dir, "plur1bus-attest"); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755); return p; };

  it("reads PLUR1BUS_ATTEST_SHA256, PLUR1BUS_ATTEST_TEAM_ID and PLUR1BUS_ATTEST_WIN_THUMBPRINT into the spec", posix, () => {
    const p = exe();
    assert.deepEqual(helperFromEnv({ PLUR1BUS_ATTEST_BIN: p, PLUR1BUS_ATTEST_SHA256: HASH.toUpperCase(), PLUR1BUS_ATTEST_TEAM_ID: "ABCDE12345", PLUR1BUS_ATTEST_WIN_THUMBPRINT: "a".repeat(40) }),
      { path: p, pin: { sha256: HASH, macTeamId: "ABCDE12345", winThumbprint: "A".repeat(40) } });
  });

  it("without pin variables the spec is exactly what it was before", posix, () => {
    const p = exe();
    assert.deepEqual(helperFromEnv({ PLUR1BUS_ATTEST_BIN: p }), { path: p });
  });

  it("a malformed pin is no helper at all (fail closed), not an unpinned one", posix, () => {
    const p = exe();
    for (const env of [{ PLUR1BUS_ATTEST_SHA256: "xyz" }, { PLUR1BUS_ATTEST_SHA256: "" }, { PLUR1BUS_ATTEST_TEAM_ID: "lower12345" }, { PLUR1BUS_ATTEST_WIN_THUMBPRINT: "12" }]) {
      assert.equal(helperFromEnv({ PLUR1BUS_ATTEST_BIN: p, ...env }), null, JSON.stringify(env));
    }
  });
});

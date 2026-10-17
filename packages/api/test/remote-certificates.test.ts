import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteCertificates } from "../src/remote-certificates.ts";
import { makePki, NOW, issueLeaf } from "../../remote-access/test/helpers.ts";
const home = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), "remote-certificates-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
test("self-signed private material persists, stages separately and switches atomically", async t => {
  const dir = home(t), store = new RemoteCertificates({ home: dir, names: { hostnames: ["localhost"], ips: ["127.0.0.1"] } });
  const first = await store.ensureSelfSigned(); assert.equal(first.kind, "self-signed"); assert.equal((await store.ensureSelfSigned()).certPin, first.certPin);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "state", "api", "remote-tls", "current.json")).mode & 0o777, 0o600);
  const next = await store.stageSelfSigned(); assert.notEqual(first.certPin, next.certPin); assert.equal(store.current()?.certPin, first.certPin);
  await assert.rejects(store.stageSelfSigned(), { reason: "already-staged" }); const active = store.activateStaged(); assert.equal(active.certPin, next.certPin); assert.equal(store.staged(), undefined);
  const reopen = new RemoteCertificates({ home: dir, names: { hostnames: ["localhost"], ips: ["127.0.0.1"] } }); assert.equal(reopen.current()?.certPin, next.certPin);
});
test("company certificate/key validates SAN, chain, key match and expiry; same-CA leaf renews", async t => {
  const dir = home(t), names = { hostnames: ["harness.corp.example"], ips: ["192.168.1.20"] }, store = new RemoteCertificates({ home: dir, names, now: () => NOW.getTime() }), pki = makePki();
  const first = await store.stageCompany({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }); assert.ok(first.caPin); store.activateStaged();
  const renewal = issueLeaf(pki); const next = await store.stageCompany({ certChainPem: renewal.leafPem + pki.interPem, keyPem: renewal.leafKeyPem, caPem: pki.rootPem }); assert.equal(next.caPin, first.caPin); assert.notEqual(next.certPin, first.certPin); store.cancelStaged();
  await assert.rejects(store.stageCompany({ certChainPem: pki.leafPem, keyPem: renewal.leafKeyPem }), { reason: "key-mismatch" });
  const wrongName = new RemoteCertificates({ home: home(t), names: { hostnames: ["wrong.example"] }, now: () => NOW.getTime() }); await assert.rejects(wrongName.stageCompany({ certChainPem: pki.leafPem, keyPem: pki.leafKeyPem }), { reason: "san-missing" });
  const expired = makePki({ leafTo: -1 }); await assert.rejects(store.stageCompany({ certChainPem: expired.leafPem + expired.interPem, keyPem: expired.leafKeyPem }), { reason: "expired" });
});
test("private certificate file cannot be symlinked, made public or corrupted", { skip: process.platform === "win32" }, async t => {
  const dir = home(t), store = new RemoteCertificates({ home: dir, names: { hostnames: ["localhost"] } }); await store.ensureSelfSigned(); const file = join(dir, "state", "api", "remote-tls", "current.json");
  chmodSync(file, 0o644); assert.throws(() => store.current(), { reason: "untrusted-file" }); chmodSync(file, 0o600); writeFileSync(file, "{}"); assert.throws(() => store.current(), { reason: "corrupt-bundle" });
  rmSync(file); symlinkSync(join(dir, "other-key"), file); assert.throws(() => store.current(), { reason: "untrusted-file" });
});

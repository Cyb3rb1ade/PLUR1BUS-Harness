import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { SecretError } from "../../src/secrets/types.ts";
import { SIGNING_KEY_SECRET_NAME, secretStoreSigningKeySource } from "../../src/approvals/keys.ts";
import { loadDecisionSigner, verifyDecisionSignature } from "../../src/approvals/signing.ts";
import { BINDING, FakeClock, dbFile, openChain, openStore, raw } from "./helpers.ts";

const T = { timeout: 15_000 };

function mkStore() {
  const keyring = createMemoryBackend();
  const store = createSecretStore({ keyring, file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
  return { store, keyring };
}

describe("approval decision Ed25519 signatures (D109 §9.7)", () => {
  it("unsigned legacy entries remain valid and are reported as unsigned (legacy)", T, () => {
    const { chain } = openChain(dbFile());
    chain.append("approval.requested", "apr_legacy", { bound: BINDING, capability: "fs.read", expiresAt: 1 });
    const v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.signatures.unsignedLegacy, 1);
    assert.equal(v.signatures.signedOk, 0);
    assert.equal(v.signatures.signedBad, 0);
    assert.equal(v.signatures.report, "unsigned (legacy)");
  });

  it("a decided approval with a signer verifies as signed-ok", T, async () => {
    const { store: secrets } = mkStore();
    const signer = await loadDecisionSigner(secretStoreSigningKeySource(secrets));
    const clock = new FakeClock();
    const opened = openChain(dbFile(), { clock });
    opened.chain.setSigner(signer);
    const req = opened.chain.append("approval.requested", "apr_s", { bound: BINDING, capability: "fs.read", expiresAt: clock.now() + 60_000 }, "nonce1");
    const dec = opened.chain.append("approval.decided", "apr_s", { decision: "approve", person: "christian", surface: 2, delegable: false, bound: BINDING }, "nonce1");
    assert.ok(req.seq === 1 && dec.seq === 2);
    const v = opened.chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.signatures.signedOk, 1);
    assert.equal(v.signatures.unsignedLegacy, 1);
    assert.equal(v.signatures.signedBad, 0);
    assert.equal(v.signatures.report, "signed-ok");
  });

  it("a manipulated signed decision fails integrity as signed-bad; HMAC still holds", T, async () => {
    const { store: secrets } = mkStore();
    const signer = await loadDecisionSigner(secretStoreSigningKeySource(secrets));
    const path = dbFile();
    const clock = new FakeClock();
    const opened = openChain(path, { clock });
    opened.chain.setSigner(signer);
    opened.chain.append("approval.requested", "apr_t", { bound: BINDING, capability: "fs.read", expiresAt: clock.now() + 60_000 }, "nonce1");
    opened.chain.append("approval.decided", "apr_t", { decision: "approve", person: "christian", surface: 2, delegable: false, bound: BINDING }, "nonce1");
    const hmac = opened.chain.verify();
    assert.equal(hmac.ok, true);
    const db = raw(path);
    db.prepare("UPDATE approval_signatures SET signature = ? WHERE seq = 2").run("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    db.close();
    const v = opened.chain.verify();
    assert.equal(v.ok, false);
    assert.equal(v.reason, "signature-mismatch");
    assert.equal(v.signatures.signedBad, 1);
    assert.equal(v.signatures.report, "signed-bad");
  });

  it("unsigned legacy does not fail integrity after a payload that HMAC still accepts", T, () => {
    const { chain } = openChain(dbFile());
    chain.append("note", "r1", { i: 1 });
    const v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.signatures.report, "unsigned (legacy)");
    assert.equal(v.signatures.signedBad, 0);
  });

  it("HMAC payload tamper is still mac-mismatch (the HMAC chain is unchanged)", T, async () => {
    const { store: secrets } = mkStore();
    const signer = await loadDecisionSigner(secretStoreSigningKeySource(secrets));
    const path = dbFile();
    const clock = new FakeClock();
    const opened = openChain(path, { clock });
    opened.chain.setSigner(signer);
    opened.chain.append("approval.requested", "apr_h", { bound: BINDING, capability: "fs.read", expiresAt: clock.now() + 60_000 }, "nonce1");
    opened.chain.append("approval.decided", "apr_h", { decision: "approve", person: "christian", surface: 2, delegable: false, bound: BINDING }, "nonce1");
    const db = raw(path);
    db.prepare("UPDATE approval_chain SET payload = '{\"x\":1}' WHERE seq = 2").run();
    db.close();
    const v = opened.chain.verify();
    assert.equal(v.ok, false);
    assert.equal(v.reason, "mac-mismatch");
  });

  it("setSigner invalidates the snapshot cache so a later verify uses the new key", T, async () => {
    const a = await loadDecisionSigner(secretStoreSigningKeySource(mkStore().store));
    const b = await loadDecisionSigner(secretStoreSigningKeySource(mkStore().store));
    assert.notEqual(a.publicKey, b.publicKey);
    const clock = new FakeClock();
    const opened = openChain(dbFile(), { clock });
    opened.chain.setSigner(a);
    opened.chain.append("approval.requested", "apr_cache", { bound: BINDING, capability: "fs.read", expiresAt: clock.now() + 60_000 }, "nonce1");
    opened.chain.append("approval.decided", "apr_cache", { decision: "approve", person: "christian", surface: 2, delegable: false, bound: BINDING }, "nonce1");
    const ok = opened.chain.verify();
    assert.equal(ok.ok, true);
    assert.equal(ok.signatures.report, "signed-ok");
    opened.chain.setSigner(b);
    const v = opened.chain.verify();
    assert.equal(v.ok, false);
    assert.equal(v.reason, "signature-mismatch");
    assert.equal(v.signatures.report, "signed-bad");
  });

  it("the approval store signs a decide() and verify() reports signed-ok", T, async () => {
    const { store: secrets } = mkStore();
    const signer = await loadDecisionSigner(secretStoreSigningKeySource(secrets));
    const { store } = await openStore(dbFile(), { signer });
    const req = store.request({ ...BINDING, capability: "fs.read" });
    const d = store.decide({ requestId: req.id, nonce: req.nonce, decision: "approve", person: "christian", surface: 2 });
    assert.equal(d.ok, true);
    const v = store.verify();
    assert.equal(v.ok, true);
    assert.equal(v.signatures.signedOk, 1);
    assert.equal(v.signatures.report, "signed-ok");
  });

  it("a corrupt signing key fails closed and is never replaced", T, async () => {
    const { store, keyring } = mkStore();
    await store.set({ kind: "owner", id: "t" }, SIGNING_KEY_SECRET_NAME, Buffer.alloc(8).toString("base64"));
    await assert.rejects(() => loadDecisionSigner(secretStoreSigningKeySource(store)), (e: unknown) => e instanceof SecretError && e.code === "corrupt");
    const again = keyring.dump().get(SIGNING_KEY_SECRET_NAME);
    assert.equal(again, Buffer.alloc(8).toString("base64"));
  });

  it("a missing signing key is generated on first use and reused afterwards", T, async () => {
    const { store, keyring } = mkStore();
    const a = await loadDecisionSigner(secretStoreSigningKeySource(store));
    const b = await loadDecisionSigner(secretStoreSigningKeySource(store));
    assert.ok(keyring.dump().has(SIGNING_KEY_SECRET_NAME));
    const mac = "a".repeat(64);
    const sa = a.sign(mac);
    assert.equal(sa.publicKey, b.publicKey);
    assert.equal(verifyDecisionSignature(mac, sa.publicKey, sa.signature), true);
  });

  it("a stored value that is not an Ed25519 PKCS8 key is corrupt, not regenerated", T, async () => {
    const { store } = mkStore();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await store.set({ kind: "owner", id: "t" }, SIGNING_KEY_SECRET_NAME, privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    await assert.rejects(() => loadDecisionSigner(secretStoreSigningKeySource(store)), (e: unknown) => e instanceof SecretError && e.code === "corrupt");
  });
});



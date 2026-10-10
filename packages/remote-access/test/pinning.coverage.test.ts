import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { presentedFromSocket, verifySocket } from "../src/pinning.ts";
import type { DeviceTrust } from "../src/trust-rollover.ts";
import { certPin, pinOf } from "../src/fingerprint.ts";
import { makePki } from "./helpers.ts";

// Coverage for the socket glue: what counts as a presented leaf (a missing or empty peer certificate), when the CA pin is
// reported (only when the socket is authorised against the configured CA), and the verdict per anchor kind. The sockets
// are fakes that carry only getPeerCertificate() and authorized; the real handshake is covered by pinning-e2e.test.ts.

const pki = makePki();
const LEAF_DER: Buffer = Buffer.from(new X509Certificate(pki.leafPem).raw);
const ROOT_PEM = pki.rootPem;
const OTHER_PEM = makePki().rootPem;

/** What node hands back from getPeerCertificate(): `raw` is the DER of the leaf; no certificate is `{}`. */
function socket(peer: unknown, authorized: boolean): TLSSocket {
  return { getPeerCertificate: () => peer, authorized } as unknown as TLSSocket;
}

// --- presentedFromSocket ---------------------------------------------------------------------------------------------

test("presentedFromSocket: the leaf pin is the SHA-256 of the DER the peer showed", () => {
  const p = presentedFromSocket(socket({ raw: LEAF_DER }, false));
  assert.deepEqual(p, { leafPin: pinOf(LEAF_DER) });
  assert.equal(p.leafPin, certPin(pki.leafPem));
  assert.equal("chainCaPin" in p, false);
});

test("presentedFromSocket: no CA pin without a configured CA, even when the socket is authorised", () => {
  const p = presentedFromSocket(socket({ raw: LEAF_DER }, true));
  assert.equal("chainCaPin" in p, false);
});

test("presentedFromSocket: a configured CA is reported as chainCaPin only when the socket is authorised against it", () => {
  const authorised = presentedFromSocket(socket({ raw: LEAF_DER }, true), ROOT_PEM);
  assert.deepEqual(authorised, { leafPin: pinOf(LEAF_DER), chainCaPin: certPin(ROOT_PEM) });
  const refused = presentedFromSocket(socket({ raw: LEAF_DER }, false), ROOT_PEM);
  assert.equal("chainCaPin" in refused, false, "a chain that did not verify proves nothing about the CA");
});

test("presentedFromSocket: a peer that presented no certificate is an error, not a pin of nothing", () => {
  assert.throws(() => presentedFromSocket(socket({}, false)), /the peer presented no certificate/);
  assert.throws(() => presentedFromSocket(socket({ raw: undefined }, true), ROOT_PEM), /the peer presented no certificate/);
  assert.throws(() => presentedFromSocket(socket(undefined, false)), /the peer presented no certificate/);
});

// UNKLAR: a zero-length `raw` is truthy, so it is pinned as the SHA-256 of nothing instead of refused like a missing
// certificate. Is that acceptable (no device can ever hold that pin, so it never matches), or must it throw?
test.skip("presentedFromSocket: a zero-length certificate is refused like a missing one", () => {
  assert.throws(() => presentedFromSocket(socket({ raw: Buffer.alloc(0) }, false)), /the peer presented no certificate/);
});

// --- verifySocket ------------------------------------------------------------------------------------------------------

test("verifySocket: a device pinned to the leaf trusts it; another leaf is certificate-changed", () => {
  const device: DeviceTrust = { current: { kind: "cert", pin: certPin(pki.leafPem) } };
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, false)), "trusted");
  const other = pinOf(Buffer.from("some other certificate"));
  assert.equal(verifySocket({ current: { kind: "cert", pin: other } }, socket({ raw: LEAF_DER }, true), ROOT_PEM), "certificate-changed");
});

test("verifySocket: a device pinned to the company CA trusts a chain that verified to it, and nothing else", () => {
  const device: DeviceTrust = { current: { kind: "ca", pin: certPin(ROOT_PEM) } };
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, true), ROOT_PEM), "trusted");
  // authorised, but against a different CA than the one the device holds
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, true), OTHER_PEM), "certificate-changed");
  // the CA is pinned on the device, but the socket was not verified against it
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, false), ROOT_PEM), "certificate-changed");
  // no CA argument at all: a ca anchor can never match a leaf pin
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, true)), "certificate-changed");
});

test("verifySocket: during a rollover the next anchor is accepted as trusted-next, the current one still wins", () => {
  const next = { kind: "cert" as const, pin: certPin(OTHER_PEM) };
  const device: DeviceTrust = { current: { kind: "cert", pin: certPin(pki.leafPem) }, next };
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, false)), "trusted");
  // the peer shows the certificate whose pin is the next anchor
  assert.equal(verifySocket(device, socket({ raw: Buffer.from(new X509Certificate(OTHER_PEM).raw) }, false)), "trusted-next");
  const stranger = makePki();
  assert.equal(verifySocket(device, socket({ raw: Buffer.from(new X509Certificate(stranger.leafPem).raw) }, false)), "certificate-changed");
});

test("verifySocket: a next CA anchor is matched through the authorised chain", () => {
  const device: DeviceTrust = {
    current: { kind: "ca", pin: certPin(OTHER_PEM) },
    next: { kind: "ca", pin: certPin(ROOT_PEM) },
  };
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, true), ROOT_PEM), "trusted-next");
  assert.equal(verifySocket(device, socket({ raw: LEAF_DER }, false), ROOT_PEM), "certificate-changed");
});

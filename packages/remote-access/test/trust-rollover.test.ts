import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptedAnchors, ackTrust, announceStaged, announcementFor, cancelTrust, clearSwitched, evaluateConnection, initTrust, parseTrust,
  promote, receiveAnnouncement, serializeTrust, stageTrust, switchTrust, trustForNewPairing, trustNextEvent, trustProgress,
} from "../src/trust-rollover.ts";
import type { Anchor, DeviceTrust, TrustDevice, TrustState } from "../src/trust-rollover.ts";
import { pinOf } from "../src/fingerprint.ts";

const T0 = 1_700_000_000_000;
const pin = (s: string) => pinOf(Buffer.from(s));
const OLD: Anchor = { kind: "cert", pin: pin("old leaf") };
const NEW: Anchor = { kind: "cert", pin: pin("new leaf") };
const CA: Anchor = { kind: "ca", pin: pin("company root") };
const DEVICES: TrustDevice[] = [
  { id: "d1", name: "Anna's phone", lastSeenAt: T0 - 1000 },
  { id: "d2", name: "Desktop", lastSeenAt: T0 - 5000 },
  { id: "d3", name: "Old tablet", lastSeenAt: T0 - 9_000_000 },
];
const PAIRED = DEVICES.map((d) => d.id);

function okState(r: { ok: boolean; state?: TrustState; code?: string }): TrustState {
  assert.ok(r.ok, JSON.stringify(r));
  return r.state!;
}

test("fresh trust: nothing staged, one anchor accepted, nothing to announce", () => {
  const s = initTrust(OLD);
  assert.equal(s.phase, "none");
  assert.deepEqual(acceptedAnchors(s), [OLD]);
  assert.deepEqual(announcementFor(s), { phase: "none", current: OLD });
  assert.equal(trustNextEvent(s), undefined);
  assert.deepEqual(trustForNewPairing(s), { certPin: OLD.pin });
  assert.deepEqual(trustForNewPairing(initTrust(CA)), { caPin: CA.pin });
});

test("stage: both anchors accepted, announced, and carried by new pairings", () => {
  const s = okState(stageTrust(initTrust(OLD), NEW, T0));
  assert.equal(s.phase, "staged");
  assert.deepEqual(acceptedAnchors(s), [OLD, NEW]);
  assert.deepEqual(announcementFor(s), { phase: "staged", current: OLD, next: NEW, stagedAt: T0 });
  assert.deepEqual(trustNextEvent(s), { type: "devices.trust.next", next: NEW, stagedAt: T0 });
  assert.deepEqual(trustForNewPairing(s), { certPin: OLD.pin, nextCertPin: NEW.pin });
  const toCa = okState(stageTrust(initTrust(OLD), CA, T0));
  assert.deepEqual(trustForNewPairing(toCa), { certPin: OLD.pin, nextCaPin: CA.pin }, "self-signed to company CA: kinds differ per anchor");
});

test("stage refuses the same trust, a second staging, bad pins", () => {
  const base = initTrust(OLD);
  const sameTrust = stageTrust(base, OLD, T0);
  assert.ok(!sameTrust.ok);
  assert.equal(sameTrust.code, "same-trust");
  const staged = okState(stageTrust(base, NEW, T0));
  const again = stageTrust(staged, CA, T0 + 1);
  assert.ok(!again.ok);
  assert.equal(again.code, "already-staged");
  const bad = stageTrust(base, { kind: "cert", pin: "sha256:nope" as never }, T0);
  assert.ok(!bad.ok);
  assert.equal(bad.code, "bad-pin");
  // the same pin under another kind is a different anchor
  assert.ok(stageTrust(base, { kind: "ca", pin: OLD.pin }, T0).ok);
});

test("ack: only paired devices, only for the staged next pin, idempotent", () => {
  const s = okState(stageTrust(initTrust(OLD), NEW, T0));
  const a = okState(ackTrust(s, { deviceId: "d1", pin: NEW.pin, now: T0 + 10, paired: PAIRED }));
  const again = okState(ackTrust(a, { deviceId: "d1", pin: NEW.pin, now: T0 + 99, paired: PAIRED }));
  assert.deepEqual(again.acks, { d1: T0 + 10 }, "the first confirmation time stays");
  const stranger = ackTrust(s, { deviceId: "mallory", pin: NEW.pin, now: T0, paired: PAIRED });
  assert.ok(!stranger.ok);
  assert.equal(stranger.code, "unknown-device");
  const wrong = ackTrust(s, { deviceId: "d1", pin: pin("something else"), now: T0, paired: PAIRED });
  assert.ok(!wrong.ok);
  assert.equal(wrong.code, "pin-mismatch");
  const idle = ackTrust(initTrust(OLD), { deviceId: "d1", pin: NEW.pin, now: T0, paired: PAIRED });
  assert.ok(!idle.ok);
  assert.equal(idle.code, "not-staged");
});

test("progress: who has it, who is missing (by name, last seen)", () => {
  let s = okState(stageTrust(initTrust(OLD), NEW, T0));
  assert.deepEqual(trustProgress(s, DEVICES), { received: 0, total: 3, missing: DEVICES });
  s = okState(ackTrust(s, { deviceId: "d2", pin: NEW.pin, now: T0, paired: PAIRED }));
  s = okState(ackTrust(s, { deviceId: "d1", pin: NEW.pin, now: T0, paired: PAIRED }));
  const p = trustProgress(s, DEVICES);
  assert.equal(p.received, 2);
  assert.equal(p.total, 3);
  assert.deepEqual(p.missing.map((d) => d.name), ["Old tablet"]);
  assert.deepEqual(trustProgress(initTrust(OLD), DEVICES), { received: 0, total: 3, missing: [] }, "nothing staged: nobody is missing anything");
});

test("switch: the next becomes current, only devices that missed the announcement must pair again", () => {
  let s = okState(stageTrust(initTrust(OLD), NEW, T0));
  s = okState(ackTrust(s, { deviceId: "d1", pin: NEW.pin, now: T0, paired: PAIRED }));
  s = okState(ackTrust(s, { deviceId: "d2", pin: NEW.pin, now: T0, paired: PAIRED }));
  const r = switchTrust(s, DEVICES, T0 + 5000);
  assert.ok(r.ok);
  assert.equal(r.state.phase, "switched");
  assert.deepEqual(r.state.current, NEW);
  assert.equal(r.state.next, undefined);
  assert.deepEqual(r.repair.map((d) => d.id), ["d3"]);
  assert.deepEqual(r.state.repairIds, ["d3"]);
  assert.deepEqual(acceptedAnchors(r.state), [NEW], "the old trust is no longer accepted after the switch");
  assert.deepEqual(trustForNewPairing(r.state), { certPin: NEW.pin });
  assert.equal(switchTrust(initTrust(OLD), DEVICES, T0).ok, false);
  const cleared = okState(clearSwitched(r.state));
  assert.equal(cleared.phase, "none");
  assert.equal(cleared.repairIds, undefined);
  assert.equal(clearSwitched(cleared).ok, false);
  // a new change can be staged straight from the "switched" summary
  assert.ok(stageTrust(r.state, CA, T0 + 9000).ok);
});

test("cancel: back to none, acknowledgements forgotten, current untouched", () => {
  let s = okState(stageTrust(initTrust(OLD), NEW, T0));
  s = okState(ackTrust(s, { deviceId: "d1", pin: NEW.pin, now: T0, paired: PAIRED }));
  const c = okState(cancelTrust(s));
  assert.equal(c.phase, "none");
  assert.deepEqual(c.current, OLD);
  assert.equal(c.next, undefined);
  assert.deepEqual(c.acks, {});
  assert.equal(cancelTrust(c).ok, false);
});

test("a device follows the whole change without pairing again", () => {
  const harness0 = initTrust(OLD);
  let device: DeviceTrust = { current: OLD };
  const trusted = { authenticated: true, verifiedBy: "current" } as const;

  assert.equal(evaluateConnection(device, { leafPin: OLD.pin }), "trusted");
  assert.equal(evaluateConnection(device, { leafPin: NEW.pin }), "certificate-changed");

  const staged = okState(stageTrust(harness0, NEW, T0));
  const got = receiveAnnouncement(device, announcementFor(staged), trusted);
  assert.ok(got.ok);
  device = got.device;
  assert.deepEqual(device, { current: OLD, next: NEW });
  assert.equal(evaluateConnection(device, { leafPin: OLD.pin }), "trusted");
  assert.equal(evaluateConnection(device, { leafPin: NEW.pin }), "trusted-next", "both fingerprints are accepted during the transition");

  // the harness switches; the device connects, sees the next certificate, promotes it
  const verdict = evaluateConnection(device, { leafPin: NEW.pin });
  assert.equal(verdict, "trusted-next");
  device = promote(device, { leafPin: NEW.pin });
  assert.deepEqual(device, { current: NEW });
  assert.equal(evaluateConnection(device, { leafPin: NEW.pin }), "trusted");
  assert.equal(evaluateConnection(device, { leafPin: OLD.pin }), "certificate-changed", "the old certificate is refused once the change is over");
});

test("a device that missed the announcement must pair again", () => {
  const device: DeviceTrust = { current: OLD };
  assert.equal(evaluateConnection(device, { leafPin: NEW.pin }), "certificate-changed");
  assert.deepEqual(promote(device, { leafPin: NEW.pin }), device, "promote without a matching next changes nothing");
});

test("a device takes a next pin only over its authenticated, already-trusted connection", () => {
  const staged = okState(stageTrust(initTrust(OLD), NEW, T0));
  const ann = announcementFor(staged);
  const device: DeviceTrust = { current: OLD };
  for (const channel of [
    { authenticated: false, verifiedBy: "current" },
    { authenticated: true, verifiedBy: "none" },
    { authenticated: true, verifiedBy: "os-store" },
    { authenticated: true, verifiedBy: "next" },
  ] as const) {
    const r = receiveAnnouncement(device, ann, channel);
    assert.ok(!r.ok, JSON.stringify(channel));
    assert.equal(r.code, "untrusted-channel");
  }
  // an announcement whose `current` is not what the device pins is not from the harness it knows
  const foreign = announcementFor(okState(stageTrust(initTrust({ kind: "cert", pin: pin("other") }), NEW, T0)));
  const r = receiveAnnouncement(device, foreign, { authenticated: true, verifiedBy: "current" });
  assert.ok(!r.ok);
  assert.equal(r.code, "wrong-harness");
});

test("a cancelled change is cleared on the device by the next announcement; the CA kind compares the chain's root", () => {
  const trusted = { authenticated: true, verifiedBy: "current" } as const;
  const staged = okState(stageTrust(initTrust(OLD), NEW, T0));
  let device = receiveAnnouncement({ current: OLD }, announcementFor(staged), trusted);
  assert.ok(device.ok);
  const cancelled = receiveAnnouncement(device.device, announcementFor(okState(cancelTrust(staged))), trusted);
  assert.ok(cancelled.ok);
  assert.deepEqual(cancelled.device, { current: OLD });

  const caDevice: DeviceTrust = { current: CA };
  assert.equal(evaluateConnection(caDevice, { leafPin: pin("any renewed leaf"), chainCaPin: CA.pin }), "trusted", "a leaf renewed by the same CA needs no re-pairing");
  assert.equal(evaluateConnection(caDevice, { leafPin: CA.pin }), "certificate-changed", "a leaf pin never satisfies a CA anchor");
  assert.equal(evaluateConnection(caDevice, { leafPin: pin("x"), chainCaPin: pin("other root") }), "certificate-changed");
  assert.equal(evaluateConnection(caDevice, { leafPin: pin("x") }), "certificate-changed");
});

test("announceStaged: pushes to connected devices, the rest pull when they connect", async () => {
  const s = okState(stageTrust(initTrust(OLD), NEW, T0));
  const pushed: string[] = [];
  const port = { async push(deviceId: string, event: unknown) { pushed.push(deviceId); assert.deepEqual(event, trustNextEvent(s)); return deviceId !== "d3"; } };
  const r = await announceStaged(s, DEVICES, port);
  assert.deepEqual(r, { delivered: ["d1", "d2"], pending: ["d3"] });
  assert.deepEqual(pushed, ["d1", "d2", "d3"]);
  const none = await announceStaged(initTrust(OLD), DEVICES, port);
  assert.deepEqual(none, { delivered: [], pending: [] });
});

test("serialize / parse: round trip, and corrupt state is refused", () => {
  let s = okState(stageTrust(initTrust(OLD), NEW, T0));
  s = okState(ackTrust(s, { deviceId: "d1", pin: NEW.pin, now: T0 + 1, paired: PAIRED }));
  const text = serializeTrust(s);
  assert.deepEqual(parseTrust(text), { ok: true, state: s });
  const sw = switchTrust(s, DEVICES, T0 + 2);
  assert.ok(sw.ok);
  assert.deepEqual(parseTrust(serializeTrust(sw.state)), { ok: true, state: sw.state });
  for (const bad of ["", "{", "[]", JSON.stringify({ ...JSON.parse(text), phase: "none" }), JSON.stringify({ ...JSON.parse(text), next: undefined }), JSON.stringify({ ...JSON.parse(text), phase: "bogus" }), JSON.stringify({ ...JSON.parse(text), current: { kind: "cert", pin: "x" } })]) {
    assert.equal(parseTrust(bad).ok, false, bad);
  }
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { RemotePairingController } from "../src/remote-pairing-controller.ts";
import { RemoteCertificates } from "../src/remote-certificates.ts";
import { assertTrustSize, type StoredTrust } from "../src/remote-trust-envelope.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import { PairCodeStore, pinOf, spkiPin, type Pin } from "../../remote-access/src/index.ts";
import { makePki, issueLeaf, NOW, DAY, type Pki } from "../../remote-access/test/helpers.ts";
import { buildCertificate } from "../../remote-access/src/x509.ts";
import type { HandlerInput } from "../src/routes.ts";

const pin = (text: string) => pinOf(Buffer.from(text));
const material = (certificate: string, key = certificate) => ({ certPin: pin(`certificate ${certificate}`), certSpkiPin: pin(`key ${key}`) });
function assertEffectiveUid(value: NodeJS.Process): asserts value is NodeJS.Process & { geteuid(): number } {
  assert.equal(typeof value.geteuid, "function");
}
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "trust-hardening-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  let current = material("A"), candidate = material("B"), staged: ReturnType<typeof material> | undefined, now = NOW.getTime();
  let announce: (() => Promise<void>) | undefined;
  const calls: string[] = [], devices: { id: string; name: string }[] = [], audit = memoryAuditSink();
  const options = {
    core: { callAs: async () => ({ devices }), serviceCall: async (method: string) => { calls.push(method); if (method === "admin.api.device.announce") await announce?.(); return {}; } } as any,
    audit, now: () => now, trustFile: join(home, "private", "trust.json"), publish: () => "network" as const,
    tlsMode: () => "company-ca" as const, origin: () => "https://harness.corp.example",
    current: () => current, staged: () => staged, stage: async () => { calls.push("stage"); return staged ??= candidate; },
    activate: async () => { calls.push("activate"); current = staged!; staged = undefined; },
    cancelStage: async () => { calls.push("cancel"); staged = undefined; }, transport: (i: HandlerInput) => i.remoteTransport,
    codes: new PairCodeStore({ params: { memoryKiB: 64, passes: 1, parallelism: 1 } }),
  };
  const controller = new RemotePairingController(options);
  const input = (operation?: string) => ({ body: operation ? { operation } : {}, ip: "192.0.2.10", rbac: { kind: "person", userId: "owner-person", role: "owner" } }) as HandlerInput;
  const read = () => JSON.parse(readFileSync(options.trustFile, "utf8")) as any;
  const write = (value: unknown) => { mkdirSync(dirname(options.trustFile), { recursive: true, mode: 0o700 }); writeFileSync(options.trustFile, JSON.stringify(value) + "\n", { mode: 0o600 }); };
  return { home, controller, options, input, read, write, calls, devices, audit, setCandidate: (value: typeof candidate) => candidate = value,
    setCurrent: (value: typeof current) => current = value, setStaged: (value: typeof staged) => staged = value,
    onAnnounce: (fn: typeof announce) => announce = fn, tick: (ms: number) => now += ms };
}
const anchor = (certPin: Pin) => ({ kind: "cert", pin: certPin });
const legacy = (current = material("A").certPin, revoked: unknown[] = []) => ({ version: 1, state: { current: anchor(current), revoked, phase: "none", acks: {} } });
const validV2 = () => ({ version: 2, state: legacy().state, keys: { current: material("A").certSpkiPin, retired: [] as Pin[], unresolved: [] as unknown[] } });

test("duplicate stage preserves the durable candidate without invoking the material stage port again", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); const before = readFileSync(f.options.trustFile, "utf8");
  await assert.rejects(f.controller.rotate(f.input("stage")));
  assert.equal(f.calls.filter(call => call === "stage").length, 1); assert.equal(f.calls.includes("cancel"), false);
  assert.equal(readFileSync(f.options.trustFile, "utf8"), before); assert.equal(f.options.staged()?.certPin, material("B").certPin);
});
test("announcement failure after durable stage preserves the candidate for a later activation", async t => {
  const f = fixture(t); f.onAnnounce(async () => { throw Error("offline Core"); });
  await assert.rejects(f.controller.rotate(f.input("stage"))); assert.equal(f.read().state.phase, "staged");
  assert.equal(f.options.staged()?.certPin, material("B").certPin); assert.equal(f.calls.includes("cancel"), false);
  f.onAnnounce(undefined); await f.controller.rotate(f.input("activate")); assert.equal(f.options.current().certPin, material("B").certPin);
});
test("cancel removes orphan material in none phase and preserves a switched summary", async t => {
  const f = fixture(t); f.setStaged(material("orphan")); await f.controller.rotate(f.input("cancel")); assert.equal(f.options.staged(), undefined);
  await f.controller.rotate(f.input("stage")); await f.controller.rotate(f.input("activate")); const before = f.read();
  f.setStaged(material("another orphan")); await f.controller.rotate(f.input("cancel")); assert.equal(f.options.staged(), undefined);
  assert.deepEqual(f.read(), before);
});
test("legacy missing history migrates to v2 on mutation without changing public trust fields", async t => {
  const f = fixture(t), old = legacy() as any; delete old.state.revoked; f.write(old);
  const restarted = new RemotePairingController(f.options); await restarted.rotate(f.input("stage")); const saved = f.read();
  assert.equal(saved.version, 2); assert.deepEqual(saved.state.revoked, []); assert.equal(saved.keys.current, material("A").certSpkiPin);
  assert.equal(saved.keys.next, material("B").certSpkiPin);
  const exposed = await restarted.getTrust(f.input()); assert.deepEqual(Object.keys(exposed.current).sort(), ["kind", "pin"]);
  assert.equal(JSON.stringify(exposed).includes("Spki"), false); assert.equal(JSON.stringify(exposed).includes(material("A").certSpkiPin), false);
});
for (const phase of ["none", "staged", "switched"] as const) test(`legacy missing history migrates safely from ${phase}`, async t => {
  const f = fixture(t), old = legacy() as any; delete old.state.revoked; old.state.phase = phase;
  if (phase === "staged") { old.state.next = anchor(material("B").certPin); old.state.stagedAt = 1; f.setStaged(material("B")); }
  if (phase === "switched") { old.state.switchedAt = 1; old.state.repairIds = ["offline"]; }
  f.write(old); const restarted = new RemotePairingController(f.options);
  await restarted.rotate(f.input(phase === "staged" ? "activate" : "cancel")); assert.equal(f.read().version, 2);
  assert.deepEqual(f.read().keys.unresolved, []);
  if (phase === "staged") assert.deepEqual(f.read().keys.retired, [material("A").certSpkiPin]);
  if (phase === "switched") assert.deepEqual(f.read().state.repairIds, ["offline"]);
});
test("legacy retired DER history stays readable and cancellable but blocks new candidate announcements", async t => {
  const f = fixture(t), retired = anchor(material("retired").certPin); f.write(legacy(material("A").certPin, [retired]));
  const restarted = new RemotePairingController(f.options); assert.equal((await restarted.getTrust(f.input())).current.pin, material("A").certPin);
  await assert.rejects(restarted.rotate(f.input("stage"))); assert.equal(f.calls.includes("stage"), false);
  await restarted.rotate(f.input("cancel")); assert.deepEqual(f.read().keys.unresolved, [retired]); assert.deepEqual(f.read().state.revoked, [retired]);
});
test("legacy unresolved staged history permits cancellation while refusing activation", async t => {
  const f = fixture(t), retired = anchor(pin("historic unknown DER")), old = legacy(material("A").certPin, [retired]) as any;
  old.state = { ...old.state, phase: "staged", next: anchor(material("B").certPin), stagedAt: 1 }; f.write(old); f.setStaged(material("B"));
  const restarted = new RemotePairingController(f.options); await restarted.getTrust(f.input());
  await assert.rejects(restarted.rotate(f.input("activate"))); assert.equal(f.calls.includes("activate"), false);
  await restarted.rotate(f.input("cancel")); assert.equal(f.options.staged(), undefined); assert.deepEqual(f.read().keys.unresolved, [retired]);
});
test("Tailnet fingerprint-only current material persists explicit unknown SPKI without inventing a key", async t => {
  const f = fixture(t), options = { ...f.options, publish: () => "tailnet" as const, current: () => ({ certPin: material("A").certPin }) };
  const controller = new RemotePairingController(options); await controller.getTrust(f.input()); assert.equal(f.read().keys.current, null);
  await assert.rejects(controller.rotate(f.input("stage"))); assert.equal(f.calls.includes("stage"), false);
});
test("v2 requires explicit revoked history even when deleting it would make the library parser accept empty history", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); const saved = f.read(); delete saved.state.revoked; f.write(saved);
  assert.throws(() => new RemotePairingController(f.options), /trust state unavailable/);
});
test("valid v2 metadata loads, while damaged key lists, phases and activation records fail closed", async t => {
  const f = fixture(t), good = validV2(); f.write(good); assert.equal((await new RemotePairingController(f.options).getTrust(f.input())).current.pin, good.state.current.pin);
  const changes: ((v: any) => void)[] = [
    v => delete v.keys, v => delete v.keys.retired, v => delete v.keys.unresolved, v => delete v.keys.current,
    v => v.keys.retired = ["sha256:bad"], v => v.keys.retired = [pin("retired"), pin("retired")],
    v => v.keys.current = "SHA256:" + v.keys.current.slice(7), v => v.keys.retired = [v.keys.current],
    v => v.keys.next = material("B").certSpkiPin, v => v.keys.unresolved = [anchor(pin("not revoked"))],
    v => v.activation = { devices: [], at: 1 }, v => v.state.revoked = null,
  ];
  for (const change of changes) { const broken = structuredClone(good); change(broken); f.write(broken); assert.throws(() => new RemotePairingController(f.options), /trust state unavailable/); }
});
test("v2 cannot stage its exact current anchor", t => {
  const f = fixture(t), same = validV2() as any;
  same.state = { ...same.state, phase: "staged", next: same.state.current, stagedAt: 1 }; same.keys.next = same.keys.current; f.write(same);
  assert.throws(() => new RemotePairingController(f.options), /trust state unavailable/);
});
test("v2 cannot hydrate an already-retired current key", async t => {
  const f = fixture(t);
  const retired = validV2() as any; retired.keys.retired = [retired.keys.current]; retired.keys.current = null; f.write(retired);
  await assert.rejects(new RemotePairingController(f.options).getTrust(f.input()), /trust state unavailable/);
});
test("v2 staged metadata and pending activation records reject malformed or inconsistent values", t => {
  const f = fixture(t), good = validV2() as any;
  good.state = { ...good.state, phase: "staged", next: anchor(material("B").certPin), stagedAt: 1 };
  good.keys.next = material("B").certSpkiPin; good.activation = { devices: [{ id: "offline", name: "offline" }], at: 2 };
  f.write(good); assert.doesNotThrow(() => new RemotePairingController(f.options));
  for (const change of [
    (v: any) => delete v.keys.next, (v: any) => v.keys.next = "sha256:bad", (v: any) => v.keys.next = null,
    (v: any) => v.keys.current = null, (v: any) => v.keys.retired = [v.keys.next],
    (v: any) => v.activation.at = -1, (v: any) => v.activation.at = 1.5, (v: any) => v.activation.devices = {},
    (v: any) => v.activation.devices.push(v.activation.devices[0]), (v: any) => v.activation.devices[0].id = 1,
    (v: any) => { const retired = anchor(pin("retired DER")); v.state.revoked = [retired]; v.keys.unresolved = [retired]; },
  ]) { const broken = structuredClone(good); change(broken); f.write(broken); assert.throws(() => new RemotePairingController(f.options), /trust state unavailable/); }
});
test("private trust directory rejects a symlink before changing its target permissions", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), dir = dirname(f.options.trustFile), target = join(f.home, "target"); mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755); // Establish the permissions under test independently of the runner's umask.
  rmSync(dir, { recursive: true, force: true }); symlinkSync(target, dir); assert.throws(() => new RemotePairingController(f.options), /untrusted-directory/);
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
});
test("private trust directory tightens owned permissions and checks ownership before chmod", { skip: process.platform === "win32" || typeof process.geteuid !== "function" }, async t => {
  const currentProcess = process; assertEffectiveUid(currentProcess);
  const f = fixture(t), dir = dirname(f.options.trustFile); mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o777);
  const restarted = new RemotePairingController(f.options); assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  chmodSync(dir, 0o755); const uid = currentProcess.geteuid(); const mocked = t.mock.method(currentProcess, "geteuid", () => uid + 1);
  assert.throws(() => new RemotePairingController(f.options), /untrusted-directory/); assert.equal(lstatSync(dir).mode & 0o777, 0o755);
  mocked.mock.restore(); await restarted.rotate(f.input("stage")); chmodSync(dir, 0o777); await restarted.rotate(f.input("cancel")); assert.equal(lstatSync(dir).mode & 0o777, 0o700);
});
test("restart and activation crash retain DER and SPKI history with a single retirement audit", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); const activate = f.options.activate;
  f.options.activate = async () => { await activate(); throw Error("crash after TLS switch"); };
  await assert.rejects(f.controller.rotate(f.input("activate"))); const intent = f.read(); f.tick(1000);
  const restarted = new RemotePairingController(f.options); await restarted.getTrust(f.input()); const final = f.read();
  assert.deepEqual(final.state.revoked, [anchor(material("A").certPin)]); assert.deepEqual(final.keys?.retired, [material("A").certSpkiPin]);
  assert.equal(final.state.switchedAt, intent.activation.at); assert.equal(final.keys.current, material("B").certSpkiPin);
  f.setCandidate(material("A reissued", "A")); await assert.rejects(restarted.rotate(f.input("stage"))); assert.equal(f.options.staged(), undefined);
  const retire = f.audit.events.filter(event => event.action === "device.trust.rotate" && event.detail?.retired);
  assert.equal(retire.length, 1); assert.deepEqual(retire[0]!.detail?.retired, anchor(material("A").certPin));
});
test("pending intent retry reuses recorded devices, time and retirement audit while TLS is still old", async t => {
  const f = fixture(t); f.devices.push({ id: "offline", name: "offline" }); await f.controller.rotate(f.input("stage")); const activate = f.options.activate;
  f.options.activate = async () => { throw Error("stopped before TLS switch"); }; await assert.rejects(f.controller.rotate(f.input("activate"))); const intent = f.read();
  f.tick(1000); f.devices.push({ id: "paired-later", name: "later" }); f.options.activate = activate;
  const restarted = new RemotePairingController(f.options), final = await restarted.rotate(f.input("activate"));
  assert.deepEqual((final as any).repairIds, ["offline"]); assert.equal(f.read().state.switchedAt, intent.activation.at);
  assert.equal(f.audit.events.filter(event => event.action === "device.trust.rotate" && event.detail?.retired).length, 1);
});
test("read recovery during activate and final save persist identical envelopes", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); let recovered = ""; const activate = f.options.activate;
  f.options.activate = async () => { await activate(); await f.controller.getTrust(f.input()); recovered = readFileSync(f.options.trustFile, "utf8"); f.tick(1000); };
  await f.controller.rotate(f.input("activate")); assert.equal(readFileSync(f.options.trustFile, "utf8"), recovered);
});
test("legacy already-completed TLS intent recovers without inventing the departed key identity", async t => {
  const f = fixture(t), prior = anchor(pin("older legacy DER")), old = legacy(material("A").certPin, [prior]) as any; old.state = { ...old.state, phase: "staged", next: anchor(material("B").certPin), stagedAt: 1 };
  old.activation = { devices: [], at: 2 }; f.write(old); f.setCurrent(material("B"));
  const restarted = new RemotePairingController(f.options); await restarted.getTrust(f.input()); assert.equal(f.read().version, 2);
  assert.deepEqual(f.read().keys?.unresolved, [prior, anchor(material("A").certPin)]); assert.deepEqual(f.read().keys?.retired, []);
  assert.deepEqual(f.read().state.revoked, [prior, anchor(material("A").certPin)]);
  await assert.rejects(restarted.rotate(f.input("stage"))); assert.equal(f.calls.includes("stage"), false);
});
test("activation checks the actual staged DER and key after asynchronous announcement", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); f.onAnnounce(async () => { f.setStaged(material("changed during announce")); });
  await assert.rejects(f.controller.rotate(f.input("activate"))); assert.equal(f.calls.includes("activate"), false); assert.equal(f.read().activation, undefined);
});
test("actual staged inspection hands off to activation without yielding to a queued candidate replacement", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); const staged = f.options.staged;
  f.options.staged = () => { const actual = staged(); queueMicrotask(() => f.setStaged(material("queued replacement"))); return actual; };
  await f.controller.rotate(f.input("activate")); assert.equal(f.options.current().certPin, material("B").certPin);
});
test("oversized activation intent is refused before announcing or switching TLS, counting UTF-8 bytes", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); const before = f.calls.length;
  f.devices.push({ id: "large", name: "é".repeat(140_000) });
  await assert.rejects(f.controller.rotate(f.input("activate"))); assert.equal(f.calls.slice(before).includes("admin.api.device.announce"), false);
  assert.equal(f.calls.includes("activate"), false); assert.equal(f.read().activation, undefined);
});
test("an invalid device snapshot cannot create an unreadable activation intent or announce activation", async t => {
  const f = fixture(t); await f.controller.rotate(f.input("stage")); f.devices.push({ id: "duplicate", name: "first" }, { id: "duplicate", name: "second" });
  const before = f.calls.length; await assert.rejects(f.controller.rotate(f.input("activate")), /trust state unavailable/);
  assert.equal(f.calls.slice(before).includes("admin.api.device.announce"), false); assert.equal(f.calls.includes("activate"), false);
  assert.equal(f.read().activation, undefined); assert.doesNotThrow(() => new RemotePairingController(f.options));
});
test("private saves refuse malformed generated state and clean its uncommitted candidate", async t => {
  const f = fixture(t); await f.controller.getTrust(f.input()); const before = readFileSync(f.options.trustFile, "utf8"); f.options.now = () => Number.NaN;
  await assert.rejects(f.controller.rotate(f.input("stage")), /trust state unavailable/); assert.equal(f.options.staged(), undefined);
  assert.equal(readFileSync(f.options.trustFile, "utf8"), before); assert.doesNotThrow(() => new RemotePairingController(f.options));
});
test("stage capacity refusal removes only the newly selected candidate and preserves existing history", async t => {
  const f = fixture(t), stored = validV2() as any, limit = 256 * 1024;
  stored.state.revoked = Array.from({ length: 2200 }, (_, i) => anchor(pin(`historic certificate ${i}`)));
  const count = Math.floor((limit - Buffer.byteLength(JSON.stringify(stored) + "\n")) / 53);
  stored.keys.retired = Array.from({ length: count }, (_, i) => pin(`historic key ${i}`));
  assert.ok(Buffer.byteLength(JSON.stringify(stored) + "\n") <= limit); f.write(stored);
  const before = readFileSync(f.options.trustFile, "utf8"), restarted = new RemotePairingController(f.options);
  await assert.rejects(restarted.rotate(f.input("stage")), /capacity/); assert.equal(f.options.staged(), undefined);
  assert.equal(readFileSync(f.options.trustFile, "utf8"), before); assert.equal(f.calls.includes("admin.api.device.announce"), false);
});
test("failed private save cleans an uncommitted candidate without rewriting existing history", { skip: process.platform === "win32" || typeof process.geteuid !== "function" }, async t => {
  const currentProcess = process; assertEffectiveUid(currentProcess);
  const f = fixture(t); await f.controller.getTrust(f.input()); const before = readFileSync(f.options.trustFile, "utf8"), stage = f.options.stage, uid = currentProcess.geteuid();
  let restore: (() => void) | undefined;
  f.options.stage = async () => { const candidate = await stage(), mocked = t.mock.method(currentProcess, "geteuid", () => uid + 1); restore = () => mocked.mock.restore(); return candidate; };
  await assert.rejects(f.controller.rotate(f.input("stage")), /untrusted-directory/); restore!();
  assert.equal(f.options.staged(), undefined); assert.equal(readFileSync(f.options.trustFile, "utf8"), before);
});
for (const phase of ["intent", "final"] as const) test(`${phase} envelope capacity includes the final newline at exactly 256 KiB`, () => {
  const a = material("A"), b = material("B");
  const stored: StoredTrust = phase === "intent"
    ? { version: 2, state: { current: { kind: "cert", pin: a.certPin }, revoked: [], phase: "staged", next: { kind: "cert", pin: b.certPin }, stagedAt: 1, acks: {} }, keys: { current: a.certSpkiPin, next: b.certSpkiPin, retired: [], unresolved: [] }, activation: { devices: [{ id: "offline", name: "" }], at: 2 } }
    : { version: 2, state: { current: { kind: "cert", pin: b.certPin }, revoked: [{ kind: "cert", pin: a.certPin }], phase: "switched", acks: {}, switchedAt: 2, repairIds: [""] }, keys: { current: b.certSpkiPin, retired: [a.certSpkiPin], unresolved: [] } };
  const padding = "a".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(stored) + "\n"));
  if (phase === "intent") (stored.activation!.devices[0] as { name: string }).name = padding;
  else (stored.state.repairIds as string[])[0] = padding;
  assert.doesNotThrow(() => assertTrustSize(stored));
  if (phase === "intent") (stored.activation!.devices[0] as { name: string }).name += "a";
  else (stored.state.repairIds as string[])[0] += "a";
  assert.throws(() => assertTrustSize(stored), /capacity/);
});

function renewedSameKey(pki: Pki, days: number) {
  return buildCertificate({ subject: { cn: "harness.corp.example" }, issuer: { cn: "Corp Issuing CA", o: "Corp" },
    publicKey: createPublicKey(pki.leafKey), signingKey: pki.interKey, notBefore: new Date(NOW.getTime() - DAY),
    notAfter: new Date(NOW.getTime() + days * DAY), dns: ["harness.corp.example"], ips: ["192.168.1.20"] }).pem;
}
async function companyFixture(t: TestContext) {
  const f = fixture(t), pki = makePki(), certs = new RemoteCertificates({ home: f.home, names: { hostnames: ["harness.corp.example"] }, now: () => NOW.getTime() });
  await certs.stageCompany({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }); certs.activateStaged();
  const options = { ...f.options, current: () => certs.current(), staged: () => certs.staged(), stage: async () => certs.staged()!,
    activate: async () => { certs.activateStaged(); }, cancelStage: async () => certs.cancelStaged() };
  const controller = new RemotePairingController(options);
  return { ...f, pki, certs, options, controller };
}
test("real company-CA retired candidate rejection clears next material so another certificate can upload", async t => {
  const f = await companyFixture(t), b = issueLeaf(f.pki);
  await f.certs.stageCompany({ certChainPem: b.leafPem + f.pki.interPem, keyPem: b.leafKeyPem, caPem: f.pki.rootPem });
  await f.controller.rotate(f.input("stage")); await f.controller.rotate(f.input("activate"));
  await f.certs.stageCompany({ certChainPem: f.pki.leafPem + f.pki.interPem, keyPem: f.pki.leafKeyPem, caPem: f.pki.rootPem });
  await assert.rejects(f.controller.rotate(f.input("stage"))); assert.equal(f.certs.staged() === undefined, true);
  const c = issueLeaf(f.pki); await f.certs.stageCompany({ certChainPem: c.leafPem + f.pki.interPem, keyPem: c.leafKeyPem, caPem: f.pki.rootPem });
  await f.controller.rotate(f.input("stage")); assert.equal(f.certs.staged()?.certPin, f.read().state.next.pin);
});
test("real current-key renewal stays allowed until that key departs, then reissued certificates are refused after restart", async t => {
  const f = await companyFixture(t), first = f.certs.current()!, renewal = renewedSameKey(f.pki, 365);
  await f.certs.stageCompany({ certChainPem: renewal + f.pki.interPem, keyPem: f.pki.leafKeyPem, caPem: f.pki.rootPem });
  assert.notEqual(f.certs.staged()?.certPin, first.certPin); assert.equal(spkiPin(renewal), spkiPin(first.cert));
  await f.controller.rotate(f.input("stage")); await f.controller.rotate(f.input("activate")); assert.equal(f.certs.current()?.certPin, f.read().state.current.pin);
  const b = issueLeaf(f.pki); await f.certs.stageCompany({ certChainPem: b.leafPem + f.pki.interPem, keyPem: b.leafKeyPem, caPem: f.pki.rootPem });
  await f.controller.rotate(f.input("stage")); await f.controller.rotate(f.input("activate"));
  const reissued = renewedSameKey(f.pki, 366); await f.certs.stageCompany({ certChainPem: reissued + f.pki.interPem, keyPem: f.pki.leafKeyPem, caPem: f.pki.rootPem });
  await assert.rejects(new RemotePairingController(f.options).rotate(f.input("stage"))); assert.equal(f.certs.staged() === undefined, true);
  assert.deepEqual(f.read().keys?.retired, [spkiPin(first.cert)]);
  const retirements = f.audit.events.filter(event => event.action === "device.trust.rotate" && event.detail?.retired);
  assert.equal(retirements.length, 2); assert.equal(retirements[0]!.detail.keyRetired, false); assert.equal(retirements[1]!.detail.keyRetired, true);
});

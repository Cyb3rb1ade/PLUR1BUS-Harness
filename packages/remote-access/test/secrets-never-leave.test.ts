// Step 13 of the server hardening sweep, the remote-access half: one pairing lives through every secret it handles (the pairing code,
// the key derived from it, the key that signs offers, the device's private key), and every output of the package is searched for them:
// return values, thrown errors, audit events, the snapshot of the code store and the device file on disk. The code may show only in the
// answers that issue it (the code itself, the offer, its link and QR text, and the client parsing that link). Nothing in this package
// is reachable over the API's routes (the pairing HTTP handler is a function the transport calls), so it is driven directly.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceError, DeviceStore } from "../src/device-store.ts";
import { pinOf } from "../src/fingerprint.ts";
import { PairCodeStore } from "../src/pair-code.ts";
import { createClientNonce, createProofLimiter, handlePairProof, verifyPairProof } from "../src/pair-proof.ts";
import { buildPairingOffer, encodePairingLink, parsePairingLink } from "../src/pairing.ts";

const cheapDerive = (code: string, salt: Uint8Array): Buffer => createHash("sha256").update("test-derive").update(code).update(salt).digest();
const ORIGIN = "https://192.168.1.20:18701";
const FP = pinOf(Buffer.from("the harness leaf certificate"));

function shapes(value: string | Uint8Array): string[] {
  const b = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  const s = typeof value === "string" ? value : b.toString("hex");
  return [...new Set([s, s.toLowerCase(), s.toUpperCase(), s.replaceAll("-", ""), encodeURIComponent(s), b.toString("base64"), b.toString("base64url"), b.toString("hex")])].filter((x) => x.length >= 8); // an 8-character code from a 32-letter alphabet cannot turn up by chance in a text of this size
}

test("secrets never leave the server (pairing): the code, the derived key, the signing key and the device's private key show only where they are issued", () => {
  const dir = mkdtempSync(join(tmpdir(), "p1b-secrets-")); let now = 1_700_000_000_000;
  try {
    const seen: Array<{ label: string; text: string; allow: readonly string[] }> = [];
    const secrets = new Map<string, string[]>();
    const note = (label: string, v: unknown, allow: readonly string[] = []): void => { seen.push({ label, text: typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)), allow }); };
    const attempt = <T>(label: string, fn: () => T, allow: readonly string[] = []): T | undefined => {
      try { const r = fn(); note(label, r, allow); return r; }
      catch (e) { note(`${label} (thrown)`, { name: (e as Error).name, message: (e as Error).message, code: (e as DeviceError).code, stack: (e as Error).stack }); return undefined; }
    };
    const events: unknown[] = [];
    const codes = new PairCodeStore({ derive: cheapDerive, maxCodeFailures: 1000, sourceMaxFailures: 1000 });
    const file = join(dir, "devices.json");
    const store = new DeviceStore({ file, clock: () => now, audit: { append: (e) => { events.push(e); } }, securePath: () => {} });
    const device = generateKeyPairSync("ed25519"); const other = generateKeyPairSync("ed25519");
    const publicKey = device.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const input = { name: "Phone", platform: "ios", publicKey, pairedBy: "alice", scope: ["agent.read"] };
    const signKey = Buffer.from("offer-signing-key-of-this-test!!"); // 32 fixed bytes, no documentation example
    secrets.set("signing key", shapes(signKey));
    secrets.set("device private key", [device.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), device.privateKey.export({ format: "pem", type: "pkcs8" }) as string, String(device.privateKey.export({ format: "jwk" }).d)]);

    // 1. issuing: the code, an offer, its link and QR text
    const issued = codes.issue(now); secrets.set("code", shapes(issued.code)); note("issue", issued, ["code"]);
    const built = buildPairingOffer({ store: codes, now, publish: "network", tls: "self-signed", origins: [ORIGIN], certPin: FP, signKey });
    assert.equal(built.ok, true); if (!built.ok) return;
    const offerCode = built.offer.code; secrets.set("offer code", shapes(offerCode)); note("offer", built, ["code", "offer code"]);
    const link = encodePairingLink(built.offer); note("link", link, ["code", "offer code"]);
    attempt("parse own link", () => parsePairingLink(link), ["code", "offer code"]);
    for (const opened of codes.open(now)) { secrets.set(`derived key ${opened.id}`, shapes(opened.key)); }
    assert.equal(secrets.size >= 5, true);

    // 2. the proof exchange, honest and hostile
    const limiter = createProofLimiter({ perSourceMax: 1000, perCodeMax: 1000 }); const ctx = { store: codes, now, origin: ORIGIN, servedFingerprint: FP, source: "192.168.1.77", limiter };
    const clientNonce = createClientNonce(); const proof = attempt("pair-proof", () => handlePairProof({ clientNonce }, ctx)); assert.equal(proof?.status, 200);
    if (proof?.status === 200) attempt("verify", () => verifyPairProof({ code: issued.code, response: proof.body, fingerprintSeen: FP, origin: ORIGIN, clientNonce, derive: cheapDerive }));
    for (const body of [{ clientNonce, code: issued.code }, { code: issued.code }, { clientNonce: issued.code }, [issued.code], issued.code, null]) attempt(`pair-proof with ${typeof body}`, () => handlePairProof(body, ctx));
    if (proof?.status === 200) attempt("verify with a wrong code", () => verifyPairProof({ code: "ABCD-EFGH", response: proof.body, fingerprintSeen: FP, origin: ORIGIN, clientNonce, derive: cheapDerive }));

    // 3. refused pairings: wrong code, the code in a field it does not belong in, then the right one, then a replay
    attempt("pair with a wrong code", () => store.pair(codes, "ABCD-EFGH", input, "192.168.1.77"));
    attempt("pair with the code as the name", () => store.pair(codes, issued.code, { ...input, name: "x".repeat(300) }, "192.168.1.77"));
    attempt("pair with garbage key", () => store.pair(codes, issued.code, { ...input, publicKey: `not-a-key-${issued.code}` }, "192.168.1.77"));
    const paired = attempt("pair", () => store.pair(codes, issued.code, input, "192.168.1.77")); assert.ok(paired);
    attempt("pair replay", () => store.pair(codes, issued.code, input, "192.168.1.78"));
    attempt("redeem replay", () => codes.redeem(issued.code, now, "192.168.1.79"));
    attempt("redeem hostile", () => codes.redeem(offerCode, now, "192.168.1.80"));
    // a link with a wrong tag still parses: the client reads the code it was handed, and the tag is checked later by the harness
    attempt("parse a damaged link", () => parsePairingLink(link.replace(/tag=[^&]*/, "tag=AAAAAAAAAAAAAAAAAAAAAA")), ["code", "offer code"]);
    attempt("parse a link with a second code", () => parsePairingLink(`${link}&code=${encodeURIComponent(issued.code)}`));

    // 4. the device connects (and a stranger does not), is listed, renamed and revoked
    now += 5000; const challenge = store.challenge(); const good = sign(null, challenge, device.privateKey);
    let closed = 0; attempt("connect", () => { store.connect({ publicKey, challenge, signature: good, close: () => { closed++; } }); return "connected"; });
    const c2 = store.challenge(); attempt("connect with a stranger's signature", () => store.connect({ publicKey, challenge: c2, signature: sign(null, c2, other.privateKey), close: () => {} }));
    attempt("connect replay", () => store.connect({ publicKey, challenge, signature: good, close: () => {} }));
    attempt("list", () => store.list()); attempt("get", () => store.get(paired!.id)); attempt("rename", () => store.rename(paired!.id, "Phone 2", "alice"));
    attempt("revoke", () => store.revoke(paired!.id, "alice")); assert.equal(closed, 1);
    const c3 = store.challenge(); attempt("connect after revoke", () => store.connect({ publicKey, challenge: c3, signature: sign(null, c3, device.privateKey), close: () => {} }));
    attempt("pair the revoked key again", () => store.recordPairing(input));

    // 5. what was written down
    note("audit events", events); note("device file", readFileSync(file, "utf8")); note("code store snapshot", codes.snapshot(now));
    note("a second store reading the file", new DeviceStore({ file, clock: () => now, audit: { append: () => {} }, securePath: () => {} }).list());

    const leaks: string[] = [];
    const scan = (label: string, text: string, allow: readonly string[]): void => {
      for (const [name, forms] of secrets) {
        if (allow.includes(name)) continue;
        if (forms.some((f) => f.length > 0 && text.includes(f))) leaks.push(`${name} in ${label}`);
      }
    };
    for (const s of seen) scan(s.label, s.text, s.allow);
    assert.deepEqual([...new Set(leaks)], [], `a secret left the package: ${[...new Set(leaks)].join("; ")}`);

    // the check has teeth, and the run was a real one
    for (const [label, name] of [["issue", "code"], ["offer", "signing key"], ["link", "code"]] as const) {
      const entry = seen.find((s) => s.label === label)!; const before = leaks.length;
      scan(label, name === "signing key" ? entry.text + signKey.toString("hex") : entry.text, []); assert.ok(leaks.length > before, `the scan did not see ${name} in ${label}`);
    }
    assert.ok(seen.length >= 30, `${seen.length} outputs`); assert.ok(seen.some((s) => s.label.endsWith("(thrown)")), "no refusal was observed");
    assert.deepEqual((events as Array<{ action: string }>).map((e) => e.action), ["device.paired", "device.renamed", "device.revoked"], "the audit events of the pairing are there");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The checks of the P4-20 secret-store run (p4-20-secrets.ts); the run itself needs the built front door and is part
// of the nightly parity step.
import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";
import { auditLine, auditLines, FIRST, holding, LEGS, normalised, OTHER, SECOND, VARIANTS, WITNESS, witnessFindings, type Witness } from "./p4-20-secrets.ts";

const [typescript, owning, kept] = LEGS as [typeof LEGS[number], typeof LEGS[number], typeof LEGS[number]];

test("an answer is compared without its request id, the home's path, times and uuids", () => {
  const reply = { jsonrpc: "2.0", id: 7, result: { name: "n", createdAt: "2026-11-15T21:49:46.123Z", updatedAt: "2026-11-15T21:49:47Z", dir: "/tmp/home-1/state/secrets", id: "0b0f6f0e-7c1d-4a55-9d0e-0123456789ab" } };
  assert.deepEqual(normalised(reply, ["/private/tmp/home-1", "/tmp/home-1"]), { result: { name: "n", createdAt: "<time>", updatedAt: "<time>", dir: "<home>/state/secrets", id: "<uuid>" } });
  // An error is compared whole: code, message and data. A value in an answer stays what it is.
  const refused = { jsonrpc: "2.0", id: 8, error: { code: -32000, message: "no secret named n", data: { error: "E_NOT_FOUND", reason: "not-found" } } };
  assert.deepEqual(normalised(refused, []), { error: refused.error });
  assert.deepEqual(normalised({ id: 9, result: { value: FIRST } }, []), { result: { value: FIRST } });
});

test("an audit line is compared without its time and its lease id, and with everything else", () => {
  const line = JSON.stringify({ at: 1794779324073, actor: { user: "core", host: "h" }, action: "secret.lease.revoke", target: null, detail: { leaseId: "0b0f6f0e7c1d" } });
  assert.deepEqual(auditLine(line), { at: "<at>", actor: { user: "core", host: "h" }, action: "secret.lease.revoke", target: null, detail: { leaseId: "<lease>" } });
  const other = JSON.stringify({ at: 2, actor: { user: "core", host: "h" }, action: "secret.lease", target: "n", detail: { purpose: "p", profileId: "core", ttlMs: 5000 } });
  assert.deepEqual(auditLine(other), { ...JSON.parse(other), at: "<at>" });
});

test("the witness's audit lines are counted, not compared", () => {
  const mine = JSON.stringify({ at: 1, actor: { user: "local-owner", host: "h" }, action: "secret.list", target: null, detail: { backend: "keyring" } });
  const its = JSON.stringify({ at: 2, actor: { user: WITNESS, host: "h" }, action: "secret.list", target: null, detail: { backend: "keyring" } });
  const read = auditLines(`${mine}\n${its}\n\n${mine}\n`);
  assert.equal(read.own.length, 2);
  assert.equal(read.witness, 1);
  assert.deepEqual(auditLines(""), { own: [], witness: 0 });
});

test("each leg has its own picture of who holds the store", () => {
  const answered: Witness = { listening: true, names: ["agent.export-signing.v1", "parity.other", "parity.short"] };
  const absent: Witness = { listening: false };
  assert.deepEqual(witnessFindings(owning, answered, 1), []);
  assert.deepEqual(witnessFindings(typescript, absent, 0), []);
  assert.deepEqual(witnessFindings(kept, absent, 0), []);
  // The front door does not hold the store although it should, or holds another one than the TypeScript core wrote to.
  assert.match(witnessFindings(owning, absent, 0).join("; "), /nothing listens at the bridge's address/);
  assert.match(witnessFindings(owning, { listening: true, error: { code: -32000 } }, 0).join("; "), /the bridge refused the witness/);
  assert.match(witnessFindings(owning, { listening: true, names: ["parity.short"] }, 1).join("; "), /did not go through the front door's store/);
  assert.match(witnessFindings(owning, { listening: true, names: ["parity.other", "parity.secrets"] }, 1).join("; "), /after its deletion/);
  assert.match(witnessFindings(owning, answered, 0).join("; "), /0 audit lines of the witness, expected 1/);
  // A bridge where the store is the TypeScript core's.
  assert.match(witnessFindings(kept, answered, 0).join("; "), /something listens at the bridge's address/);
  assert.match(witnessFindings(typescript, absent, 1).join("; "), /never reached a store/);
});

test("the legs and the variants are the ones the run is described with", () => {
  assert.deepEqual(LEGS.map((l) => [l.impl, l.holder, l.env ?? null]), [["ts", "typescript", null], ["rust", "front-door", null], ["rust", "typescript", { PLUR1BUS_P4_SECRETS: "ts" }]]);
  // No variant reaches a real keyring: the seam is always set, to the stand-in or to off.
  for (const v of VARIANTS) assert.ok(["memory", "off"].includes(v.env.PLUR1BUS_SECRETS_KEYRING ?? ""), v.name);
  const file = VARIANTS.find((v) => v.env.PLUR1BUS_SECRETS_KEYRING === "off")!;
  const cfg: any = { secrets: { fileFallback: { enabled: false } } };
  file.config!(cfg);
  assert.equal(cfg.secrets.fileFallback.enabled, true);
  assert.equal(VARIANTS.find((v) => v.home)!.home!("/tmp/home-1"), `/tmp/home-1${sep}`);
  assert.deepEqual(holding([["a", `x ${FIRST} y`], ["b", "nothing"], ["c", SECOND], ["d", OTHER]]), ["a", "c", "d"]);
});

// The checks of the P4-20 secret-store run (p4-20-secrets.ts); the run itself needs the built front door and is part
// of the nightly parity step.
import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";
import { auditLine, auditLines, ENGINE_METHOD, FIRST, holding, LEGS, NATIVE_SECRET_METHODS, normalised, OTHER, recordingFacts, recordingFindings, SECOND, VARIANTS, WITNESS, witnessFindings, type Witness } from "./p4-20-secrets.ts";

type OneLeg = typeof LEGS[number];
const [typescript, owning, relayed, kept] = LEGS as [OneLeg, OneLeg, OneLeg, OneLeg];

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
  // Who answers the caller changes nothing about who holds the store.
  assert.deepEqual(witnessFindings(relayed, answered, 1), []);
  assert.match(witnessFindings(relayed, absent, 0).join("; "), /nothing listens at the bridge's address/);
  assert.deepEqual(witnessFindings(typescript, absent, 0), []);
  assert.deepEqual(witnessFindings(kept, absent, 0), []);
  // The front door does not hold the store although it should, or holds another one than the TypeScript core wrote to.
  assert.match(witnessFindings(owning, absent, 0).join("; "), /nothing listens at the bridge's address/);
  assert.match(witnessFindings(owning, { listening: true, error: { code: -32000 } }, 0).join("; "), /the bridge refused the witness/);
  assert.match(witnessFindings(owning, { listening: true, names: ["parity.short"] }, 1).join("; "), /did not reach the front door's store/);
  assert.match(witnessFindings(owning, { listening: true, names: ["parity.other", "parity.secrets"] }, 1).join("; "), /after its deletion/);
  assert.match(witnessFindings(owning, answered, 0).join("; "), /0 audit lines of the witness, expected 1/);
  // A bridge where the store is the TypeScript core's.
  assert.match(witnessFindings(kept, answered, 0).join("; "), /something listens at the bridge's address/);
  assert.match(witnessFindings(typescript, absent, 1).join("; "), /never reached a store/);
});

test("the legs and the variants are the ones the run is described with", () => {
  assert.deepEqual(LEGS.map((l) => [l.impl, l.holder, l.answers, l.env ?? null]), [
    ["ts", "typescript", "typescript", null],
    ["rust", "front-door", "front-door", null],
    ["rust", "front-door", "typescript", { PLUR1BUS_P4_IDENTITY: "ts" }],
    ["rust", "typescript", "typescript", { PLUR1BUS_P4_SECRETS: "ts" }],
  ]);
  assert.deepEqual([...NATIVE_SECRET_METHODS].sort(), ["secret.delete", "secret.describe", "secret.get", "secret.list", "secret.set", "secret.status"]);
  // No variant reaches a real keyring: the seam is always set, to the stand-in or to off.
  for (const v of VARIANTS) assert.ok(["memory", "off"].includes(v.env.PLUR1BUS_SECRETS_KEYRING ?? ""), v.name);
  const file = VARIANTS.find((v) => v.env.PLUR1BUS_SECRETS_KEYRING === "off")!;
  const cfg: any = { secrets: { fileFallback: { enabled: false } } };
  file.config!(cfg);
  assert.equal(cfg.secrets.fileFallback.enabled, true);
  assert.equal(VARIANTS.find((v) => v.home)!.home!("/tmp/home-1"), `/tmp/home-1${sep}`);
  assert.deepEqual(holding([["a", `x ${FIRST} y`], ["b", "nothing"], ["c", SECOND], ["d", OTHER]]), ["a", "c", "d"]);
});

test("the recording says who answered the caller and what the TypeScript core was told", () => {
  const masked = "[REDACTED:secret]";
  const line = (conn: number, dir: "in" | "out", msg: unknown) => JSON.stringify({ file: "core.jsonl", conn, dir, msg });
  const sent = { "secret.set": 1, "secret.get": 2, "secret.grants.list": 1 };
  // The TypeScript core answered: it read every request, was told nothing, and a value is in the answer to a get only.
  const answeredThere = recordingFacts([
    line(1, "in", { id: 1, method: "secret.set", params: { name: "n", value: masked } }),
    line(1, "out", { id: 1, result: { name: "n" } }),
    line(1, "in", { id: 2, method: "secret.get", params: { name: "n", reveal: true } }),
    line(1, "out", { id: 2, result: { secret: { name: "n" }, value: FIRST } }),
    line(1, "in", { id: 3, method: "secret.get", params: { name: "n" } }),
    line(1, "out", { id: 3, result: { secret: { name: "n" } } }),
    line(2, "in", { id: 1, method: "secret.grants.list", params: {} }),
    "",
  ]);
  assert.deepEqual(answeredThere, { read: { "secret.set": 1, "secret.get": 2, "secret.grants.list": 1 }, told: 0, toldByName: 0, toldOpen: 0, framesWithValues: 0 });
  for (const leg of [typescript, relayed, kept]) assert.deepEqual(recordingFindings(leg, answeredThere, sent), [], leg.name);
  const relayedAfterAll = recordingFindings(owning, answeredThere, sent).join("; ");
  assert.match(relayedAfterAll, /2 secret\.get requests reached the TypeScript core/);
  assert.match(relayedAfterAll, /told of 0 changes by name, at least 5 expected/);
  // The front door answered: the six methods never reach the TypeScript core, which is told of each change instead.
  const told = (id: number, params: unknown) => line(3, "in", { id, method: "legacy.secret.changed", params });
  const answeredHere = recordingFacts([
    told(1, {}),
    ...[2, 3, 4, 5, 6].map((id) => told(id, { name: `n${id}`, secret: masked })),
    told(7, { name: "gone" }),
    line(2, "in", { id: 1, method: "secret.grants.list", params: {} }),
  ]);
  assert.deepEqual(answeredHere, { read: { "secret.grants.list": 1 }, told: 7, toldByName: 6, toldOpen: 0, framesWithValues: 0 });
  assert.deepEqual(recordingFindings(owning, answeredHere, sent), []);
  const notItsOwn = recordingFindings(relayed, answeredHere, sent).join("; ");
  assert.match(notItsOwn, /read 0 secret\.get requests, expected 2/);
  assert.match(notItsOwn, /told of 7 changes, but it made them itself/);
  // The engine's method: the front door answers the engine's calls and relays the owner's; on the other legs the
  // TypeScript core reads them all. The value is in its answer, as in the answer to a get, and nowhere else.
  const hostSent = { [ENGINE_METHOD]: 4 };
  const byEngine = { [ENGINE_METHOD]: 3 };
  const engineThere = recordingFacts([
    ...[1, 2, 3].flatMap((id) => [line(4, "in", { id, method: ENGINE_METHOD, params: { name: "n" } }), line(4, "out", { id, result: { value: SECOND } })]),
    line(1, "in", { id: 9, method: ENGINE_METHOD, params: { name: "n" } }),
    line(1, "out", { id: 9, error: { code: -32000, message: "engine principal required", data: { error: "E_DENIED", reason: "engine-principal-required" } } }),
  ]);
  assert.deepEqual([engineThere.read, engineThere.framesWithValues], [{ [ENGINE_METHOD]: 4 }, 0]);
  for (const leg of [typescript, relayed, kept]) assert.deepEqual(recordingFindings(leg, engineThere, hostSent, byEngine).filter((f) => f.includes(ENGINE_METHOD)), [], leg.name);
  assert.match(recordingFindings(owning, engineThere, hostSent, byEngine).join("; "), /4 host\.secret\.get requests reached the TypeScript core, expected 1 \(the owner's\)/);
  const engineHere = recordingFacts([line(1, "in", { id: 9, method: ENGINE_METHOD, params: { name: "n" } })]);
  assert.deepEqual(recordingFindings(owning, engineHere, hostSent, byEngine).filter((f) => f.includes(ENGINE_METHOD)), []);
  assert.match(recordingFindings(relayed, engineHere, hostSent, byEngine).join("; "), /read 1 host\.secret\.get requests, expected 4/);
  // One of the six methods on the engine's connection is not the front door's to answer: it reaches the TypeScript
  // core on the native leg too, and only that one does.
  const statusByEngine = recordingFacts([line(4, "in", { id: 5, method: "secret.status", params: {} })]);
  assert.deepEqual(recordingFindings(owning, { ...statusByEngine, toldByName: 5 }, { "secret.status": 3 }, { "secret.status": 1 }), []);
  assert.match(recordingFindings(owning, { ...statusByEngine, toldByName: 5 }, { "secret.status": 3 }).join("; "), /1 secret\.status requests reached the TypeScript core; the front door relayed them/);
  // An answer of another connection or another id is no answer to that call.
  const stray = recordingFacts([line(4, "in", { id: 1, method: ENGINE_METHOD, params: { name: "n" } }), line(5, "out", { id: 1, result: { value: SECOND } })]);
  assert.equal(stray.framesWithValues, 1);
  // A value written down as it came, in the notice or anywhere that is no answer to a get.
  const open = recordingFacts([told(1, { name: "n", secret: FIRST }), line(1, "out", { id: 9, result: { note: SECOND } })]);
  assert.deepEqual([open.toldOpen, open.framesWithValues], [1, 2]);
  const written = recordingFindings(owning, open, {}).join("; ");
  assert.match(written, /1 legacy\.secret\.changed requests were recorded with their value/);
  assert.match(written, /2 recorded frames hold a value/);
});

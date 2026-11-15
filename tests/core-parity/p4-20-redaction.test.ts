// The checks of the P4-20 redaction run (p4-20-redaction.ts); the run itself needs the built front door and is part of
// the nightly parity step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../../packages/module-api/src/parity-recorder.ts";
import { FIRST, holding, LEGS, NEVER, normalised, PLANTED, recordingFacts, recordingFindings, SECOND, type RecordingFacts } from "./p4-20-redaction.ts";

const frame = (conn: number, dir: "in" | "out", msg: unknown): string => JSON.stringify({ file: "rpc.ndjson", seq: 0, conn, dir, msg });
const [typescript, native, relayed] = LEGS as [typeof LEGS[number], typeof LEGS[number], typeof LEGS[number]];

test("an answer is compared without its request id, the home's path and the bytes that were read", () => {
  const reply = { jsonrpc: "2.0", id: 7, result: { records: [{ file: "/tmp/home-1/logs/planted.log" }], scanned: { bytes: 4160, files: 2 }, corrupt: 0 } };
  assert.deepEqual(normalised(reply, ["/private/tmp/home-1", "/tmp/home-1"]), { result: { records: [{ file: "<home>/logs/planted.log" }], scanned: { bytes: "<bytes>", files: 2 }, corrupt: 0 } });
  // An error is compared whole: code, message and data.
  const refused = { jsonrpc: "2.0", id: 8, error: { code: -32000, message: "bad", data: { error: "E_INVALID_PARAMS", reason: "bad-timestamp" } } };
  assert.deepEqual(normalised(refused, []), { error: refused.error });
});

test("the planted lines hold both values and the words that never are a secret", () => {
  const lines = PLANTED.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].msg.includes(FIRST) && lines[0].msg.includes(SECOND) && lines[0].msg.includes(NEVER));
  assert.ok(lines[1].msg.includes(SECOND) && !lines[1].msg.includes(FIRST));
  assert.deepEqual(holding([["a", `x ${FIRST} y`], ["b", NEVER], ["c", SECOND]]), ["a", "c"]);
});

test("a recording says who read the queries and how the feed was written down", () => {
  const changes = { epoch: "1", next: 1, secrets: [{ secret: FIRST, pinned: true }], more: false };
  const lines = [
    frame(0, "in", { id: "fd-1", method: "legacy.redaction.changes", params: { epoch: "", after: 0, waitMs: 0, maxBytes: 1 } }),
    // What the recorder writes for the answer: the member named like a secret is replaced whole.
    frame(0, "out", { id: "fd-1", result: redactSecrets(changes) }),
    frame(1, "in", { id: 2, method: "logs.query", params: { text: FIRST } }),
    frame(1, "out", { id: 2, result: { records: [{ record: { msg: `said ${FIRST}` } }] } }),
    frame(1, "in", { id: 3, method: "secret.set", params: { name: "n", value: "[REDACTED:secret]" } }),
    frame(1, "out", { id: 3, result: { name: "n" } }),
    "",
  ];
  assert.deepEqual(recordingFacts(lines), { queries: 1, feedCalls: 1, feedAnswersMasked: 1, feedAnswersOpen: 0, framesWithValues: 0 });
  // The same id on another connection is another exchange; a feed answer written as it was sent is counted as open,
  // and so is every other frame with a value.
  const open = [
    frame(0, "in", { id: "fd-1", method: "legacy.redaction.changes", params: {} }),
    frame(0, "out", { id: "fd-1", result: changes }),
    frame(2, "out", { id: 2, result: { echo: SECOND } }),
    frame(1, "in", { id: 3, method: "secret.set", params: { name: "n", value: FIRST } }),
  ];
  assert.deepEqual(recordingFacts(open), { queries: 0, feedCalls: 1, feedAnswersMasked: 0, feedAnswersOpen: 1, framesWithValues: 3 });
  // A feed call that failed is no answer of either kind.
  const failed = [frame(0, "in", { id: 1, method: "legacy.redaction.changes", params: {} }), frame(0, "out", { id: 1, error: { code: -32000 } })];
  assert.deepEqual(recordingFacts(failed), { queries: 0, feedCalls: 1, feedAnswersMasked: 0, feedAnswersOpen: 0, framesWithValues: 0 });
});

test("each leg has its own picture of a sound recording", () => {
  const facts = (over: Partial<RecordingFacts>): RecordingFacts => ({ queries: 0, feedCalls: 0, feedAnswersMasked: 0, feedAnswersOpen: 0, framesWithValues: 0, ...over });
  assert.deepEqual(recordingFindings(typescript, facts({ queries: 17 }), 17), []);
  assert.deepEqual(recordingFindings(native, facts({ feedCalls: 20, feedAnswersMasked: 20 }), 17), []);
  assert.deepEqual(recordingFindings(relayed, facts({ queries: 17, feedCalls: 5, feedAnswersMasked: 5 }), 17), []);
  // The native leg relayed a query; the other legs lost one.
  assert.match(recordingFindings(native, facts({ queries: 1, feedCalls: 20, feedAnswersMasked: 20 }), 17).join("; "), /front door relayed/);
  assert.match(recordingFindings(relayed, facts({ queries: 16, feedCalls: 5, feedAnswersMasked: 5 }), 17).join("; "), /read 16 logs\.query requests, expected 17/);
  assert.match(recordingFindings(typescript, facts({ queries: 17, feedCalls: 1 }), 17).join("; "), /without a front door/);
  // A front door that does not follow the feed, or asks it in a loop.
  assert.match(recordingFindings(native, facts({ feedCalls: 1, feedAnswersMasked: 1 }), 17).join("; "), /did not follow the feed/);
  assert.match(recordingFindings(relayed, facts({ queries: 17, feedCalls: 26, feedAnswersMasked: 26 }), 17).join("; "), /asked the feed 26 times/);
  assert.deepEqual(recordingFindings(native, facts({ feedCalls: 42, feedAnswersMasked: 42 }), 17), [], "a catch-up before every native query is expected");
  assert.match(recordingFindings(native, facts({ feedCalls: 43, feedAnswersMasked: 43 }), 17).join("; "), /asked the feed 43 times/);
  // A value written down.
  assert.match(recordingFindings(native, facts({ feedCalls: 20, feedAnswersMasked: 19, feedAnswersOpen: 1 }), 17).join("; "), /without the placeholder/);
  assert.match(recordingFindings(typescript, facts({ queries: 17, framesWithValues: 2 }), 17).join("; "), /2 recorded frames hold a value/);
});

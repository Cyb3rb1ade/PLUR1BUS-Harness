// RE-05/T1 recorder. Run through record.mjs --keys, or this file with --keys.
// All transitive non-builtin imports are verified against the pinned Git blobs BEFORE import.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const engine = process.env.PLUR1BUS_ENGINE_SRC;
const repository = process.env.PLUR1BUS_ENGINE_GIT;
if (!engine || !repository) throw new Error("PLUR1BUS_ENGINE_SRC and PLUR1BUS_ENGINE_GIT are required");
if (process.version !== "v24.21.0") throw new Error("Recorder requires Node v24.21.0");
const files = ["engine/capture/turn-replay-guard.js", "lib/abort.js", "lib/sql-safety.js", "lib/log-redact.js"];
const hashes = {};
for (const relative of files) {
  const pinned = execFileSync("git", ["-C", repository, "show", `${PIN}:${relative}`]);
  const actual = readFileSync(join(engine, relative));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (sha256(pinned) !== sha256(actual)) throw new Error(`Pinned source hash mismatch: ${relative}`);
  hashes[relative] = sha256(actual);
}
const { createTurnReplayGuard, turnKeyOf, REPLAY_GUARD_MAX_ENTRIES, REPLAY_GUARD_TTL_MS } =
  await import(pathToFileURL(join(engine, files[0])));
const provenance = { engine: "node", commit: PIN, node: process.version, flags: ["--keys"],
  sourcesSha256: hashes, disabledOptions: [], normalization: "none: persisted strings are raw Node bytes; key parts use UTF-16 units" };
const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const keyTurns = [
  { agentId: "fixture", messages: [] },
  { agentId: "fixture", runId: "", sessionKey: "", messages: [] },
  { agentId: "fixture", runId: "run-1", sessionKey: "session-1", messages: [{ role: "user", content: "Synthetic fact." }] },
  { agentId: "fixture", runId: "run-2", sessionKey: "session-1", messages: [{ role: "user", content: "Synthetic fact." }] },
  { agentId: "fixture", sessionKey: "other", messages: [{ role: "assistant", content: "Synthetic fact." }] },
  { agentId: "fixture", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
  { agentId: "fixture", messages: [{ role: "assistant", content: "b" }, { role: "user", content: "a" }] },
  { agentId: "Agent.alpha:_-0", messages: [{ role: "user", content: "🚀 Müller Mu\u0308ller" }] },
  { agentId: "fixture", runId: "quote\"\\\n", messages: [{ role: "user", content: "\u0000\t\r\n\"\\" }] },
  { agentId: "fixture", messages: [{ role: "user", content: "x\ud83d" }] },
];
const keys = keyTurns.map((turn, index) => {
  const material = JSON.stringify([turn.agentId, turn.runId ?? null, turn.sessionKey ?? null,
    turn.messages.map((message) => [message.role, message.content])]);
  return { name: `key-${index + 1}`, agent: units(turn.agentId), run: turn.runId == null ? null : units(turn.runId),
    session: turn.sessionKey == null ? null : units(turn.sessionKey),
    messages: turn.messages.map((message) => [units(message.role), units(message.content)]),
    material, materialUtf16: units(material), hash: turnKeyOf(turn) };
});

const temporary = mkdtempSync(join(tmpdir(), "ca-replay-record-"));
const success = () => ({ stored: 1, skipped: 0 });
const incomplete = () => ({ stored: 0, skipped: 1, reason: "aborted" });
const A = "11111111-1111-1111-1111-111111111111";
const B = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const C = "33333333-3333-3333-3333-333333333333";
const scenarios = [];
function fixture(name, seed) {
  const root = join(temporary, name);
  mkdirSync(root, { recursive: true });
  const agent = "Agent.alpha:_-0";
  const file = join(root, `${encodeURIComponent(agent)}.json`);
  if (seed !== undefined) writeFileSync(file, seed);
  let now = 1000;
  const warnings = [];
  const options = { root, clock: () => now, logger: { warn: () => warnings.push("warning") } };
  let guard = createTurnReplayGuard(options);
  const steps = [];
  return { name, seed, agent, steps, async run(key, actions = [], result = success(), at = now) {
    now = at;
    let called = false;
    let stale = null;
    const value = await guard.run(agent, key, async (settled, pending) => {
      called = true;
      stale = [...pending.staleRowIds];
      for (const action of actions) {
        if (action.kind === "planned") pending.onRowsPlanned(action.ids ?? [
          ...Array(action.count).fill(action.repeated), ...action.tail]);
        else if (action.kind === "settled") settled();
        else if (action.kind === "kept") pending.onRowsKept();
      }
      return result;
    });
    let raw = null;
    try { raw = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    steps.push({ kind: "run", key, actions, result, at, called, stale, rawResult: JSON.stringify(value), raw,
      warnings: warnings.length });
  }, reopen() { guard = createTurnReplayGuard(options); steps.push({ kind: "reopen" }); } };
}
try {
  const done = fixture("done-replay");
  await done.run("same"); await done.run("same"); done.reopen(); await done.run("same"); scenarios.push(done);
  const failed = fixture("failed-retry");
  await failed.run("same", [], incomplete()); await failed.run("same"); scenarios.push(failed);
  const settled = fixture("settled-before-late-failure");
  await settled.run("same", [{ kind: "settled" }, { kind: "planned", ids: [A] }, { kind: "kept" }], incomplete());
  await settled.run("same"); scenarios.push(settled);
  const pending = fixture("pending-reopen-cleanup");
  await pending.run("same", [{ kind: "planned", ids: [A, "invalid", A, B] }], incomplete());
  pending.reopen();
  await pending.run("same", [{ kind: "planned", ids: [B, C] }], incomplete());
  pending.reopen(); await pending.run("same", [{ kind: "settled" }]); scenarios.push(pending);
  const kept = fixture("partial-rows-kept");
  await kept.run("same", [{ kind: "planned", ids: [A] }, { kind: "kept" }], incomplete());
  kept.reopen(); await kept.run("same"); scenarios.push(kept);
  const ttl = fixture("ttl-inclusive");
  await ttl.run("same"); await ttl.run("same", [], success(), 1000 + REPLAY_GUARD_TTL_MS);
  await ttl.run("same", [], success(), 1001 + REPLAY_GUARD_TTL_MS); scenarios.push(ttl);
  const corrupt = fixture("corrupt-fail-open", "{broken");
  await corrupt.run("same", [], incomplete()); await corrupt.run("same"); scenarios.push(corrupt);
  const filtered = fixture("loaded-entry-filtering", JSON.stringify({ v: 1, entries: [
    null, { key: 2, at: 1000 }, { key: "bad-at", at: "1000" },
    { key: "same", at: 1000, pending: [A, "invalid", B, A] }, { key: "future", at: 2000 },
  ] }));
  await filtered.run("same", [{ kind: "planned", ids: [C, A] }], incomplete());
  await filtered.run("future"); scenarios.push(filtered);
  const numbers = fixture("number-and-utf16-state", '{"v":1.0,"entries":[{"key":"fraction","at":0.125},{"key":"exponent","at":1e30},{"key":"small","at":1e-7},{"key":"surrogate\\ud83d","at":1000},{"key":"negative-zero","at":-0},{"key":"duplicate","at":10,"at":1000}]}');
  await numbers.run("new"); scenarios.push(numbers);
  const capSeed = JSON.stringify({ v: 1, entries: Array.from({ length: REPLAY_GUARD_MAX_ENTRIES },
    (_, index) => ({ key: `key-${index}`, at: 1000 })) });
  const cap = fixture("entry-cap", capSeed);
  await cap.run("new"); await cap.run("key-0"); scenarios.push(cap);
  const capped = fixture("pending-id-cap");
  await capped.run("same", [{ kind: "planned", repeated: A, count: 10000, tail: [B] }], incomplete());
  capped.reopen(); await capped.run("same", [{ kind: "kept" }], incomplete()); scenarios.push(capped);

  const flightRoot = join(temporary, "flights");
  const guard = createTurnReplayGuard({ root: flightRoot, clock: () => 1000 });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const leader = guard.run("fixture", "flight", async () => { await blocked; return success(); });
  const abort = new AbortController();
  let followerCalled = false;
  const follower = guard.run("fixture", "flight", async () => { followerCalled = true; return success(); }, { signal: abort.signal });
  abort.abort();
  const cancelled = await follower;
  release();
  const completed = await leader;
  const duplicate = await guard.run("fixture", "flight", async () => success());
  const alreadyAborted = await guard.run("fixture", "new-flight", async () => success(), { signal: abort.signal });
  let lateSettled;
  const beforeLate = await guard.run("fixture", "late-flight", async (settled) => {
    lateSettled = settled; return { stored: 0, skipped: 1, reason: "timeout" };
  });
  lateSettled();
  const afterLate = await guard.run("fixture", "late-flight", async () => success());
  let releaseFailure;
  const failedLeader = guard.run("fixture", "failed-flight", async () => {
    await new Promise((resolve) => { releaseFailure = resolve; }); return incomplete();
  });
  let takeoverCalls = 0;
  const takeover = () => guard.run("fixture", "failed-flight", async () => { takeoverCalls += 1; return success(); });
  const waiters = [takeover(), takeover()];
  releaseFailure();
  await failedLeader;
  const takeoverResults = await Promise.all(waiters);
  const unwritable = join(temporary, "root-is-file");
  writeFileSync(unwritable, "fixture");
  let writeWarnings = 0;
  const writeGuard = createTurnReplayGuard({ root: unwritable, clock: () => 1000,
    logger: { warn: () => { writeWarnings += 1; } } });
  const writeFirst = await writeGuard.run("fixture", "same", async () => success());
  const writeDuplicate = await writeGuard.run("fixture", "same", async () => success());
  const concurrency = { followerCalled, cancelled: JSON.stringify(cancelled), completed: JSON.stringify(completed),
    duplicate: JSON.stringify(duplicate), alreadyAborted: JSON.stringify(alreadyAborted),
    beforeLate: JSON.stringify(beforeLate), afterLate: JSON.stringify(afterLate), takeoverCalls,
    takeoverResults: takeoverResults.map((value) => JSON.stringify(value)), writeFailure: {
      first: JSON.stringify(writeFirst), duplicate: JSON.stringify(writeDuplicate), warnings: writeWarnings } };
  const golden = join(dirname(fileURLToPath(import.meta.url)), "golden");
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, "replay-keys.json"), `${JSON.stringify({ provenance, keys }, null, 2)}\n`);
  const recorded = scenarios.map(({ name, seed, agent, steps }) => ({ name, seed, agent, steps }));
  writeFileSync(join(golden, "replay-guard.json"), `${JSON.stringify({ provenance, constants: {
    ttlMs: REPLAY_GUARD_TTL_MS, maxEntries: REPLAY_GUARD_MAX_ENTRIES }, scenarios: recorded, concurrency }, null, 2)}\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }

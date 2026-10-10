import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createTurnDetector, type TurnDetectorOptions, type TurnOutput } from "../src/realtime/endpointing.ts";

// turn_end carries a generated responseId; the older assertions compare everything else.
function noId(e: TurnOutput | undefined): unknown {
  if (e && e.type === "turn_end") { const { responseId: _r, ...rest } = e; return rest; }
  return e;
}

function rig(o: Partial<Omit<TurnDetectorOptions, "emit">> = {}) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: TurnOutput[] = [];
  const d = createTurnDetector({ ...o, endpointingMs: o.endpointingMs ?? 400, speculativeTurnStart: o.speculativeTurnStart ?? false, ackSound: o.ackSound ?? false, emit: (e) => out.push(e) });
  return { d, out, types: () => out.map((e) => e.type) };
}
const done = () => mock.timers.reset();

test("silence for endpointingMs ends the turn with the latest transcript; one tick earlier it has not", () => {
  const { d, out } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "wie spät", final: false });
    d.push({ type: "transcript", text: "wie spät ist es", final: true });
    d.push({ type: "speech_end" });
    assert.equal(d.state, "endpointing");
    mock.timers.tick(399);
    assert.deepEqual(out.map((e) => e.type), ["user_speaking"]);
    mock.timers.tick(1);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "wie spät ist es", speculative: false });
    assert.equal(d.state, "responding");
  } finally { done(); }
});

test("speech that resumes inside the window cancels the silence timer; the turn ends only after the final pause", () => {
  const { d, out, types } = rig({ endpointingMs: 400 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "ich möchte", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(300);
    d.push({ type: "speech_start" });
    assert.equal(d.state, "user_speaking");
    mock.timers.tick(10_000);
    assert.deepEqual(types(), ["user_speaking"], "no turn end while the user is speaking again");
    d.push({ type: "transcript", text: "ich möchte einen Kaffee", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "ich möchte einen Kaffee", speculative: false });
    assert.equal(types().filter((t) => t === "turn_end").length, 1);
  } finally { done(); }
});

test("speculative turn: starts at the final transcript after speech end, is promoted at the endpoint, cancelled if speech resumes", () => {
  const { d, out } = rig({ speculativeTurnStart: true });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "mach das Licht an", final: false });
    d.push({ type: "speech_end" });
    assert.equal(out.some((e) => e.type === "speculative_start"), false, "no final transcript yet");
    d.push({ type: "transcript", text: "mach das Licht an", final: true });
    assert.deepEqual(out.at(-1), { type: "speculative_start", transcript: "mach das Licht an" });
    assert.equal(d.speculating, true);
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "mach das Licht an", speculative: true });
    assert.equal(d.speculating, false);

    // second utterance: user continues -> speculation cancelled, a fresh one starts later
    out.length = 0;
    d.push({ type: "agent_audio_start" });
    d.push({ type: "agent_audio_end" });
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "und", final: true });
    d.push({ type: "speech_end" });
    assert.deepEqual(out.map((e) => e.type), ["user_speaking", "speculative_start"]);
    mock.timers.tick(200);
    d.push({ type: "speech_start" });
    assert.deepEqual(out.at(-1), { type: "speculative_cancel", reason: "speech_resumed" });
    mock.timers.tick(5000);
    assert.equal(out.some((e) => e.type === "turn_end"), false);
    d.push({ type: "transcript", text: "und dimm es", final: true });
    d.push({ type: "speech_end" });
    assert.deepEqual(out.at(-1), { type: "speculative_start", transcript: "und dimm es" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "und dimm es", speculative: true });
  } finally { done(); }
});

test("speculative turn is cancelled when the final transcript changes before the endpoint", () => {
  const { d, out } = rig({ speculativeTurnStart: true });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "speech_end" });
    d.push({ type: "transcript", text: "wetter", final: true });
    d.push({ type: "transcript", text: "wetter morgen", final: true });
    assert.deepEqual(out.map((e) => e.type), ["user_speaking", "speculative_start", "speculative_cancel", "speculative_start"]);
    assert.deepEqual(out[2], { type: "speculative_cancel", reason: "transcript_changed" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "wetter morgen", speculative: true });
  } finally { done(); }
});

test("speculation is off by default: no speculative events at all", () => {
  const { d, types } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(types(), ["user_speaking", "turn_end"]);
  } finally { done(); }
});

test("barge-in while the agent speaks: signal, speculative state dropped, user turn starts", () => {
  const { d, out } = rig({ speculativeTurnStart: true });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "erzähl", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    d.push({ type: "agent_audio_start" });
    assert.equal(d.state, "agent_speaking");
    out.length = 0;
    d.push({ type: "speech_start" });
    assert.deepEqual(out, [{ type: "barge_in", from: "agent_speaking" }, { type: "user_speaking" }]);
    assert.equal(d.state, "user_speaking");
    d.push({ type: "transcript", text: "stopp", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "stopp", speculative: true });
  } finally { done(); }
});

test("barge-in before the agent's first audio (still responding) also cancels the in-flight turn", () => {
  const { d, out } = rig({ speculativeTurnStart: true });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "frage", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(d.state, "responding");
    out.length = 0;
    d.push({ type: "speech_start" });
    assert.deepEqual(out, [{ type: "barge_in", from: "responding" }, { type: "user_speaking" }]);
  } finally { done(); }
});

test("ack sound is emitted right before the turn end when enabled, never otherwise", () => {
  const a = rig({ ackSound: true });
  try {
    a.d.push({ type: "speech_start" });
    a.d.push({ type: "transcript", text: "x", final: true });
    a.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(a.types().slice(-2), ["ack_sound", "turn_end"]);
  } finally { done(); }
});

test("noise and out-of-order events are ignored: speech_end without speech_start, transcripts while idle or responding, double speech_start", () => {
  const { d, types } = rig();
  try {
    d.push({ type: "speech_end" });
    d.push({ type: "transcript", text: "ghost", final: true });
    d.push({ type: "agent_audio_end" });
    assert.equal(d.state, "idle");
    d.push({ type: "speech_start" });
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(types(), ["user_speaking", "turn_end"]);
    d.push({ type: "transcript", text: "late", final: true });
    d.push({ type: "reset" });
    assert.equal(d.state, "idle");
  } finally { done(); }
});

test("reset clears the pending silence timer", () => {
  const { d, types } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    d.push({ type: "reset" });
    mock.timers.tick(10_000);
    assert.deepEqual(types(), ["user_speaking"]);
  } finally { done(); }
});

test("the endpointing window is configurable per detector", () => {
  const { d, types } = rig({ endpointingMs: 150 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(149);
    assert.deepEqual(types(), ["user_speaking"]);
    mock.timers.tick(1);
    assert.deepEqual(types(), ["user_speaking", "turn_end"]);
  } finally { done(); }
});

// ---- F3: empty transcripts, accumulation, late finals ----

test("F3: an utterance without any transcript ends in idle, not in an empty turn_end", () => {
  const { d, types } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(types(), ["user_speaking"]);
    assert.equal(d.state, "idle");
  } finally { done(); }
});

test("F3: a whitespace-only or too short transcript does not count; minTranscriptChars is configurable", () => {
  const a = rig();
  try {
    a.d.push({ type: "speech_start" });
    a.d.push({ type: "transcript", text: "   ", final: true });
    a.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(a.types().includes("turn_end"), false);
    assert.equal(a.d.state, "idle");
  } finally { done(); }
  const b = rig({ minTranscriptChars: 3 });
  try {
    b.d.push({ type: "speech_start" });
    b.d.push({ type: "transcript", text: "ja", final: true });
    b.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(b.types().includes("turn_end"), false);
    b.d.push({ type: "speech_start" });
    b.d.push({ type: "transcript", text: "ja klar", final: true });
    b.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(b.out.at(-1)?.type, "turn_end");
  } finally { done(); }
});

test("F3: with finalWaitMs a late first transcript still ends the turn; without one the detector falls back to idle", () => {
  const { d, out, types } = rig({ finalWaitMs: 800 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(d.state, "endpointing", "still waiting for the recogniser");
    assert.equal(types().includes("turn_end"), false);
    mock.timers.tick(300);
    d.push({ type: "transcript", text: "spät aber da", final: true });
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "spät aber da", speculative: false });
    assert.equal(d.state, "responding");
    d.push({ type: "reset" });
    out.length = 0;
    d.push({ type: "speech_start" });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    mock.timers.tick(800);
    assert.deepEqual(types(), ["user_speaking"]);
    assert.equal(d.state, "idle");
  } finally { done(); }
});

test("F3: finalised segments of one utterance accumulate (a pause inside the utterance does not lose the first part)", () => {
  const { d, out } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "ich möchte", final: true });
    d.push({ type: "transcript", text: "einen Kaffee", final: false });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "ich möchte einen Kaffee", speculative: false });
  } finally { done(); }
});

test("F3: two separate finals accumulate; a cumulative final that repeats the earlier text replaces it", () => {
  const { d, out } = rig();
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "guten Tag", final: true });
    d.push({ type: "transcript", text: "wie geht es", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "guten Tag wie geht es", speculative: false });
    d.push({ type: "reset" });
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "guten", final: true });
    d.push({ type: "transcript", text: "guten Tag", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.deepEqual(noId(out.at(-1)), { type: "turn_end", transcript: "guten Tag", speculative: false });
  } finally { done(); }
});

test("F3: a running speculation is cancelled as soon as a non-final or different transcript arrives", () => {
  const { d, out } = rig({ speculativeTurnStart: true });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "speech_end" });
    d.push({ type: "transcript", text: "wetter", final: true });
    assert.equal(d.speculating, true);
    d.push({ type: "transcript", text: "wetter morgen", final: false });
    assert.deepEqual(out.at(-1), { type: "speculative_cancel", reason: "transcript_changed" });
    assert.equal(d.speculating, false);
  } finally { done(); }
});

// ---- F14: response ids, responding timeout, barge-in debounce ----

test("F14: turn_end carries a response id and a stale agent_audio_end of a cancelled response does not end the newer one", () => {
  let n = 0;
  const { d, out } = rig({ newResponseId: () => `r${++n}` });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "eins", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal((out.at(-1) as { responseId?: string }).responseId, "r1");
    d.push({ type: "agent_audio_start", responseId: "r1" });
    d.push({ type: "speech_start" }); // barge-in, response r1 is dead
    d.push({ type: "transcript", text: "zwei", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal((out.at(-1) as { responseId?: string }).responseId, "r2");
    d.push({ type: "agent_audio_start", responseId: "r2" });
    assert.equal(d.state, "agent_speaking");
    d.push({ type: "agent_audio_end", responseId: "r1" });
    assert.equal(d.state, "agent_speaking", "stale end ignored");
    d.push({ type: "agent_audio_end", responseId: "r2" });
    assert.equal(d.state, "idle");
  } finally { done(); }
});

test("F14: a stale agent_audio_start of an old response is ignored too; events without an id keep working", () => {
  let n = 0;
  const { d } = rig({ newResponseId: () => `r${++n}` });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "eins", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    d.push({ type: "agent_audio_start", responseId: "old" });
    assert.equal(d.state, "responding");
    d.push({ type: "agent_audio_start" });
    assert.equal(d.state, "agent_speaking");
    d.push({ type: "agent_audio_end" });
    assert.equal(d.state, "idle");
  } finally { done(); }
});

test("F14: respondingTimeoutMs returns a silent response to idle and says so", () => {
  const { d, out } = rig({ respondingTimeoutMs: 5000 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(d.state, "responding");
    mock.timers.tick(4999);
    assert.equal(d.state, "responding");
    mock.timers.tick(1);
    assert.equal(d.state, "idle");
    assert.deepEqual(out.at(-1), { type: "response_timeout" });
  } finally { done(); }
});

test("F14: audio start cancels the responding timeout; it is off by default", () => {
  const a = rig({ respondingTimeoutMs: 5000 });
  try {
    a.d.push({ type: "speech_start" });
    a.d.push({ type: "transcript", text: "hallo", final: true });
    a.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    a.d.push({ type: "agent_audio_start" });
    mock.timers.tick(60_000);
    assert.equal(a.d.state, "agent_speaking");
  } finally { done(); }
  const b = rig();
  try {
    b.d.push({ type: "speech_start" });
    b.d.push({ type: "transcript", text: "hallo", final: true });
    b.d.push({ type: "speech_end" });
    mock.timers.tick(400);
    mock.timers.tick(600_000);
    assert.equal(b.d.state, "responding");
  } finally { done(); }
});

test("F14: minBargeInMs debounces a short noise burst but not sustained speech", () => {
  const { d, out } = rig({ minBargeInMs: 200 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "frage", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    d.push({ type: "agent_audio_start" });
    out.length = 0;
    d.push({ type: "speech_start" });
    mock.timers.tick(100);
    d.push({ type: "speech_end" });
    mock.timers.tick(1000);
    assert.deepEqual(out, [], "short burst: no barge-in");
    assert.equal(d.state, "agent_speaking");
    d.push({ type: "speech_start" });
    mock.timers.tick(199);
    assert.deepEqual(out, []);
    mock.timers.tick(1);
    assert.deepEqual(out, [{ type: "barge_in", from: "agent_speaking" }, { type: "user_speaking" }]);
    assert.equal(d.state, "user_speaking");
  } finally { done(); }
});

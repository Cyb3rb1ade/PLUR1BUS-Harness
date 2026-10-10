import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createTurnDetector, type TurnOutput } from "../src/realtime/endpointing.ts";

function rig(o: { endpointingMs?: number; speculativeTurnStart?: boolean; ackSound?: boolean } = {}) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: TurnOutput[] = [];
  const d = createTurnDetector({ endpointingMs: o.endpointingMs ?? 400, speculativeTurnStart: o.speculativeTurnStart ?? false, ackSound: o.ackSound ?? false, emit: (e) => out.push(e) });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "wie spät ist es", speculative: false });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "ich möchte einen Kaffee", speculative: false });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "mach das Licht an", speculative: true });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "und dimm es", speculative: true });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "wetter morgen", speculative: true });
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
    assert.deepEqual(out.at(-1), { type: "turn_end", transcript: "stopp", speculative: true });
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
    d.push({ type: "speech_end" });
    mock.timers.tick(149);
    assert.deepEqual(types(), ["user_speaking"]);
    mock.timers.tick(1);
    assert.deepEqual(types(), ["user_speaking", "turn_end"]);
  } finally { done(); }
});

test("minTranscriptLength: empty or too short transcript does not emit turn_end", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: TurnOutput[] = [];
  const d = createTurnDetector({ endpointingMs: 400, speculativeTurnStart: false, ackSound: false, minTranscriptLength: 3, emit: (e) => out.push(e) });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "  ", final: true }); // empty trimmed
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(out.some((e) => e.type === "turn_end"), false, "whitespace-only transcript must not emit turn_end");
    assert.equal(d.state, "idle");

    // Utterance with text shorter than minTranscriptLength (e.g. "hi" length 2 < 3)
    out.length = 0;
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hi", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(out.some((e) => e.type === "turn_end"), false, "transcript shorter than minTranscriptLength must not emit turn_end");
    assert.equal(d.state, "idle");

    // Utterance meeting minTranscriptLength
    out.length = 0;
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "hallo", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    const end = out.find((e) => e.type === "turn_end");
    assert.ok(end, "valid transcript emits turn_end");
    assert.equal((end as any).transcript, "hallo");
  } finally { mock.timers.reset(); }
});

test("accumulation of multiple finals within an utterance", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: TurnOutput[] = [];
  const d = createTurnDetector({ endpointingMs: 400, speculativeTurnStart: false, ackSound: false, emit: (e) => out.push(e) });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "Erster Satz.", final: true });
    d.push({ type: "transcript", text: "Zweiter Satz.", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    const end = out.find((e) => e.type === "turn_end");
    assert.ok(end);
    assert.equal((end as any).transcript, "Erster Satz. Zweiter Satz.");
  } finally { mock.timers.reset(); }
});

test("outdated agent_audio_end from an earlier turn does not prematurely end a newer response", () => {
  const { d } = rig({ endpointingMs: 400 });
  try {
    d.push({ type: "speech_start" });
    d.push({ type: "transcript", text: "turn 1", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(d.state, "responding");
    d.push({ type: "agent_audio_start" });
    assert.equal(d.state, "agent_speaking");

    // User barges in, starts turn 2
    d.push({ type: "speech_start" });
    assert.equal(d.state, "user_speaking");
    d.push({ type: "transcript", text: "turn 2", final: true });
    d.push({ type: "speech_end" });
    mock.timers.tick(400);
    assert.equal(d.state, "responding");

    // An outdated agent_audio_end arrives from turn 1's aborted playback:
    // (If passed with a turn sequence id or if arriving while turn 2 is responding, it must not reset state to idle)
    // Even if agent_audio_end arrives, if turn 2 is responding and hasn't started its audio, it should not reset to idle
    d.push({ type: "agent_audio_end" });
    assert.equal(d.state, "responding", "outdated audio_end should not reset responding turn to idle");
  } finally { done(); }
});


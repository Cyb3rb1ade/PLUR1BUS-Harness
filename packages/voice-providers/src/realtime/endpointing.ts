// Endpointing / barge-in / speculative-turn state machine. Pure: it consumes events and emits outputs; the only timers
// are the silence window and the optional guards below, started through an injectable setTimeout so tests drive them
// with fake timers.
//
//   idle --speech_start--> user_speaking --speech_end--> endpointing --(endpointingMs of silence)--> responding
//   responding --agent_audio_start--> agent_speaking --agent_audio_end--> idle
//
// speech_start while endpointing cancels the silence window (and a speculative turn if one was started).
// speech_start while responding or agent_speaking is a barge-in: the caller stops playback and abandons the turn.
//
// Transcripts: finalised segments of one utterance accumulate (a pause inside the utterance does not drop the first
// part); a final that starts with the text committed so far is taken as a cumulative result and replaces it. The turn
// ends only with a transcript of at least `minTranscriptChars` non-blank characters. When the window elapses without
// one, the detector waits `finalWaitMs` more for the recogniser (offline ASR only produces text after the commit) and
// then falls back to idle without a turn.
//
// Response ids: turn_end carries a `responseId`. An agent_audio_start/end that names a different id belongs to a
// cancelled response and is ignored. Events without an id behave as before.

export type TurnState = "idle" | "user_speaking" | "endpointing" | "responding" | "agent_speaking";

export type TurnEvent =
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_audio_start"; responseId?: string }
  | { type: "agent_audio_end"; responseId?: string }
  | { type: "reset" };

export type TurnOutput =
  | { type: "user_speaking" }
  | { type: "speculative_start"; transcript: string }
  | { type: "speculative_cancel"; reason: "speech_resumed" | "transcript_changed" | "barge_in" }
  | { type: "ack_sound" }
  | { type: "turn_end"; transcript: string; speculative: boolean; responseId: string }
  | { type: "response_timeout" }
  | { type: "barge_in"; from: "responding" | "agent_speaking" };

export interface TurnDetectorOptions {
  endpointingMs: number;
  speculativeTurnStart: boolean;
  ackSound: boolean;
  /** Fewest non-blank characters a transcript needs to end a turn. Default 1. */
  minTranscriptChars?: number;
  /** Extra wait for a first transcript after the silence window passed with none. Default 0: back to idle at once. */
  finalWaitMs?: number;
  /** A `responding` state without agent audio for this long returns to idle and emits response_timeout. Default 0 (off). */
  respondingTimeoutMs?: number;
  /** Speech over a playing or pending answer must last this long to count as a barge-in (echo and noise bursts do not). Default 0 (immediate). */
  minBargeInMs?: number;
  /** Id for the next response; default a counter ("r1", "r2", ...). */
  newResponseId?: () => string;
  emit: (output: TurnOutput) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface TurnDetector {
  push(event: TurnEvent): void;
  readonly state: TurnState;
  /** True while a speculative turn is running for the current utterance. */
  readonly speculating: boolean;
}

export function createTurnDetector(o: TurnDetectorOptions): TurnDetector {
  const set = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const minChars = Math.max(1, o.minTranscriptChars ?? 1);
  const finalWaitMs = Math.max(0, o.finalWaitMs ?? 0);
  const respondingTimeoutMs = Math.max(0, o.respondingTimeoutMs ?? 0);
  const minBargeInMs = Math.max(0, o.minBargeInMs ?? 0);
  let counter = 0;
  const newResponseId = o.newResponseId ?? (() => `r${++counter}`);
  let state: TurnState = "idle";
  let timer: unknown;
  let respTimer: unknown;
  let bargeTimer: unknown;
  let committed = "";
  let partial = "";
  let finalSeen = false;
  let waitedForFinal = false;
  let speculativeText: string | undefined;
  let responseId: string | undefined;

  const text = () => (committed === "" ? partial : partial === "" ? committed : `${committed} ${partial}`).trim();
  const clearText = () => { committed = ""; partial = ""; finalSeen = false; waitedForFinal = false; };
  const stopTimer = () => { if (timer !== undefined) { clear(timer); timer = undefined; } };
  const stopResp = () => { if (respTimer !== undefined) { clear(respTimer); respTimer = undefined; } };
  const stopBarge = () => { if (bargeTimer !== undefined) { clear(bargeTimer); bargeTimer = undefined; } };
  const cancelSpeculation = (reason: "speech_resumed" | "transcript_changed" | "barge_in") => {
    if (speculativeText === undefined) return;
    speculativeText = undefined;
    o.emit({ type: "speculative_cancel", reason });
  };
  const maybeStartSpeculation = () => {
    const t = text();
    if (!o.speculativeTurnStart || state !== "endpointing" || !finalSeen || t === "") return;
    if (speculativeText === t) return;
    if (speculativeText !== undefined) cancelSpeculation("transcript_changed");
    speculativeText = t;
    o.emit({ type: "speculative_start", transcript: t });
  };
  const enough = () => text().replace(/\s/g, "").length >= minChars;
  const endTurn = () => {
    const transcript = text();
    const speculative = speculativeText !== undefined && speculativeText === transcript;
    if (speculativeText !== undefined && !speculative) cancelSpeculation("transcript_changed");
    speculativeText = undefined;
    clearText();
    state = "responding";
    responseId = newResponseId();
    if (respondingTimeoutMs > 0) {
      stopResp();
      respTimer = set(() => {
        respTimer = undefined;
        if (state !== "responding") return;
        state = "idle";
        responseId = undefined;
        o.emit({ type: "response_timeout" });
      }, respondingTimeoutMs);
    }
    if (o.ackSound) o.emit({ type: "ack_sound" });
    o.emit({ type: "turn_end", transcript, speculative, responseId });
  };
  const fire = () => {
    timer = undefined;
    if (state !== "endpointing") return;
    if (!enough()) {
      if (finalWaitMs > 0 && !waitedForFinal) { waitedForFinal = true; timer = set(fire, finalWaitMs); return; }
      cancelSpeculation("transcript_changed");
      clearText();
      state = "idle";
      return;
    }
    endTurn();
  };
  const bargeIn = () => {
    bargeTimer = undefined;
    if (state !== "responding" && state !== "agent_speaking") return;
    const from = state;
    stopResp();
    cancelSpeculation("barge_in");
    o.emit({ type: "barge_in", from });
    clearText();
    responseId = undefined;
    state = "user_speaking";
    o.emit({ type: "user_speaking" });
  };

  return {
    get state() { return state; },
    get speculating() { return speculativeText !== undefined; },
    push(e) {
      switch (e.type) {
        case "speech_start":
          if (state === "responding" || state === "agent_speaking") {
            if (minBargeInMs > 0) { if (bargeTimer === undefined) bargeTimer = set(bargeIn, minBargeInMs); }
            else bargeIn();
          } else if (state === "endpointing") {
            stopTimer();
            cancelSpeculation("speech_resumed");
            state = "user_speaking";
          } else if (state === "idle") {
            clearText();
            state = "user_speaking";
            o.emit({ type: "user_speaking" });
          }
          return;
        case "speech_end":
          stopBarge();
          if (state !== "user_speaking") return;
          state = "endpointing";
          stopTimer();
          waitedForFinal = false;
          timer = set(fire, o.endpointingMs);
          maybeStartSpeculation();
          return;
        case "transcript": {
          if (state === "idle" || state === "responding" || state === "agent_speaking") return;
          const t = e.text.trim();
          if (e.final) {
            if (committed !== "" && t.startsWith(committed)) committed = t;
            else committed = committed === "" ? t : t === "" ? committed : `${committed} ${t}`;
            partial = "";
          } else {
            partial = committed !== "" && t.startsWith(committed) ? t.slice(committed.length).trim() : t;
          }
          finalSeen = e.final;
          // A running speculation is only valid for the exact text it was started with.
          if (speculativeText !== undefined && speculativeText !== text()) cancelSpeculation("transcript_changed");
          maybeStartSpeculation();
          // The silence window already passed while we waited for the first transcript: now it is here.
          if (state === "endpointing" && timer !== undefined && waitedForFinal && enough()) { stopTimer(); endTurn(); }
          return;
        }
        case "agent_audio_start":
          if (e.responseId !== undefined && responseId !== undefined && e.responseId !== responseId) return;
          if (state === "responding") { stopResp(); state = "agent_speaking"; }
          return;
        case "agent_audio_end":
          if (e.responseId !== undefined && responseId !== undefined && e.responseId !== responseId) return;
          if (state === "agent_speaking" || state === "responding") { stopResp(); stopBarge(); responseId = undefined; state = "idle"; }
          return;
        case "reset":
          stopTimer(); stopResp(); stopBarge();
          speculativeText = undefined;
          clearText();
          responseId = undefined;
          state = "idle";
          return;
      }
    },
  };
}

// Endpointing / barge-in / speculative-turn state machine. Pure: it consumes events and emits outputs; the only timer
// is the silence window, started through an injectable setTimeout so tests drive it with fake timers.
//
//   idle --speech_start--> user_speaking --speech_end--> endpointing --(endpointingMs of silence)--> responding
//   responding --agent_audio_start--> agent_speaking --agent_audio_end--> idle
//
// speech_start while endpointing cancels the silence window (and a speculative turn if one was started).
// speech_start while responding or agent_speaking is a barge-in: the caller stops playback and abandons the turn.

export type TurnState = "idle" | "user_speaking" | "endpointing" | "responding" | "agent_speaking";

export type TurnEvent =
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_audio_start" }
  | { type: "agent_audio_end" }
  | { type: "reset" };

export type TurnOutput =
  | { type: "user_speaking" }
  | { type: "speculative_start"; transcript: string }
  | { type: "speculative_cancel"; reason: "speech_resumed" | "transcript_changed" | "barge_in" }
  | { type: "ack_sound" }
  | { type: "turn_end"; transcript: string; speculative: boolean }
  | { type: "barge_in"; from: "responding" | "agent_speaking" };

export interface TurnDetectorOptions {
  endpointingMs: number;
  speculativeTurnStart: boolean;
  ackSound: boolean;
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
  let state: TurnState = "idle";
  let timer: unknown;
  let text = "";
  let finalSeen = false;
  let speculativeText: string | undefined;

  const stopTimer = () => { if (timer !== undefined) { clear(timer); timer = undefined; } };
  const cancelSpeculation = (reason: "speech_resumed" | "transcript_changed" | "barge_in") => {
    if (speculativeText === undefined) return;
    speculativeText = undefined;
    o.emit({ type: "speculative_cancel", reason });
  };
  const maybeStartSpeculation = () => {
    if (!o.speculativeTurnStart || state !== "endpointing" || !finalSeen || text.trim() === "") return;
    if (speculativeText === text) return;
    if (speculativeText !== undefined) cancelSpeculation("transcript_changed");
    speculativeText = text;
    o.emit({ type: "speculative_start", transcript: text });
  };
  const fire = () => {
    timer = undefined;
    if (state !== "endpointing") return;
    const transcript = text;
    const speculative = speculativeText !== undefined && speculativeText === transcript;
    if (speculativeText !== undefined && !speculative) cancelSpeculation("transcript_changed");
    speculativeText = undefined;
    text = "";
    finalSeen = false;
    state = "responding";
    if (o.ackSound) o.emit({ type: "ack_sound" });
    o.emit({ type: "turn_end", transcript, speculative });
  };

  return {
    get state() { return state; },
    get speculating() { return speculativeText !== undefined; },
    push(e) {
      switch (e.type) {
        case "speech_start":
          if (state === "responding" || state === "agent_speaking") {
            const from = state;
            cancelSpeculation("barge_in");
            o.emit({ type: "barge_in", from });
            text = ""; finalSeen = false;
            state = "user_speaking";
            o.emit({ type: "user_speaking" });
          } else if (state === "endpointing") {
            stopTimer();
            cancelSpeculation("speech_resumed");
            state = "user_speaking";
          } else if (state === "idle") {
            text = ""; finalSeen = false;
            state = "user_speaking";
            o.emit({ type: "user_speaking" });
          }
          return;
        case "speech_end":
          if (state !== "user_speaking") return;
          state = "endpointing";
          stopTimer();
          timer = set(fire, o.endpointingMs);
          maybeStartSpeculation();
          return;
        case "transcript":
          if (state === "idle" || state === "responding" || state === "agent_speaking") return;
          text = e.text;
          finalSeen = e.final;
          maybeStartSpeculation();
          return;
        case "agent_audio_start":
          if (state === "responding") state = "agent_speaking";
          return;
        case "agent_audio_end":
          if (state === "agent_speaking" || state === "responding") state = "idle";
          return;
        case "reset":
          stopTimer();
          speculativeText = undefined;
          text = ""; finalSeen = false;
          state = "idle";
          return;
      }
    },
  };
}

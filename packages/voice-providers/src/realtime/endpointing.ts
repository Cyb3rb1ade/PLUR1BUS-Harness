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
  minTranscriptLength?: number;
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
  const minLen = o.minTranscriptLength ?? 0;
  let state: TurnState = "idle";
  let timer: unknown;
  let text = "";
  let accumulatedFinals = "";
  let finalSeen = false;
  let speculativeText: string | undefined;

  const currentFullText = () => (accumulatedFinals ? (text ? `${accumulatedFinals} ${text}` : accumulatedFinals) : text).trim();

  const stopTimer = () => { if (timer !== undefined) { clear(timer); timer = undefined; } };
  const cancelSpeculation = (reason: "speech_resumed" | "transcript_changed" | "barge_in") => {
    if (speculativeText === undefined) return;
    speculativeText = undefined;
    o.emit({ type: "speculative_cancel", reason });
  };
  const maybeStartSpeculation = () => {
    const full = currentFullText();
    if (!o.speculativeTurnStart || state !== "endpointing" || !finalSeen || full.length < minLen) return;
    if (speculativeText === full) return;
    if (speculativeText !== undefined) cancelSpeculation("transcript_changed");
    speculativeText = full;
    o.emit({ type: "speculative_start", transcript: full });
  };
  const fire = () => {
    timer = undefined;
    if (state !== "endpointing") return;
    const transcript = currentFullText();
    text = "";
    accumulatedFinals = "";
    finalSeen = false;
    if (transcript.length < minLen) {
      if (speculativeText !== undefined) cancelSpeculation("transcript_changed");
      speculativeText = undefined;
      state = "idle";
      return;
    }
    const speculative = speculativeText !== undefined && speculativeText === transcript;
    if (speculativeText !== undefined && !speculative) cancelSpeculation("transcript_changed");
    speculativeText = undefined;
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
            text = ""; accumulatedFinals = ""; finalSeen = false;
            state = "user_speaking";
            o.emit({ type: "user_speaking" });
          } else if (state === "endpointing") {
            stopTimer();
            cancelSpeculation("speech_resumed");
            state = "user_speaking";
          } else if (state === "idle") {
            text = ""; accumulatedFinals = ""; finalSeen = false;
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
          if (e.final) {
            const incoming = e.text.trim();
            if (incoming) {
              if (!accumulatedFinals) {
                accumulatedFinals = incoming;
              } else if (incoming.startsWith(accumulatedFinals)) {
                // Engine updated the final recognition with the full utterance
                accumulatedFinals = incoming;
              } else {
                accumulatedFinals = `${accumulatedFinals} ${incoming}`;
              }
            }
            text = "";
            finalSeen = true;
          } else {
            text = e.text.trim();
          }
          maybeStartSpeculation();
          return;
        case "agent_audio_start":
          if (state === "responding") state = "agent_speaking";
          return;
        case "agent_audio_end":
          if (state === "agent_speaking") state = "idle";
          return;
        case "reset":
          stopTimer();
          speculativeText = undefined;
          text = ""; accumulatedFinals = ""; finalSeen = false;
          state = "idle";
          return;
      }
    },
  };
}


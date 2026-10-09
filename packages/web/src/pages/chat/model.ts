// Transcript state of one chat: the persisted messages plus the live events of the session's stream. Pure functions on an
// immutable value, so the page (and the tests) can replace the whole transcript on every change.
import { outputReference } from "../surfaces/data.ts";
import type { SessionEvent, SessionMessage, TurnState } from "./rpc-types.ts";

export type Entry = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  turnId: string | null;
  /** Assistant entries of a turn seen live only (history entries carry no state: they are simply finished). */
  state?: TurnState;
  error?: string;
  outputId?: string;
};

export type Transcript = {
  entries: readonly Entry[];
  /** Highest event seq applied; events with seq <= lastSeq are duplicates. */
  lastSeq: number;
  runningTurnId: string | null;
  /** Turns whose assistant message is already in `entries` (from history): their replayed events are skipped. */
  done: ReadonlySet<string>;
};

export const EMPTY_TRANSCRIPT: Transcript = { entries: [], lastSeq: 0, runningTurnId: null, done: new Set() };

const turnKey = (turnId: string): string => `turn:${turnId}`;

/** From session.resume. With a running turn the stream is replayed from seq 0 (the partial reply exists only as events). */
export function fromResume(r: { messages: readonly SessionMessage[]; runningTurnId: string | null; lastEventSeq: number }): Transcript {
  const sorted = [...r.messages].sort((a, b) => a.seq - b.seq);
  const done = new Set<string>();
  const entries: Entry[] = sorted.map((m) => {
    const turnId = m.turnId ?? null;
    if (m.role === "assistant" && turnId !== null) done.add(turnId);
    return { id: m.id, role: m.role, text: m.text, turnId };
  });
  return { entries, lastSeq: r.runningTurnId === null ? r.lastEventSeq : 0, runningTurnId: r.runningTurnId, done };
}

const indexOfTurn = (entries: readonly Entry[], turnId: string): number => entries.findIndex((e) => e.id === turnKey(turnId));

function withTurn(tr: Transcript, turnId: string, change: (e: Entry) => Entry): readonly Entry[] {
  const i = indexOfTurn(tr.entries, turnId);
  if (i === -1) return [...tr.entries, change({ id: turnKey(turnId), role: "assistant", text: "", turnId, state: "running" })];
  return tr.entries.map((e, j) => (j === i ? change(e) : e));
}

export type Applied = { tr: Transcript; gap: boolean };

/** Applies one stream event. A duplicate (seq already seen) returns the same transcript; a gap (a seq was skipped) is
 *  reported and not applied, the caller then fetches the missing events with session.events. */
export function applyEvent(tr: Transcript, ev: SessionEvent): Applied {
  if (ev.seq <= tr.lastSeq) return { tr, gap: false };
  if (ev.seq !== tr.lastSeq + 1) return { tr, gap: true };
  const turnId = ev.turnId;
  let next: Transcript = { ...tr, lastSeq: ev.seq };
  if (turnId !== null && !tr.done.has(turnId)) {
    switch (ev.type) {
      case "turn.started":
        next = { ...next, entries: withTurn(tr, turnId, (e) => e), runningTurnId: turnId };
        break;
      case "delta": {
        const text = ev.data.text;
        next = { ...next, entries: withTurn(tr, turnId, (e) => (typeof text === "string" ? { ...e, text: e.text + text } : e)) };
        break;
      }
      case "tool.call": {
        const name = typeof ev.data.name === "string" ? ev.data.name : "?";
        const id = typeof ev.data.id === "string" ? ev.data.id : String(ev.seq);
        next = { ...next, entries: [...withTurn(tr, turnId, (e) => e), { id: `tool:${turnId}:${id}`, role: "tool", text: name, turnId }] };
        break;
      }
      case "turn.completed":
        next = { ...next, entries: withTurn(tr, turnId, (e) => ({ ...e, state: "completed" })), runningTurnId: tr.runningTurnId === turnId ? null : tr.runningTurnId };
        break;
      case "turn.failed": {
        const error = typeof ev.data.error === "string" ? ev.data.error : "";
        next = { ...next, entries: withTurn(tr, turnId, (e) => ({ ...e, state: "failed", error })), runningTurnId: tr.runningTurnId === turnId ? null : tr.runningTurnId };
        break;
      }
      case "tool.result": {
        let value = ev.data.result ?? ev.data.value;
        if (typeof ev.data.output === "string") { try { value = JSON.parse(ev.data.output); } catch { /* text-only tool result */ } }
        const outputId = outputReference(value);
        if (outputId) next = { ...next, entries: [...next.entries, { id: `output:${ev.seq}`, role: "tool", text: "", turnId, outputId }] };
        break;
      }
    }
  }
  return { tr: next, gap: false };
}

/** The user's own message after session.submit answered. It goes before the assistant entry of its turn if the stream
 *  already created one, and never revives a turn that has finished. */
export function addUser(tr: Transcript, m: { id: string; text: string; turnId: string; state: TurnState }): Transcript {
  if (tr.entries.some((e) => e.id === m.id)) return tr;
  const user: Entry = { id: m.id, role: "user", text: m.text, turnId: m.turnId };
  const at = indexOfTurn(tr.entries, m.turnId);
  if (at !== -1) return { ...tr, entries: [...tr.entries.slice(0, at), user, ...tr.entries.slice(at)] };
  const placeholder: Entry[] = m.state === "running" && !tr.done.has(m.turnId) ? [{ id: turnKey(m.turnId), role: "assistant", text: "", turnId: m.turnId, state: "running" }] : [];
  return { ...tr, entries: [...tr.entries, user, ...placeholder], runningTurnId: placeholder.length > 0 ? m.turnId : tr.runningTurnId };
}

// Every secret value this process holds is registered here the moment it exists (set, rotated, revealed, leased), and
// each log/audit/report redactor that subscribed learns it before the value can reach a line. Values are only ever held
// in memory.
//
// What is kept: the value a store name holds NOW is pinned and is never displaced, however many other values come and go
// (audit secrets #3: 256 OAuth refreshes must not push the approval chain key out of the masking). A value that stops being
// current (rotated away, or registered without a name) is retired: it stays masked, because a retired value that still appears
// somewhere must stay masked, but retired values are bounded (the newest `MAX_REGISTERED_SECRETS`), which is what keeps a
// token that refreshes every hour from growing the set, and the cost of every log line, without end.
import { createRedactor, type Redactor } from "../logs/redact.ts";
import { MIN_REDACTED_VALUE_CHARS } from "./types.ts";

/** How many retired (and name-less) values are kept, newest first. Pinned values are not counted and never leave. */
export const MAX_REGISTERED_SECRETS = 256;
/** Shorter values are not masked (a three-letter value would blank ordinary words in every line); `secret.set` warns about one (`shortValueWarning`). */
const MIN_LENGTH = MIN_REDACTED_VALUE_CHARS;

/** `pinned`: the value is the current one of a store name, so the sink must keep it for good. A sink hears a value again when it is
 *  retired (`pinned: false`) so that it can let go of it like any other transient value. */
export type SecretSink = (value: string, info: { pinned: boolean }) => void;

export interface SecretRedaction {
  /** Registers a value (and, for an authorization header value, its bare credential). Short or non-string input is ignored.
   *  With `name`, it becomes the current value of that store name (pinned) and the name's previous value is retired. */
  register(value: string, name?: string): void;
  /** `sink` receives every value registered so far and every later one. Returns the unsubscribe function. */
  subscribe(sink: SecretSink): () => void;
  /** A redactor that always masks the values registered at the time of each call. */
  redactor(options?: { pii?: boolean }): Redactor;
  /** True when `text` contains a value registered so far (plain, as the user typed it). */
  contains(text: string): boolean;
  /** `text` with every registered value replaced by a fixed mask. Nothing else in the text is touched. */
  mask(text: string): string;
}

export function createSecretRedaction(): SecretRedaction {
  /** name -> the values it holds now (a header value and its bare credential are two values of one name). */
  const current = new Map<string, Set<string>>();
  /** value -> how many names hold it now. */
  const pins = new Map<string, number>();
  /** Not current anywhere, oldest first. */
  const retired = new Set<string>();
  const sinks = new Set<SecretSink>(); let version = 0;
  const known = (): string[] => [...pins.keys(), ...retired];
  const tell = (value: string): void => { const pinned = pins.has(value); for (const sink of sinks) { try { sink(value, { pinned }); } catch { /* one failing sink must not stop the others or the caller */ } } };
  const eligible = (value: unknown): value is string => typeof value === "string" && value.length >= MIN_LENGTH;
  /** Drops one name's hold on `value`; true when no name holds it any more. */
  const unpin = (value: string): boolean => { const n = (pins.get(value) ?? 0) - 1; if (n > 0) { pins.set(value, n); return false; } pins.delete(value); return true; };
  const bound = (): void => { while (retired.size > MAX_REGISTERED_SECRETS) retired.delete(retired.values().next().value!); };

  function addAnonymous(value: string): void {
    if (!eligible(value) || pins.has(value) || retired.has(value)) return;
    retired.add(value); bound(); version++;
    tell(value);
  }
  function addNamed(name: string, values: string[]): void {
    const next = new Set(values.filter(eligible));
    if (next.size === 0) return;
    const prev = current.get(name) ?? new Set<string>();
    // A value that is already current for this name is a re-read (the common case): nothing changes.
    if ([...next].every((v) => prev.has(v))) return;
    const changed: string[] = [];
    for (const v of prev) if (!next.has(v) && unpin(v)) { retired.add(v); changed.push(v); }
    for (const v of next) if (!prev.has(v)) { pins.set(v, (pins.get(v) ?? 0) + 1); retired.delete(v); changed.push(v); }
    current.set(name, next);
    bound(); version++;
    for (const v of changed) tell(v);
  }

  return {
    register(value, name) {
      if (typeof value !== "string") return;
      const bare = value.replace(/^(?:Bearer|Basic)\s+/i, "");
      if (typeof name === "string" && name !== "") { addNamed(name, bare !== value ? [value, bare] : [value]); return; }
      addAnonymous(value);
      if (bare !== value) addAnonymous(bare);
    },
    subscribe(sink) {
      sinks.add(sink);
      for (const value of known()) { try { sink(value, { pinned: pins.has(value) }); } catch { /* see above */ } }
      return () => { sinks.delete(sink); };
    },
    redactor(options = {}) {
      let seen = -1; let inner: Redactor | undefined;
      const rebuild = (): Redactor => { if (!inner || seen !== version) { inner = createRedactor({ ...options, secrets: new Set(known()) }); seen = version; } return inner; };
      return { text: s => rebuild().text(s), value: v => rebuild().value(v) };
    },
    contains: (text) => typeof text === "string" && known().some((v) => text.includes(v)),
    mask: (text) => { let out = text; for (const v of known().sort((a, b) => b.length - a.length)) if (out.includes(v)) out = out.split(v).join("[redacted]"); return out; },
  };
}

/**
 * Redacts outgoing protocol text according to Festlegung 5/6:
 * - A2A gets full secret redaction plus PII redaction (`pii: true`, including IBAN and card numbers).
 * - MCP gets secret redaction (`pii: false`, keys, tokens, registered secrets).
 */
export function redactProtocolOutput(
  text: string,
  target: "a2a" | "mcp",
  redaction: SecretRedaction,
): string {
  return redaction.redactor({ pii: target === "a2a" }).text(text);
}

/**
 * Redacts an outgoing protocol value (e.g. tool output, message object) according to Festlegung 5/6.
 */
export function redactProtocolValue<T>(
  value: T,
  target: "a2a" | "mcp",
  redaction: SecretRedaction,
): T {
  return redaction.redactor({ pii: target === "a2a" }).value(value);
}

// The harness's JSON-lines logger lives in @plur1bus/module-api (H3B-R12: module processes log the same way); the
// engine adapter stays here, with the engine.
import { LIMITS } from "@plur1bus/log-schema";
import { type HarnessLogger } from "@plur1bus/module-api";
import { createRedactor } from "./logs/redact.ts";

export { createLogger, type HarnessLogger, type Level } from "@plur1bus/module-api";

const redactor = createRedactor();
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 1024;
const MAX_STACK = 2048;
const MAX_NODES = 200; // values visited per argument list; keeps the redaction work bounded however the tree is shaped
// Strings are cut BEFORE the redaction regexes run: the redactor's key=value rule is quadratic in the length of an
// unbroken word run (about 0.8 s at 4 KiB, 4 s at 8 KiB), so a long foreign line must never reach it whole.
// JSON.stringify leaves these raw, and several line readers treat them as line ends; write them as visible escapes.
const SEPARATORS = /[\u0085\u2028\u2029]/g;
const escapeSeparators = (s: string): string => s.replace(SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function clip(s: string, max: number): string {
  const cut = escapeSeparators(redactor.text(s.length > max ? s.slice(0, max) : s));
  return s.length > max ? `${cut}…[+${s.length - max} chars]` : cut;
}

/** The stack without its header: `name: message` is already a field of its own, and a second copy is one more place for foreign text. */
function frames(e: Error): string {
  const stack = e.stack ?? "";
  const at = stack.search(/^\s+at /m);
  return at > 0 ? stack.slice(at) : stack.startsWith(`${e.name}: ${e.message}`) ? stack.slice(`${e.name}: ${e.message}`.length) : stack;
}

/**
 * A JSON-safe, bounded, redacted copy of anything the engine hands to its logger: cycles, BigInt, functions, throwing
 * getters, Error chains (cause, AggregateError members) and errors nested inside plain objects are all handled here,
 * so the line writer below never sees a value it cannot serialise. Values under secret-looking keys are replaced.
 */
function plain(v: unknown, depth: number, path: Set<object>, budget: { left: number } = { left: MAX_NODES }): unknown {
  if (--budget.left < 0) return "[truncated]";
  switch (typeof v) {
    case "string": return clip(v, MAX_STRING);
    case "number": return Number.isFinite(v) ? v : String(v);
    case "boolean": case "undefined": return v;
    case "bigint": return v.toString();
    case "symbol": case "function": return `[${typeof v}]`;
  }
  if (v === null) return null;
  const obj = v as object;
  if (path.has(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Object]";
  path.add(obj);
  try {
    if (obj instanceof Error) {
      const out: Record<string, unknown> = {};
      const put = (k: string, get: () => unknown) => { try { const x = get(); if (x !== undefined) out[k] = x; } catch { out[k] = "[Unreadable]"; } };
      put("name", () => plain(obj.name, depth + 1, path, budget));
      put("message", () => plain(obj.message, depth + 1, path, budget));
      put("stack", () => (typeof obj.stack === "string" ? clip(frames(obj), MAX_STACK) : undefined));
      put("code", () => ((obj as { code?: unknown }).code !== undefined ? plain((obj as { code?: unknown }).code, depth + 1, path, budget) : undefined));
      put("cause", () => (obj.cause !== undefined ? plain(obj.cause, depth + 1, path, budget) : undefined));
      if (obj instanceof AggregateError) put("errors", () => plain(obj.errors, depth + 1, path, budget));
      return out;
    }
    if (Array.isArray(obj)) {
      const out = obj.slice(0, MAX_ITEMS).map((x) => { try { return plain(x, depth + 1, path, budget); } catch { return "[Unreadable]"; } });
      if (obj.length > MAX_ITEMS) out.push(`[+${obj.length - MAX_ITEMS} items]`);
      return out;
    }
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[${obj.constructor.name} ${obj.byteLength} bytes]`;
    const out: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(obj);
    for (const k of keys.slice(0, MAX_ITEMS)) {
      try { out[escapeSeparators(k.slice(0, 128))] = plain((obj as Record<string, unknown>)[k], depth + 1, path, budget); } catch { out[escapeSeparators(k.slice(0, 128))] = "[Unreadable]"; }
    }
    if (keys.length > MAX_ITEMS) out["…"] = `[+${keys.length - MAX_ITEMS} keys]`;
    return out;
  } finally { path.delete(obj); }
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** The engine's `rest` arguments as logger fields: sanitised, redacted and held to the `attrs` byte limit. */
function restFields(rest: unknown[]): Record<string, unknown> | undefined {
  if (rest.length === 0) return undefined;
  const kept: unknown[] = [];
  const budget = { left: MAX_NODES };
  let size = 2;
  for (const item of rest) {
    const safe = redactor.value(plain(item, 0, new Set(), budget));
    const n = jsonBytes(safe) + 1;
    if (size + n > LIMITS.attrsBytes - 128) { kept.push(`[+${rest.length - kept.length} arguments dropped, over ${LIMITS.attrsBytes} bytes]`); break; }
    kept.push(safe); size += n;
  }
  return { rest: kept };
}

function messageText(m: unknown): string {
  const text = clip(String(m), LIMITS.msgBytes / 2); // characters; the byte limit below is the hard one
  return Buffer.byteLength(text) > LIMITS.msgBytes ? `${Buffer.from(text).subarray(0, LIMITS.msgBytes - 16).toString("utf8").replace(/\uFFFD+$/, "")}…[cut]` : text;
}

/** Adapter to the engine's Logger shape (message + rest args). A logging failure never reaches the engine. */
export function engineLoggerFrom(log: HarnessLogger) {
  const emit = (level: "info" | "warn" | "error" | "debug", m: unknown, rest: unknown[]): void => {
    try { log[level](messageText(m), restFields(rest)); }
    catch { try { log[level]("engine log record dropped: not serialisable"); } catch { /* the sink itself is gone */ } }
  };
  return {
    info: (m: string, ...r: unknown[]) => emit("info", m, r), warn: (m: string, ...r: unknown[]) => emit("warn", m, r),
    error: (m: string, ...r: unknown[]) => emit("error", m, r), debug: (m: string, ...r: unknown[]) => emit("debug", m, r),
  };
}

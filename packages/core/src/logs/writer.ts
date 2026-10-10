import { KEY_ORDER, LIMITS, attrsSchemaFor, levelAtLeast, lookupEvent, validateRecord, type Level } from "@plur1bus/log-schema";
import { createHash } from "node:crypto";
import { serializeError } from "@plur1bus/module-api";
import { createRedactor } from "./redact.ts";
import { LevelPolicy, type LevelSettings, type Source } from "./levels.ts";
import { currentTrace, newTrace } from "./trace.ts";
import { createSink } from "./sink.ts";
export interface WriteFields { source?: Source; level?: Level; stream?: "stdout" | "stderr"; bypassRate?: boolean }
export interface WriterOptions { dir: string; role: string; source: Source; now?: () => number; timers?: boolean; strict?: boolean; maxBytes?: number; keep?: number; retentionDays?: number; redactPii?: boolean; levels?: LevelSettings }
type RecordValue = Record<string, any>;
interface Repeat { record: RecordValue; start: number; count: number }
interface Bucket { tokens: number; at: number; start: number; dropped: number; source: Source }
/** UTF-8 byte cap, never cuts a code point. */
export function cap(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = ""; let size = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (size + n > Math.max(0, bytes - 3)) break; result += char; size += n; }
  return result + "…";
}
export function createWriter(o: WriterOptions) {
  const now = o.now ?? Date.now; const sink = createSink({ ...o, now });
  const secrets = new Set<string>(); let redactor = createRedactor({ pii: o.redactPii ?? false, secrets });
  let closed = false; let flushing = false; let lastPrune = now();
  const pending: string[] = []; const repeats = new Map<string, Repeat>(); const buckets = new Map<string, Bucket>();
  const policy = new LevelPolicy({ now, expired: key => emit("log.level.expired", { source_key: key, from: "trace", to: "debug" }, {}, true) });
  policy.update(o.levels ?? {});
  let levelSettings: LevelSettings = o.levels ?? {};
  function enqueue(record: RecordValue): void {
    const check = validateRecord(record);
    if (!check.ok) throw new Error(`invalid log record: ${check.code} ${check.detail}`);
    pending.push(`${JSON.stringify(record)}\n`);
    if (pending.length >= 64) flush();
  }
  function flush(durable = true): void {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length) { sink.append(pending[0]!, false); pending.shift(); }
      if (durable) sink.sync();
    }
    finally { flushing = false; }
  }
  function fit(record: RecordValue): RecordValue {
    const attrs = record.attrs as RecordValue; const original = Buffer.byteLength(JSON.stringify(attrs));
    const schema = attrsSchemaFor(lookupEvent(record.event)!); const props = schema.properties as Record<string, { maxLength?: number; maxItems?: number; items?: { maxLength?: number } }>;
    for (const [key, value] of Object.entries(attrs)) if (typeof value === "string") attrs[key] = cap(value, Math.min(props[key]?.maxLength ?? LIMITS.attrsBytes, key === "foreign_message" ? 2048 : LIMITS.attrsBytes));
    for (const [key, value] of Object.entries(attrs)) if (Array.isArray(value)) {
      const limit = props[key]?.maxItems ?? value.length;
      attrs[key] = value.slice(0, limit).map(v => typeof v === "string" ? cap(v, props[key]?.items?.maxLength ?? LIMITS.attrsBytes) : v);
    }
    if (Buffer.byteLength(JSON.stringify(attrs)) !== original) { attrs.truncated = true; attrs.bytes ??= original; }
    // Retain required attribute names and types. Reduce string fields until JSON escaping fits the record cap.
    while (Buffer.byteLength(JSON.stringify(record)) > LIMITS.lineBytes || Buffer.byteLength(JSON.stringify(attrs)) > LIMITS.attrsBytes) {
      const strings = Object.entries(attrs).filter((e): e is [string, string] => typeof e[1] === "string" && Buffer.byteLength(e[1]) > 8).sort((a, b) => Buffer.byteLength(b[1]) - Buffer.byteLength(a[1]));
      const arrays = Object.entries(attrs).filter((e): e is [string, unknown[]] => Array.isArray(e[1]) && e[1].length > 0).sort((a, b) => Buffer.byteLength(JSON.stringify(b[1])) - Buffer.byteLength(JSON.stringify(a[1])));
      if (arrays.length && (!strings.length || Buffer.byteLength(JSON.stringify(arrays[0]![1])) > Buffer.byteLength(strings[0]![1]))) {
        const [key, value] = arrays[0]!; attrs[key] = value.slice(0, Math.floor(value.length / 2));
      } else if (strings.length) {
        const [key, value] = strings[0]!; attrs[key] = cap(value, Math.floor(Buffer.byteLength(value) / 2));
      } else throw new RangeError("record cannot fit byte limit");
      attrs.truncated = true; attrs.bytes ??= original;
    }
    return record;
  }
  function emit(event: string, attrs: RecordValue = {}, fields: WriteFields = {}, internal = false): void {
    if (closed) throw new Error("log writer closed");
    const source = fields.source ?? o.source; const entry = lookupEvent(event);
    if (!entry) {
      if (o.strict) throw new Error(`unregistered log event: ${event}`);
      emit("log.unregistered", { attempted: cap(redactor.text(event), 128) }, { source }, true); return;
    }
    if (entry.stream !== "diagnostic") throw new Error("diagnostic writer cannot write audit or payload");
    const level = fields.level ?? entry.level!;
    if (!internal && !levelAtLeast(level, policy.resolve(source))) return;
    let safeAttrs: RecordValue;
    try { safeAttrs = redactor.value(attrs); }
    catch { emit("log.redaction.failed", { attempted_event: entry.event }, { source }, true); return; }
    const trace = currentTrace() ?? newTrace();
    let record: RecordValue = { ts: new Date(now()).toISOString(), level, source: redactor.value({ kind: source.kind, id: source.id, version: source.version }), event, msg: entry.msg!, trace_id: trace.trace_id, span_id: trace.span_id,
      ...(fields.stream ? { stream: fields.stream } : {}), attrs: { ...safeAttrs, ...(trace.link_trace_id ? { link_trace_id: trace.link_trace_id } : {}) } };
    record = fit(record);
    // Explicit ordering also protects callers from accidentally changing the wire format.
    record = Object.fromEntries(KEY_ORDER.filter(k => k in record).map(k => [k, record[k]]));
    const check = validateRecord(record); if (!check.ok) throw new Error(`invalid log record: ${check.code} ${check.detail}`);
    if (internal || level === "fatal") { enqueue(record); return; }
    const key = createHash("sha256").update(JSON.stringify([source, level, event, fields.stream, record.attrs, currentTrace()?.trace_id])).digest("hex");
    const prior = repeats.get(key);
    if (prior && now() - prior.start < LIMITS.dedupWindowMs) { prior.count++; return; }
    if (prior) { summarize(prior); repeats.delete(key); }
    const sourceKey = `${source.kind}:${source.id}`;
    let bucket = buckets.get(sourceKey);
    if (!bucket) { bucket = { tokens: LIMITS.rateBurst, at: now(), start: now(), dropped: 0, source }; buckets.set(sourceKey, bucket); }
    bucket.tokens = Math.min(LIMITS.rateBurst, bucket.tokens + Math.max(0, now() - bucket.at) * LIMITS.rateSustainedPerSecond / 1000); bucket.at = now();
    if (!fields.bypassRate && bucket.tokens < 1) { bucket.dropped++; return; }
    if (!fields.bypassRate) bucket.tokens--;
    // Bounded dedup state; evicting emits the summary instead of losing its count.
    if (repeats.size >= 1000) { const first = repeats.keys().next().value!; summarize(repeats.get(first)!); repeats.delete(first); }
    enqueue(record); repeats.set(key, { record, start: now(), count: 1 });
  }
  function summarize(r: Repeat): void {
    if (r.count > 1) enqueue(fit({ ...r.record, ts: new Date(now()).toISOString(), attrs: { ...r.record.attrs, repeat: r.count, window_ms: LIMITS.dedupWindowMs } }));
  }
  function tick(force = false): void {
    for (const [key, repeat] of repeats) if (force || now() - repeat.start >= LIMITS.dedupWindowMs) { summarize(repeat); repeats.delete(key); }
    for (const bucket of buckets.values()) if (bucket.dropped && (force || now() - bucket.start >= 1000)) {
      emit("log.suppressed", { dropped: bucket.dropped, window_ms: Math.max(0, now() - bucket.start), reason: "rate-limit" }, { source: bucket.source }, true); bucket.dropped = 0; bucket.start = now();
    }
    policy.resolve(o.source);
    if (now() - lastPrune >= 86400000) { prune(); lastPrune = now(); }
  }
  function prune(): void { const result = sink.prune(); if (result.files) emit("log.retention.pruned", { stream: "diagnostic", ...result, older_than_days: o.retentionDays ?? 14 }, {}, true); }
  prune();
  const timer = o.timers === false ? null : setInterval(() => { try { tick(); flush(); } catch { /* keep queued records for the next flush */ } }, 1000);
  timer?.unref();
  return {
    write: emit, flush, tick,
    /** Transitional callers retain {at,role}; one sink owns both formats until their catalogue migration. */
    writeLegacy(level: Level, msg: string, fields: Record<string, unknown> = {}) {
      if (closed) throw new Error("log writer closed");
      if (!levelAtLeast(level, policy.resolve(o.source))) return;
      try {
        const safe = redactor.value(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serializeError(value)])));
        const record = { at: new Date(now()).toISOString(), level, role: o.role, ...safe, msg: cap(redactor.text(msg), LIMITS.msgBytes) };
        let line = JSON.stringify(record);
        if (Buffer.byteLength(line) > LIMITS.lineBytes) line = JSON.stringify({ at: record.at, level, role: o.role, msg: record.msg, truncated: true, bytes: Buffer.byteLength(line) });
        // Preserve synchronous diagnostic visibility without blocking every capture/
        // recall on fsync. The 1 s timer and explicit flush/close sync the batch;
        // warn/error still sync before returning. Audit sinks are separate.
        pending.push(`${line}\n`); flush(level !== "info" && level !== "debug");
      } catch { emit("log.redaction.failed", { attempted_event: "log.unregistered" }, {}, true); }
    },
    registerSecret(value: string) { secrets.add(value); redactor = createRedactor({ pii: o.redactPii ?? false, secrets }); },
    updateLevels(settings: LevelSettings) {
      policy.update(settings);
      const previous: Record<string, Level> = { [o.source.kind]: levelSettings.defaultLevel ?? "info", ...levelSettings.levels };
      const next: Record<string, Level> = { [o.source.kind]: settings.defaultLevel ?? "info", ...settings.levels };
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        const to = next[key] ?? settings.defaultLevel ?? "info";
        if (previous[key] !== next[key]) emit("log.level.changed", { source_key: key, ...(previous[key] ? { from: previous[key] } : {}), to }, {}, true);
      }
      levelSettings = { ...settings, levels: { ...settings.levels } };
    },
    setRotation: sink.setRotation,
    close() { if (closed) return; if (timer) clearInterval(timer); tick(true); flush(); closed = true; secrets.clear(); },
  };
}
export type LogWriter = ReturnType<typeof createWriter>;

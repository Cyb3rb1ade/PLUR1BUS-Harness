import { StringDecoder } from "node:string_decoder";
import { LIMITS, REDACTION, type Level } from "@plur1bus/log-schema";
import { createRedactor, type Redactor } from "./redact.ts";
import { SecretFormsCache } from "./secret-forms.ts";
import type { SecretMatcher } from "./secret-matcher.ts";
import type { LogWriter } from "./writer.ts";
/** UTF-8 byte cap, never cuts a code point. OutputLines redacts a line first and cuts it afterwards (a cut inside a key would leave its prefix unmatched). */
function cutUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = ""; let size = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (size + n > bytes) break; result += char; size += n; }
  return result;
}
/** Foreign text is never parsed for levels, events or trace metadata. */
export function sanitise(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, "");
}
// A private key arrives over many lines and each line is written (and redacted) on its own, so the single-text `pem-private-key`
// rule never sees BEGIN and END together. The framer therefore tracks the block itself. The markers are the ones in
// redaction.json (a test pins them to that rule); the replacement is the same tag the rule would produce.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_MASK: string = (REDACTION.replacementTemplate as string).replace("{rule}", "pattern");
const FRAME_BYTES = 65536;
/** Keep source UTF-8 boundaries when retaining context; no masked output offset is used as a source offset. */
function sourceSuffix(text: string, bytes: number): string {
  const buffer = Buffer.from(text); if (buffer.length <= bytes) return text;
  let at = Math.max(0, buffer.length - bytes);
  while (at < buffer.length && (buffer[at]! & 0xc0) === 0x80) at++;
  return buffer.toString("utf8", at);
}

export function signalLevel(s: { exitCode?: number; signal?: string; httpStatus?: number; retrying?: boolean; protocolError?: boolean }): Level {
  if (s.signal || s.protocolError || (s.exitCode !== undefined && s.exitCode !== 0)) return "error";
  if (s.httpStatus !== undefined && s.httpStatus >= 400) return s.retrying && [429, 503].includes(s.httpStatus) ? "warn" : "error";
  return "info";
}
/** Line framing keeps at most 64 KiB; oversized lines are replaced wholesale, so discarded secret suffixes cannot expose a prefix. */
export class OutputLines {
  private writer: LogWriter; private stream: "stdout" | "stderr"; private now: () => number;
  private decoder = new StringDecoder("utf8"); private pending = ""; private pendingBytes = 0; private bytes = 0; private last = 0;
  private history = ""; private advanced = 0; private lastPadding = 0; private quarantine = 0; private discarding = false;
  private tokens = LIMITS.rateBurst; private at: number; private start: number; private dropped = 0; private closed = false;
  private redact: Redactor; private matcher: SecretMatcher; private inPem = false;
  constructor(writer: LogWriter, stream: "stdout" | "stderr", o: { now?: () => number; secrets?: Iterable<string> } = {}) {
    this.writer = writer; this.stream = stream; this.now = o.now ?? Date.now; this.at = this.now(); this.start = this.at;
    this.matcher = new SecretFormsCache().snapshot(o.secrets ?? []).matcher;
    this.redact = createRedactor({ secretMatcher: this.matcher });
  }
  /** Masks a private-key block across lines; `inPem` is the state between lines. An unterminated block stays masked to the end of the stream. */
  private maskPem(text: string): string {
    let out = ""; let rest = text; let masked = false; // `masked`: this call already wrote the tag for the open block
    for (;;) {
      if (this.inPem) {
        const end = PEM_END.exec(rest);
        if (!end) return masked ? out : out + PEM_MASK;
        if (!masked) out += PEM_MASK;
        this.inPem = false; masked = false; rest = rest.slice(end.index + end[0].length);
      } else {
        const begin = PEM_BEGIN.exec(rest);
        if (!begin) return out + rest;
        out += rest.slice(0, begin.index) + PEM_MASK; masked = true; this.inPem = true; rest = rest.slice(begin.index + begin[0].length);
      }
    }
  }
  push(chunk: Buffer): void { if (this.closed) throw new Error("output wrapper closed"); this.consume(this.decoder.write(chunk)); }
  private padding(): number {
    let next: number;
    try { next = Math.max(0, (this.writer.outputMatcher?.(this.matcher) ?? this.matcher).maxSourceBytes - 1); }
    catch { next = FRAME_BYTES; }
    const retained = Buffer.byteLength(this.history);
    if (next > this.lastPadding && this.advanced > retained) this.quarantine = Math.max(this.quarantine, next - retained);
    this.lastPadding = next; return next;
  }
  private consume(text: string): void {
    for (const piece of text.split(/(?<=\n)/)) {
      const newline = piece.endsWith("\n"); const part = newline ? piece.slice(0, -1) : piece;
      for (let at = 0; at < part.length;) {
        let end = Math.min(part.length, at + 4096);
        if (end < part.length && /[\ud800-\udbff]/.test(part[end - 1]!)) end--;
        const source = part.slice(at, end); at = end;
        const bytes = Buffer.byteLength(source); this.bytes += bytes;
        if (!this.discarding) { this.pending += source; this.pendingBytes += bytes; this.flush(); this.bound(); }
      }
      this.last = this.now();
      if (newline) {
        if (this.discarding) {
          this.emitLine("", 0, 0, this.bytes, true); this.discarding = false;
          this.quarantine = Math.max(this.quarantine, this.padding()); this.history = "";
        } else { this.pending += "\n"; this.pendingBytes++; this.flush(); this.bound(); }
        this.bytes = 0;
      }
    }
  }
  private advance(source: string, padding: number): void {
    const bytes = Buffer.byteLength(source); this.advanced += bytes; this.quarantine = Math.max(0, this.quarantine - bytes);
    this.history = sourceSuffix(this.history + source, Math.min(FRAME_BYTES, padding));
  }
  private flush(final = false, idle = false): void {
    if (!this.pending) return;
    const padding = this.padding(), context = this.history + this.pending, offset = this.history.length;
    // Units are conservative here: valid UTF-8 has at least as many bytes as UTF-16 units, including surrogate pairs.
    const ready = final ? this.pending.length : Math.max(0, this.pending.length - padding);
    let consumed = 0;
    for (let end = this.pending.indexOf("\n"); end >= 0 && (final || end + 1 <= ready); end = this.pending.indexOf("\n", consumed)) {
      const source = this.pending.slice(consumed, end + 1);
      this.emitLine(context, offset + consumed, offset + end, Buffer.byteLength(source) - 1, this.quarantine > 0);
      this.quarantine = Math.max(0, this.quarantine - Buffer.byteLength(source)); consumed = end + 1;
    }
    if ((final || idle) && consumed < this.pending.length && this.pending.indexOf("\n", consumed) < 0) {
      let end = final ? this.pending.length : ready;
      if (end > consumed && end < this.pending.length && /[\ud800-\udbff]/.test(this.pending[end - 1]!) && /[\udc00-\udfff]/.test(this.pending[end]!)) end--;
      if (end > consumed) {
        const source = this.pending.slice(consumed, end);
        this.emitLine(context, offset + consumed, offset + end, Buffer.byteLength(source), this.quarantine > 0);
        this.quarantine = Math.max(0, this.quarantine - Buffer.byteLength(source)); consumed = end;
        this.bytes = Buffer.byteLength(this.pending.slice(consumed));
      }
    }
    if (consumed) {
      const source = this.pending.slice(0, consumed); const quarantine = this.quarantine;
      this.advance(source, padding); this.quarantine = quarantine;
      this.pending = this.pending.slice(consumed); this.pendingBytes = Buffer.byteLength(this.pending);
    }
  }
  private bound(): void {
    while (this.pendingBytes > FRAME_BYTES) {
      const end = this.pending.indexOf("\n");
      if (end < 0) {
        // Discard the entire physical line, including any future suffix. Neighbouring lines also need a full context gap.
        this.maskPem(sanitise(this.pending)); this.pending = ""; this.pendingBytes = 0; this.discarding = true;
      } else {
        const source = this.pending.slice(0, end);
        this.maskPem(sanitise(source));
        this.emitLine("", 0, 0, Buffer.byteLength(source), true);
        this.pending = this.pending.slice(end + 1); this.pendingBytes = Buffer.byteLength(this.pending);
      }
      this.history = ""; this.quarantine = Math.max(this.quarantine, this.padding());
    }
  }
  private emitLine(context: string, begin: number, end: number, bytes: number, framed = false): void {
    this.tokens = Math.min(LIMITS.rateBurst, this.tokens + Math.max(0, this.now() - this.at) * LIMITS.rateSustainedPerSecond / 1000); this.at = this.now();
    if (this.tokens < 1) { this.maskPem(sanitise(context.slice(begin, end))); this.dropped++; }
    else {
      this.tokens--;
      const transform = (text: string): string => this.maskPem(sanitise(text));
      if (this.writer.writeOutputLine) {
        this.writer.writeOutputLine({ context, sourceBegin: begin, sourceEnd: end, bytes, stream: this.stream, oversized: framed }, this.matcher, transform);
        return;
      }
      // Test/legacy sinks have no policy-owning framing port; apply the local policy once before their visible cut.
      let text = framed ? "[TRUNCATED:oversized-line]" : this.matcher.maskTextWindow(context, begin, end);
      text = this.redact.text(transform(text));
      if (this.writer.redactText) text = this.writer.redactText(text);
      if (Buffer.byteLength(text) > LIMITS.lineBytes) text = cutUtf8(text, LIMITS.lineBytes);
      this.writer.write("process.output.line", { text, untrusted: true,
        ...(framed || bytes > LIMITS.lineBytes ? { truncated: true, bytes } : {}) }, { stream: this.stream, bypassRate: true });
    }
  }
  tick(): void {
    if (this.pending && this.now() - this.last >= 1000) this.flush(false, true);
    if (this.dropped && this.now() - this.start >= 1000) this.summary();
  }
  private summary(): void { if (this.dropped) this.writer.write("process.output.suppressed", { dropped: this.dropped, window_ms: this.now() - this.start }, { stream: this.stream, bypassRate: true }); this.dropped = 0; this.start = this.now(); }
  close(): void {
    if (this.closed) return; this.consume(this.decoder.end());
    if (this.discarding && this.bytes) this.emitLine("", 0, 0, this.bytes, true);
    else this.flush(true);
    this.summary(); this.history = this.pending = ""; this.closed = true;
  }
}
/** Wrap an existing child's streams; stdout can be omitted for MCP protocol streams. Does not spawn or alter env.
 *  MCP stdio spawn lives in `packages/core/src/mcp/`: `McpConnection` feeds a stdio server's stderr (never its protocol stdout)
 *  through `OutputLines` itself (`RegistryOptions.output`, wired in `composition/`), so it does not use this helper. */
export async function wrapOutput(
  writer: LogWriter,
  streams: { stdout?: AsyncIterable<Buffer>; stderr?: AsyncIterable<Buffer> },
  o: { now?: () => number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {},
): Promise<void> {
  const start = o.setInterval ?? setInterval;
  const stop = o.clearInterval ?? clearInterval;
  await Promise.all(Object.entries(streams).map(async ([stream, input]) => {
    if (!input) return; const lines = new OutputLines(writer, stream as "stdout" | "stderr", o.now ? { now: o.now } : {});
    const timer = start(() => lines.tick(), 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    try { for await (const chunk of input) lines.push(chunk); } finally { stop(timer); lines.close(); }
  }));
}

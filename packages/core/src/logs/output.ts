import { StringDecoder } from "node:string_decoder";
import { LIMITS, type Level } from "@plur1bus/log-schema";
import { createRedactor } from "./redact.ts";
import type { LogWriter } from "./writer.ts";
/** UTF-8 byte cap, never cuts a code point. Truncation happens before writer-side redaction. */
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
export function signalLevel(s: { exitCode?: number; signal?: string; httpStatus?: number; retrying?: boolean; protocolError?: boolean }): Level {
  if (s.signal || s.protocolError || (s.exitCode !== undefined && s.exitCode !== 0)) return "error";
  if (s.httpStatus !== undefined && s.httpStatus >= 400) return s.retrying && [429, 503].includes(s.httpStatus) ? "warn" : "error";
  return "info";
}
/** Line framing keeps at most 64 KiB; oversized lines are replaced wholesale, so discarded secret suffixes cannot expose a prefix. */
export class OutputLines {
  private writer: LogWriter; private stream: "stdout" | "stderr"; private now: () => number;
  private decoder = new StringDecoder("utf8"); private line = ""; private bytes = 0; private last = 0;
  private tokens = LIMITS.rateBurst; private at: number; private start: number; private dropped = 0; private closed = false;
  private redact: { text(s: string): string } | null;
  constructor(writer: LogWriter, stream: "stdout" | "stderr", o: { now?: () => number; secrets?: Iterable<string> } = {}) {
    this.writer = writer; this.stream = stream; this.now = o.now ?? Date.now; this.at = this.now(); this.start = this.at;
    this.redact = o.secrets ? createRedactor({ secrets: new Set(o.secrets) }) : null;
  }
  push(chunk: Buffer): void { if (this.closed) throw new Error("output wrapper closed"); this.consume(this.decoder.write(chunk)); }
  private consume(text: string): void {
    for (const piece of text.split(/(?<=\n)/)) {
      const newline = piece.endsWith("\n"); const part = newline ? piece.slice(0, -1) : piece;
      this.bytes += Buffer.byteLength(part); if (this.bytes <= 65536) this.line += part;
      this.last = this.now(); if (newline) this.emitLine();
    }
  }
  private emitLine(): void {
    this.tokens = Math.min(LIMITS.rateBurst, this.tokens + Math.max(0, this.now() - this.at) * LIMITS.rateSustainedPerSecond / 1000); this.at = this.now();
    if (this.tokens < 1) this.dropped++;
    else {
      this.tokens--;
      const framed = this.bytes > 65536;
      let text = framed ? "[TRUNCATED:oversized-line]" : sanitise(this.line);
      if (!framed && Buffer.byteLength(text) > LIMITS.lineBytes) text = cutUtf8(text, LIMITS.lineBytes);
      if (this.redact) text = this.redact.text(text);
      this.writer.write("process.output.line", { text, untrusted: true,
        ...(this.bytes > LIMITS.lineBytes ? { truncated: true, bytes: this.bytes } : {}) }, { stream: this.stream, bypassRate: true });
    }
    this.line = ""; this.bytes = 0;
  }
  tick(): void {
    if (this.bytes && this.now() - this.last >= 1000) { this.consume(this.decoder.end()); this.decoder = new StringDecoder("utf8"); this.emitLine(); }
    if (this.dropped && this.now() - this.start >= 1000) this.summary();
  }
  private summary(): void { if (this.dropped) this.writer.write("process.output.suppressed", { dropped: this.dropped, window_ms: this.now() - this.start }, { stream: this.stream, bypassRate: true }); this.dropped = 0; this.start = this.now(); }
  close(): void { if (this.closed) return; this.consume(this.decoder.end()); if (this.bytes) this.emitLine(); this.summary(); this.closed = true; }
}
/** Wrap an existing child's streams; stdout can be omitted for MCP protocol streams. Does not spawn or alter env.
 *  MCP stdio spawn lives in `packages/core/src/mcp/` (out of this remainder's allowed paths): KNOWN GAP — wrap there
 *  or at the composition that holds the child streams; owner: should MCP-stdio stderr be wrapped without touching mcp/? */
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

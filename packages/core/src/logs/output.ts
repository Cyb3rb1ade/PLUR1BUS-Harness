import { StringDecoder } from "node:string_decoder";
import { LIMITS, type Level } from "@plur1bus/log-schema";
import type { LogWriter } from "./writer.ts";
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
  constructor(writer: LogWriter, stream: "stdout" | "stderr", o: { now?: () => number } = {}) {
    this.writer = writer; this.stream = stream; this.now = o.now ?? Date.now; this.at = this.now(); this.start = this.at;
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
      this.writer.write("process.output.line", { text: this.bytes > 65536 ? "[TRUNCATED:oversized-line]" : sanitise(this.line), untrusted: true,
        ...(this.bytes > 4096 ? { truncated: true, bytes: this.bytes } : {}) }, { stream: this.stream, bypassRate: true });
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
/** Wrap an existing child's streams; stdout can be omitted for MCP protocol streams. Does not spawn or alter env. */
export async function wrapOutput(writer: LogWriter, streams: { stdout?: AsyncIterable<Buffer>; stderr?: AsyncIterable<Buffer> }): Promise<void> {
  await Promise.all(Object.entries(streams).map(async ([stream, input]) => {
    if (!input) return; const lines = new OutputLines(writer, stream as "stdout" | "stderr");
    const timer = setInterval(() => lines.tick(), 1000); timer.unref();
    try { for await (const chunk of input) lines.push(chunk); } finally { clearInterval(timer); lines.close(); }
  }));
}

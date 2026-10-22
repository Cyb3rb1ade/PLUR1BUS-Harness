import { StringDecoder } from "node:string_decoder";
import { LIMITS, REDACTION, type Level } from "@plur1bus/log-schema";
import { createRedactor } from "./redact.ts";
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
  private redact: { text(s: string): string }; private inPem = false;
  constructor(writer: LogWriter, stream: "stdout" | "stderr", o: { now?: () => number; secrets?: Iterable<string> } = {}) {
    this.writer = writer; this.stream = stream; this.now = o.now ?? Date.now; this.at = this.now(); this.start = this.at;
    // Always redact here (with the process's own secrets when given): the 4096-byte cut below must not run on raw text.
    this.redact = createRedactor({ secrets: new Set(o.secrets ?? []) });
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
  private consume(text: string): void {
    for (const piece of text.split(/(?<=\n)/)) {
      const newline = piece.endsWith("\n"); const part = newline ? piece.slice(0, -1) : piece;
      this.bytes += Buffer.byteLength(part); if (this.bytes <= 65536) this.line += part;
      this.last = this.now(); if (newline) this.emitLine();
    }
  }
  private emitLine(): void {
    // Runs for every line, also one the rate limiter drops below: the block state must not depend on what is written.
    const masked = this.maskPem(sanitise(this.line));
    this.tokens = Math.min(LIMITS.rateBurst, this.tokens + Math.max(0, this.now() - this.at) * LIMITS.rateSustainedPerSecond / 1000); this.at = this.now();
    if (this.tokens < 1) this.dropped++;
    else {
      this.tokens--;
      const framed = this.bytes > 65536;
      // Redact a window twice the cut, not the whole 64 KiB: a secret that starts before the cut is matched in full or, when it runs past
      // the window, up to the window's end (every rule's minimum is far below the cut), and the cost of a hostile line stays bounded.
      let text = framed ? "[TRUNCATED:oversized-line]" : this.redact.text(masked.length > 2 * LIMITS.lineBytes ? masked.slice(0, 2 * LIMITS.lineBytes) : masked);
      if (!framed && Buffer.byteLength(text) > LIMITS.lineBytes) text = cutUtf8(text, LIMITS.lineBytes);
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

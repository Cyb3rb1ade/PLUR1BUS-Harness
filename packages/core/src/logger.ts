import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface HarnessLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): HarnessLogger;
  setLevel(level: Level): void;
  close(): Promise<void>;
}

function serializeError(v: unknown): unknown {
  return v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
}

/** A line sink that rotates by size (S17): checked before each write, `<file>.1` newest … `<file>.<keep>` oldest.
 *  Synchronous appends, so a rotation never races a queued write and every line lands in exactly one file. */
function rotatingSink(file: string, maxBytes: number, keep: number): { write(line: string): void; close(): void } {
  let closed = false;
  let fd: number | null = null; let size = 0;
  const open = () => { fd = openSync(file, "a", 0o600); size = fstatSync(fd).size; };
  function rotate(): void {
    if (fd !== null) { closeSync(fd); fd = null; }
    try {
      rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    } catch { /* e.g. a reader holds a file open on Windows: keep appending, retry at the next write */ }
    open();
  }
  open();
  return {
    // A logger failure never escapes into the caller (timer callbacks, stop steps): the line is dropped, and a
    // file that could not be reopened is reopened lazily on the next write.
    write(line) {
      if (closed) return;
      try {
        if (fd === null) open();
        const buf = Buffer.from(line, "utf8");
        if (size > 0 && size + buf.length > maxBytes) rotate();
        writeSync(fd!, buf); size += buf.length;
      } catch { /* dropped */ }
    },
    close() { closed = true; if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } fd = null; } },
  };
}

export function createLogger(o: { file: string; level: Level; role: string; stream?: WriteStream; maxBytes?: number; keep?: number }): HarnessLogger {
  mkdirSync(dirname(o.file), { recursive: true });
  const sink = !o.stream && o.maxBytes !== undefined
    ? rotatingSink(o.file, o.maxBytes, Math.max(1, o.keep ?? 5))
    : (() => {
      const stream = o.stream ?? createWriteStream(o.file, { flags: "a" });
      return { write: (line: string) => { stream.write(line); }, close: () => new Promise<void>((res) => stream.end(() => res())) };
    })();
  let level = o.level;
  const make = (base: Record<string, unknown>): HarnessLogger => {
    const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const rec: Record<string, unknown> = { at: new Date().toISOString(), level: lvl, role: o.role, ...base, ...fields, msg };
      for (const k of Object.keys(rec)) rec[k] = serializeError(rec[k]);
      sink.write(`${JSON.stringify(rec)}\n`);
    };
    return {
      debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f),
      child: (fields) => make({ ...base, ...fields }),
      setLevel: (l) => { level = l; },
      close: async () => { await sink.close(); },
    };
  };
  return make({});
}

/** Adapter to the engine's Logger shape (message + rest args). */
export function engineLoggerFrom(log: HarnessLogger) {
  const fields = (rest: unknown[]) => (rest.length ? { rest: rest.map(serializeError) } : undefined);
  return {
    info: (m: string, ...r: unknown[]) => log.info(m, fields(r)), warn: (m: string, ...r: unknown[]) => log.warn(m, fields(r)),
    error: (m: string, ...r: unknown[]) => log.error(m, fields(r)), debug: (m: string, ...r: unknown[]) => log.debug(m, fields(r)),
  };
}

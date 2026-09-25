import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
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

export function createLogger(o: { file: string; level: Level; role: string; stream?: WriteStream }): HarnessLogger {
  mkdirSync(dirname(o.file), { recursive: true });
  const stream = o.stream ?? createWriteStream(o.file, { flags: "a" });
  let level = o.level;
  const make = (base: Record<string, unknown>): HarnessLogger => {
    const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const rec: Record<string, unknown> = { at: new Date().toISOString(), level: lvl, role: o.role, ...base, ...fields, msg };
      for (const k of Object.keys(rec)) rec[k] = serializeError(rec[k]);
      stream.write(`${JSON.stringify(rec)}\n`);
    };
    return {
      debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f),
      child: (fields) => make({ ...base, ...fields }),
      setLevel: (l) => { level = l; },
      close: () => new Promise((res) => stream.end(() => res())),
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

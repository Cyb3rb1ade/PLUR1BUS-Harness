// The one bootstrap seam: two example sources without migrating every legacy call site.
import type { HarnessLogger } from "@plur1bus/module-api";
import { createWriter } from "./writer.ts";
import type { WriterOptions } from "./writer.ts";
export function createCoreLog(o: WriterOptions): HarnessLogger {
  const writer = createWriter(o); let closed = false;
  writer.write("core.process.started", { pid: process.pid });
  const crashFlush = () => { try { writer.tick(true); writer.flush(); } catch { /* preserve the original crash */ } };
  process.on("uncaughtExceptionMonitor", crashFlush); process.on("exit", crashFlush);
  const make = (base: Record<string, unknown>): HarnessLogger => {
    const write = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => {
      if (closed) return;
      try {
        const f = { ...base, ...fields };
        if (msg === "core ready") { writer.write("core.process.ready", { pid: process.pid }); writer.flush(); return; }
        if (msg === "core stopped") { writer.write("core.process.stopping", { pid: process.pid }); return; }
        if (msg === "dreams run.finished" && f.outcome === "skipped" && typeof f.reason === "string") {
          writer.write("scheduler.run.skipped", { job: `dream.${String(f.phase ?? "rem")}`, reason: f.reason }, { source: { kind: "harness", id: "scheduler", version: o.source.version } }); return;
        }
        if (["compaction.summary.created", "compaction.prune.hidden", "compaction.prune.restored"].includes(msg)) {
          writer.write(msg, f); return;
        }
        // Untouched callers keep the legacy wire format, but cannot bypass writer-side redaction.
        writer.writeLegacy(level, msg, f);
      } catch { /* A logger failure must not escape into Core timer callbacks or shutdown steps. */ }
    };
    return {
      debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f),
      child: fields => make({ ...base, ...fields }),
      setLevel(level) { writer.updateLevels({ defaultLevel: level }); },
      setRotation(r) { writer.setRotation(r); },
      async close() { if (closed) return; closed = true; process.off("uncaughtExceptionMonitor", crashFlush); process.off("exit", crashFlush); writer.close(); },
    };
  };
  return make({});
}

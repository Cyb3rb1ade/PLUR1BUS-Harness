import { countJournalLines, drainJournal, type JournalOpts } from "./journal.ts";
import type { HarnessLogger } from "./logger.ts";

/** rpc.schema.json `$defs/JournalReplayStatus`: the background journal replay (B2). `kept` is the on-disk count after
 *  the last pass; `passes` is set when the replay ends. */
export interface JournalReplayStatus {
  state: "replaying" | "done" | "aborted" | "failed";
  replayed: number; kept: number; passes: number; startedAt: number; finishedAt: number | null;
}

export interface JournalReplay {
  status(): JournalReplayStatus;
  /** Resolves when the replay ended, whatever the outcome; never rejects. */
  readonly done: Promise<void>;
  /** H3B-R2: the replay logs nothing from here on (a stop that stopped waiting for the capture in flight calls it,
   *  so nothing lands in core.log after stop() resolved). */
  detachLogger(): void;
}

/** A logger that forwards to `target()` while it returns one. */
function detachable(target: () => HarnessLogger | null): HarnessLogger {
  return {
    debug: (m, f) => target()?.debug(m, f), info: (m, f) => target()?.info(m, f),
    warn: (m, f) => target()?.warn(m, f), error: (m, f) => target()?.error(m, f),
    child: (fields) => detachable(() => target()?.child(fields) ?? null),
    setLevel: (l) => target()?.setLevel(l),
    close: async () => {},
  };
}

/** B2: drains the journal (I2 passes) in the background while the core serves. `o.signal` stops it between lines
 *  (journal.ts); `onDone` runs once with the final status. An empty journal is `done` with zeros at once. */
export function startJournalReplay(o: JournalOpts & { signal: AbortSignal; onDone?: (s: JournalReplayStatus) => void }): JournalReplay {
  let target: HarnessLogger | null = o.logger;
  const logger = detachable(() => target);
  const st: JournalReplayStatus = { state: "replaying", replayed: 0, kept: 0, passes: 0, startedAt: o.clock(), finishedAt: null };
  const finish = (state: JournalReplayStatus["state"], r?: { replayed: number; kept: number; passes: number }) => {
    st.state = state; st.finishedAt = o.clock();
    if (r) { st.replayed = r.replayed; st.kept = r.kept; st.passes = r.passes; }
    try { o.onDone?.({ ...st }); } catch (err) { logger.error("journal: replay onDone failed", { err }); }
  };

  let empty = false;
  try { empty = countJournalLines({ dir: o.dir, logger }) === 0; } catch { /* listing failed: the drain reports it */ }
  let done: Promise<void>;
  if (empty) { finish("done"); done = Promise.resolve(); }
  else {
    done = drainJournal({ ...o, logger, onLineReplayed: () => { st.replayed += 1; o.onLineReplayed?.(); } })
      .then((r) => { finish(o.signal.aborted ? "aborted" : "done", r); logger.info("journal: replay finished", { ...st }); })
      .catch((err: unknown) => { logger.error("journal: replay failed", { err }); finish("failed"); });
  }
  return { status: () => ({ ...st }), done, detachLogger: () => { target = null; } };
}

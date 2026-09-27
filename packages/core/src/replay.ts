import { countJournalLines, drainJournal, type JournalOpts } from "./journal.ts";
import type { HarnessLogger } from "./logger.ts";

/** rpc.schema.json `$defs/JournalReplayStatus`: the background journal replay (B2). `replayed` counts the lines that
 *  left the journal; `pendingRemoval` those among them still in the `.replaying-*` file in progress (it is removed
 *  when the replay finishes it). `kept` is the on-disk count after the last pass; `passes` is set when it ends. */
export interface JournalReplayStatus {
  state: "replaying" | "done" | "aborted" | "failed";
  replayed: number; pendingRemoval: number; kept: number; passes: number; startedAt: number; finishedAt: number | null;
}

export interface JournalReplay {
  status(): JournalReplayStatus;
  /** Resolves when the replay ended, whatever the outcome; never rejects. */
  readonly done: Promise<void>;
  /** H3B-R2: a stop that stopped waiting for the capture in flight. The replay is `aborted` from here on, logs
   *  nothing more and leaves the file in progress untouched for the next start (journal.ts `ReplayHooks.abandoned`). */
  abandon(): void;
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
 *  (journal.ts); `onDone` runs once with the final status (not after `abandon()`). An empty journal is `done` with
 *  zeros at once. The state is `aborted` only when the signal left lines unreplayed. */
export function startJournalReplay(o: Omit<JournalOpts, "hooks"> & { signal: AbortSignal; onDone?: (s: JournalReplayStatus) => void }): JournalReplay {
  let target: HarnessLogger | null = o.logger;
  const logger = detachable(() => target);
  const st: JournalReplayStatus = { state: "replaying", replayed: 0, pendingRemoval: 0, kept: 0, passes: 0, startedAt: o.clock(), finishedAt: null };
  let cut = false; let abandoned = false;
  const finish = (state: JournalReplayStatus["state"], r?: { replayed: number; kept: number; passes: number }) => {
    if (abandoned) return;
    st.state = state; st.finishedAt = o.clock(); st.pendingRemoval = 0;
    if (r) { st.replayed = r.replayed; st.kept = r.kept; st.passes = r.passes; }
    try { o.onDone?.({ ...st }); } catch (err) { logger.error("journal: replay onDone failed", { err }); }
  };

  let empty = false;
  try { empty = countJournalLines({ dir: o.dir, logger }) === 0; } catch { /* listing failed: the drain reports it */ }
  let done: Promise<void>;
  if (empty) { finish("done"); done = Promise.resolve(); }
  else {
    const hooks = {
      lineReplayed: () => { if (!abandoned) { st.replayed += 1; st.pendingRemoval += 1; } },
      fileDone: () => { if (!abandoned) st.pendingRemoval = 0; },
      cut: () => { cut = true; },
      abandoned: () => abandoned,
    };
    done = drainJournal({ ...o, logger, hooks })
      .then((r) => { finish(cut && o.signal.aborted ? "aborted" : "done", r); logger.info("journal: replay finished", { ...st }); })
      .catch((err: unknown) => { logger.error("journal: replay failed", { err }); finish("failed"); });
  }
  const abandon = () => {
    if (abandoned || st.finishedAt !== null) { target = null; return; }
    // The lines replayed from the file in progress stay in it (it is left as it is): they have not left the journal.
    st.replayed -= st.pendingRemoval; st.pendingRemoval = 0;
    st.state = "aborted"; st.finishedAt = o.clock();
    abandoned = true; target = null;
  };
  return { status: () => ({ ...st }), done, abandon };
}

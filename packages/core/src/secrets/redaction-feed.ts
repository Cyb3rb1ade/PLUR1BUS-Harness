// Phase 4 (P4-20 flip A, docs/phase4/bridge.md): the redaction feed of `legacy.redaction.changes`.
//
// Behind the Rust front door two processes write log lines and one of them answers `logs.query`, so both have to mask the
// same values. This core holds the registry; the front door mirrors it by asking for its changes on the control link (a
// long poll). The feed is the journal between the two: a subscriber of the registry that only appends, and the answer to
// one call.
//
// Numbers. Every change gets the next number of the current epoch, starting at 1. A call acknowledges with `after` what
// the front door has applied; the journal forgets up to there. An epoch ends when the caller names another one (its first
// call names none) or when the journal had to be dropped: the next answer then starts a new epoch at 1 with the whole
// registry, because subscribing again replays it.
//
// Values travel in the answer only, under the key `secret` (a recording that hides by key name hides them), and are
// never logged here.
import type { SecretRedaction } from "./redaction.ts";

/** One change: a value and whether a store name or a group holds it now. */
export interface RedactionChange { secret: string; pinned: boolean }
export interface RedactionChangesParams { epoch: string; after: number; waitMs: number; maxBytes: number }
export interface RedactionChangesResult { epoch: string; next: number; secrets: RedactionChange[]; more: boolean }

/** How many changes may wait for the front door beyond the replay of an epoch. The front door asks all the time, so a
 *  journal this long means nobody is asking any more; it is dropped, and whoever asks next starts a new epoch. */
export const MAX_UNSENT_CHANGES = 8192;
/** What one change costs in an answer beside its value (the member names, the flag, the punctuation). */
const CHANGE_OVERHEAD_BYTES = 32;

export interface RedactionFeed {
  changes(params: RedactionChangesParams): Promise<RedactionChangesResult>;
  /** Ends the subscription and every waiting call. */
  close(): void;
}

export function createRedactionFeed(o: {
  redaction: Pick<SecretRedaction, "subscribe">;
  /** Core stop: a waiting call answers at once. */
  signal?: AbortSignal;
  /** Test seam for the bound. */
  maxUnsent?: number;
}): RedactionFeed {
  const maxUnsent = o.maxUnsent ?? MAX_UNSENT_CHANGES;
  let epochs = 0;
  let epoch = "";
  let journal: RedactionChange[] = [];
  /** The number of `journal[0]`. */
  let first = 1;
  /** The journal may grow to this length. Without a bound during the replay of an epoch (that is as long as the registry
   *  is); afterwards the replay's length and `maxUnsent` more. */
  let limit = Infinity;
  let dropped = false;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const waiting = new Set<() => void>();
  const wake = (): void => { for (const resume of [...waiting]) resume(); };

  // Runs inside the registering call, under the secret store's lock: append and return.
  const sink = (value: string, info: { pinned: boolean }): void => {
    if (dropped) return;
    if (journal.length >= limit) { dropped = true; journal = []; wake(); return; }
    journal.push({ secret: value, pinned: info.pinned });
    wake();
  };
  const restart = (): void => {
    unsubscribe?.();
    epoch = String(++epochs);
    journal = []; first = 1; limit = Infinity; dropped = false;
    unsubscribe = o.redaction.subscribe(sink); // replays the whole registry, synchronously
    limit = journal.length + maxUnsent;
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); waiting.delete(done); o.signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    waiting.add(done);
    o.signal?.addEventListener("abort", done, { once: true });
  });

  return {
    async changes(p) {
      if (closed) throw new Error("the redaction feed is closed");
      let after = p.after;
      let fresh = false;
      // Another epoch than ours (the first call names none), a dropped journal, or an acknowledgement beyond what was
      // ever sent: the caller's picture is not ours. It gets a new one from the start.
      if (unsubscribe === undefined || p.epoch !== epoch || dropped || after > first + journal.length - 1) { restart(); after = 0; fresh = true; }
      const acknowledged = Math.max(0, after - first + 1);
      journal.splice(0, acknowledged);
      first += acknowledged;
      // A new epoch is answered at once, also when the registry is empty: the caller must learn the epoch.
      if (journal.length === 0 && !fresh && p.waitMs > 0 && !o.signal?.aborted) {
        await wait(p.waitMs);
        if (closed) throw new Error("the redaction feed is closed");
        // While this call waited the journal may have been dropped (a new epoch begins here), or another call may have
        // begun one (the answer is then that epoch's journal, from where the front door has acknowledged it).
        if (dropped) restart();
      }
      const secrets: RedactionChange[] = [];
      let bytes = 0;
      for (const change of journal) {
        const size = Buffer.byteLength(JSON.stringify(change.secret)) + CHANGE_OVERHEAD_BYTES;
        if (secrets.length > 0 && bytes + size > p.maxBytes) break;
        secrets.push(change);
        bytes += size;
      }
      return { epoch, next: first + secrets.length - 1, secrets, more: secrets.length < journal.length };
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      journal = [];
      wake();
    },
  };
}

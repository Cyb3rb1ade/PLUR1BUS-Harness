/** Trusted native-helper fd 3 only. Child stderr must never feed this parser. */
const CAUSES = ["sample-deadline", "identity-unavailable", "list-safety-cap", "list-unavailable", "descendant-safety-cap", "task-info-unavailable", "attach-limit"] as const;
const OPERATIONS = ["sample", "bsd-info", "alive", "group-size", "group-list", "group-member", "child-size", "child-list", "child-member", "task-info", "membership"] as const;
const NUMBERS = ["sample", "elapsedMicros", "pid", "returned", "expected", "errno", "probeReturned", "probeErrno", "ppid", "pgid", "status", "startSeconds", "startMicros", "processRssBytes", "count", "rssBytes"] as const;
const KEYS = new Set<string>(["version", "cause", "operation", "phase", ...NUMBERS]);
export const WATCHDOG_DETAIL_MAX_BYTES = 2048;
export type WatchdogDetail = {
  version: 1;
  cause: typeof CAUSES[number];
  operation: typeof OPERATIONS[number];
  phase: "attach" | "runtime";
} & Record<typeof NUMBERS[number], number>;

/** Reject unknown strings/fields and malformed numbers rather than relaying native or child text. */
export function parseWatchdogDetail(text: string): WatchdogDetail | undefined {
  if (Buffer.byteLength(text) > WATCHDOG_DETAIL_MAX_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== KEYS.size || Object.keys(record).some(key => !KEYS.has(key))) return undefined;
    if (record.version !== 1 || !CAUSES.includes(record.cause as WatchdogDetail["cause"])
      || !OPERATIONS.includes(record.operation as WatchdogDetail["operation"])
      || (record.phase !== "attach" && record.phase !== "runtime")) return undefined;
    for (const field of NUMBERS) {
      const n = record[field];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < (field === "returned" || field === "probeReturned" ? -1 : 0)) return undefined;
    }
    return record as WatchdogDetail;
  } catch { return undefined; }
}

/** Drain arbitrary chunks, but retain at most the one bounded helper record. Overflow stays invalid. */
export class WatchdogDetailBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  accept(chunk: Buffer): void {
    if (this.#bytes > WATCHDOG_DETAIL_MAX_BYTES) return;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > WATCHDOG_DETAIL_MAX_BYTES) { this.#chunks = []; return; }
    this.#chunks.push(Buffer.from(chunk));
  }
  finish(): WatchdogDetail | undefined {
    return this.#bytes > WATCHDOG_DETAIL_MAX_BYTES ? undefined : parseWatchdogDetail(Buffer.concat(this.#chunks).toString("utf8"));
  }
}

/** Only this internal typed error adds a native diagnostic to an ACP refusal. */
export class WatchdogFailure extends Error {
  readonly detail: WatchdogDetail;
  constructor(detail: WatchdogDetail) { super("sandbox-unavailable"); this.detail = detail; }
}

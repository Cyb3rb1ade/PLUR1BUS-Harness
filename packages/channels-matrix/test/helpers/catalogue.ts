import { MatrixChannel, MemorySyncTokenStore } from "../../src/index.ts";
import type { MatrixEvent } from "../../src/events.ts";
import type { ChannelHost, InboundMessage } from "../../../core/src/channels/types.ts";
import { BOT, CAROL, FAKE_TOKEN, ROOM, textMessage, type FakeMatrix } from "./fake-matrix.ts";
import { SECRET_NAME, newFake } from "./rig.ts";

export interface LogLine {
  level: string;
  event: string;
  attrs: Record<string, unknown>;
}

export interface CatalogueHarness {
  readonly channel: MatrixChannel;
  /** The framework host the channel is started with (receive/fail/log). */
  readonly host: ChannelHost;
  readonly fake: FakeMatrix;
  /** What the channel handed to host.receive, in order. */
  readonly received: InboundMessage[];
  /** What the channel reported through host.fail. */
  readonly failures: unknown[];
  /** Every line the channel wrote to its constructor logger (all levels). */
  readonly logs: LogLine[];
  /** Backoff and bucket waits the channel asked for, in milliseconds, in order. */
  readonly sleeps: number[];
  /** Park sleeps until releaseSleeps() instead of resolving them at once. */
  setHoldSleeps(hold: boolean): void;
  releaseSleeps(): void;
  /** Make every /sync request fail at the transport level (connection lost) while true. */
  setConnectionDown(down: boolean): void;
  /** A text message from an ordinary group member in the allowlisted room (replyPolicy "always" lets it through). */
  event(text: string, eventId?: string): MatrixEvent;
  /** channel.start(host), then waits until the sync loop is parked on a long poll. Not usable when the loop ends (fatal errors). */
  start(): Promise<void>;
  /** Resolves once pred() holds; re-checked every millisecond and on every host call and sleep. Rejects after 5 s. */
  waitFor(pred: () => boolean, what: string): Promise<void>;
  /** Event ids of the room timelines in every /sync answer the channel received, one entry per answer, in order. */
  syncBatches(): string[][];
  /** Texts of the m.room.message events the fake homeserver accepted from the bot. */
  sentTexts(): string[];
  dispose(): Promise<void>;
}

/**
 * Contract-catalogue harness: a real MatrixChannel against the in-process homeserver fake, with injected sleep and fetch
 * seams so no test waits on a wall clock. Resumed by default (a stored sync position, so no initial sync): events and
 * failures queued before start then reach the sync loop instead of being swallowed by the initial sync, which discards
 * timeline history and is not covered by the loop's retry. Pass `resumed: false` for a cold first start.
 */
export async function makeCatalogueHarness(opts: { resumed?: boolean } = {}): Promise<CatalogueHarness> {
  const resumed = opts.resumed ?? true;
  const fake = await newFake();

  const received: InboundMessage[] = [];
  const failures: unknown[] = [];
  const logs: LogLine[] = [];
  const sleeps: number[] = [];
  const parked: Array<() => void> = [];
  let holdSleeps = false;
  let connectionDown = false;
  let eventNo = 0;

  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };
  // Predicates may read fake-side state (requests the channel made), which raises no host event; the 1 ms re-check covers that.
  const waitFor = (pred: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        waiters.delete(check);
        clearInterval(recheck);
        clearTimeout(guard);
        resolve();
      };
      const recheck = setInterval(check, 1);
      // Failure guard only: a healthy run resolves long before this fires.
      const guard = setTimeout(() => {
        waiters.delete(check);
        clearInterval(recheck);
        reject(new Error(`timeout: ${what}`));
      }, 5000);
      waiters.add(check);
      check();
    });

  const batches: string[][] = [];
  const realFetch = globalThis.fetch;
  // A lost connection is modelled as a transport failure on /sync; everything else reaches the fake. Each /sync answer is also
  // recorded (event ids of its room timelines) so a test can prove a duplicate really was on the wire.
  const fetchWithOutage: typeof fetch = async (input, init) => {
    const isSync = String(input).includes("/_matrix/client/v3/sync");
    if (connectionDown && isSync) throw new TypeError("fetch failed");
    const res = await realFetch(input, init);
    if (isSync && res.ok) {
      try {
        const body = (await res.clone().json()) as { rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> } };
        const ids = Object.values(body.rooms?.join ?? {}).flatMap((r) => (r.timeline?.events ?? []).map((e) => String(e.event_id)));
        batches.push(ids);
      } catch {
        /* aborted while the body was streaming: nothing to record */
      }
    }
    return res;
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    changed();
    if (!holdSleeps || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      parked.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const channel = new MatrixChannel({
    homeserverUrl: fake.baseUrl,
    userId: BOT,
    accessTokenSecret: SECRET_NAME,
    allowlist: [ROOM],
    dmAllowlist: [],
    replyPolicy: "always",
    secrets: { reveal: async (n: string) => (n === SECRET_NAME ? FAKE_TOKEN : null) },
    syncStore: new MemorySyncTokenStore(resumed ? "s0" : undefined),
    logger: { log: (level, event, attrs) => void logs.push({ level, event, attrs: { ...attrs } }) },
    fetch: fetchWithOutage,
    sleep,
    random: () => 0.5,
    syncTimeoutMs: 5000,
  });

  const host: ChannelHost = {
    receive: async (msg) => {
      received.push(msg);
      changed();
    },
    fail: (err) => {
      failures.push(err);
      changed();
    },
    log: {
      info: () => changed(),
      warn: () => changed(),
      error: () => changed(),
    },
  };

  return {
    channel,
    host,
    fake,
    received,
    failures,
    logs,
    sleeps,
    setHoldSleeps: (hold) => {
      holdSleeps = hold;
    },
    releaseSleeps: () => {
      for (const r of parked.splice(0)) r();
    },
    setConnectionDown: (down) => {
      connectionDown = down;
    },
    event: (text, eventId) => fake.message(ROOM, CAROL, textMessage(text), eventId ?? `$cat${++eventNo}`),
    start: async () => {
      await channel.start(host);
      await fake.waitIdle();
    },
    waitFor,
    syncBatches: () => batches.map((b) => [...b]),
    sentTexts: () =>
      fake.sent.filter((s) => s.type === "m.room.message" && typeof s.content.body === "string").map((s) => s.content.body as string),
    dispose: async () => {
      holdSleeps = false;
      await channel.stop();
      for (const r of parked.splice(0)) r();
      await fake.close();
    },
  };
}

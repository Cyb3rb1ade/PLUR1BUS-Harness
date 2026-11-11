// A raw NDJSON JSON-RPC connection for the parity harness. It deliberately does not use `@plur1bus/module-api`'s client:
// the replayer must be able to send frames exactly as recorded (including frames a well-behaved client never sends) and
// must see every frame the core writes, in arrival order.
import { connect as netConnect, type Socket } from "node:net";
import { LineDecoder, encodeLine } from "@plur1bus/module-api";

export interface RawConnection {
  /** Every frame received so far, in arrival order. */
  readonly received: any[];
  send(msg: unknown): void;
  /** Resolves with the first frame for which `pick` is true; rejects after `timeoutMs`. */
  waitFor(pick: (frame: any) => boolean, what: string, timeoutMs?: number): Promise<any>;
  /** Resolves true once `received.length >= count`, false after `timeoutMs` or when the peer closed first. */
  waitForCount(count: number, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export function rawConnect(address: string): Promise<RawConnection> {
  return new Promise((resolve, reject) => {
    const sock: Socket = netConnect(address);
    const dec = new LineDecoder();
    const received: any[] = [];
    const waiters = new Set<() => void>();
    let closed = false;
    sock.on("data", (chunk) => {
      const { values } = dec.decode(chunk);
      if (values.length) { received.push(...values); for (const w of [...waiters]) w(); }
    });
    sock.on("close", () => { closed = true; for (const w of [...waiters]) w(); });
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.off("error", reject);
      sock.on("error", () => {});
      const until = (ready: () => boolean, timeoutMs: number): Promise<boolean> => new Promise((res) => {
        if (ready()) return res(true);
        const done = (v: boolean) => { clearTimeout(timer); waiters.delete(check); res(v); };
        const check = () => { if (ready()) done(true); else if (closed) done(false); };
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.add(check);
      });
      resolve({
        received,
        send: (msg) => { sock.write(encodeLine(msg)); },
        async waitFor(pick, what, timeoutMs = 10_000) {
          if (!await until(() => received.some(pick), timeoutMs)) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
          return received.find(pick);
        },
        waitForCount: (count, timeoutMs) => until(() => received.length >= count, timeoutMs),
        close: () => new Promise<void>((res) => { if (closed) return res(); sock.once("close", () => res()); sock.end(); setTimeout(() => sock.destroy(), 500).unref(); }),
      });
    });
  });
}

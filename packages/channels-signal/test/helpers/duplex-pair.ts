import { Duplex } from "node:stream";

/** Two connected in-memory duplex streams: what one writes, the other reads. */
export function duplexPair(): [Duplex, Duplex] {
  let a: Duplex, b: Duplex;
  const make = (other: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        other().push(chunk);
        cb();
      },
      final(cb) {
        other().push(null);
        cb();
      },
      destroy(err, cb) {
        if (!other().destroyed) other().push(null);
        cb(err);
      },
    });
  a = make(() => b);
  b = make(() => a);
  return [a, b];
}

/** A deadline timer that only fires when the test says so (never on its own). */
export function manualTimeout() {
  const waiting: Array<() => void> = [];
  const fn = (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const fire = () => resolve();
      waiting.push(fire);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  return {
    fn,
    /** Fire every deadline that has been armed so far. */
    fireAll() {
      for (const f of waiting.splice(0)) f();
    },
  };
}
export const neverTimeout = manualTimeout().fn;

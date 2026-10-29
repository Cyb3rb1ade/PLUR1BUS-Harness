import assert from "node:assert/strict";

/** Polls `pred` once per event-loop turn (`setImmediate`) until it holds, and fails after `ms` with `what`. Given `run`,
 *  it also fails as soon as `run` settles while `pred` still does not hold, and says how it settled, so a rejected run is
 *  reported here instead of as an unhandled rejection; pass only a `run` the test awaits afterwards, since the handler
 *  attached here would otherwise hide a later rejection. Every poll in a test needs this bound: node:test marks a test
 *  failed on an unhandled rejection or its timeout but does not stop the test function, and an endless poll keeps the
 *  file's process, and with it the whole test run, alive. */
export async function until(pred: () => boolean, what: string, opts: { run?: Promise<unknown>; ms?: number } = {}): Promise<void> {
  const ms = opts.ms ?? 10_000;
  let settled: string | undefined;
  opts.run?.then(() => { settled = "resolved"; }, (e: unknown) => { settled = `rejected with ${e instanceof Error ? e.message : String(e)}`; });
  const end = Date.now() + ms;
  while (!pred()) {
    if (settled !== undefined) assert.fail(`the run ${settled} while waiting for ${what}`);
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

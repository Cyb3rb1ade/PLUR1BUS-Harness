/** A cancelled credential acquisition must finish even when its backend ignores cancellation.
 * Late values still have an owner: release them before dropping the abandoned operation.
 */
export function acquireLease<T>(acquire: () => Promise<T>, release: (value: T) => void,
  signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const detach = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true; detach();
      // Abort reasons and backend exceptions can contain credentials; do not copy them into this error.
      reject(new Error("secret lease acquisition aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    let work: Promise<T>;
    try { work = acquire(); } catch (error) {
      settled = true; detach(); reject(error); return;
    }
    work.then(value => {
      if (settled) {
        try { release(value); } catch { /* The owner supplies bounded, best-effort revocation for late values. */ }
        return;
      }
      settled = true; detach(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; detach(); reject(error);
    });
  });
}

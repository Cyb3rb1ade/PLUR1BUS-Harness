/**
 * UI-side deadline for native `invoke` calls. Tauri cannot cancel a command that is already running, so the deadline
 * only stops the view from waiting: the promise settles with `TIMEOUT` and a late answer is dropped. IPC errors are
 * plain code strings everywhere else in the UI, so the timeout is one too.
 */
export const TIMEOUT = "timeout";
export function isTimeout(error: unknown): boolean { return error === TIMEOUT; }
export function withDeadline<T>(start: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMEOUT), ms);
    start().then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

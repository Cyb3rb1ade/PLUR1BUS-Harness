/** The owned Git child of one checkpoint operation. */
import { spawn } from "node:child_process";

const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;

export async function checkpointGitProcess(args: readonly string[], options: {
  signal: AbortSignal; env: NodeJS.ProcessEnv;
}): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    // Do not give spawn a signal: its AbortError precedes close and would let the temporary index disappear early.
    const child = spawn("git", [...args], { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const output: string[] = [];
    let bytes = 0, failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => {
      if (failure !== undefined) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, KILL_GRACE_MS);
    };
    const abort = () => stop(Object.assign(new Error("checkpoint Git aborted", { cause: options.signal.reason }), { name: "AbortError" }));
    const deadline = setTimeout(() => stop(Object.assign(new Error("checkpoint Git timed out"), { name: "TimeoutError" })), TIMEOUT_MS);
    const data = (chunk: string, stdout: boolean) => {
      if (failure !== undefined) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_BYTES) { stop(new Error("checkpoint Git output limit exceeded")); return; }
      if (stdout) output.push(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => data(chunk, true));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => data(chunk, false));
    child.on("error", error => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(deadline); clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error("checkpoint Git failed"), { code, signal }));
      else resolve(output.join(""));
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
}

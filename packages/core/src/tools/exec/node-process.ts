// The real ProcessPort. POSIX: the child leads its own process group and the whole group is killed. Windows: Node has no
// job-object API, so the tree is ended with `taskkill /PID <pid> /T /F` (run through an injectable runner).
// RULING: no SIGTERM grace period; an exec that must stop is stopped.
import { spawn, type ChildProcess } from "node:child_process";
import type { ExitInfo, ProcessHandle, ProcessPort, SpawnSpec, TimerPort } from "./types.ts";

export type TaskkillRunner = (args: readonly string[]) => Promise<void>;

const defaultTaskkill: TaskkillRunner = (args) =>
  new Promise((resolve) => {
    try {
      const k = spawn("taskkill", [...args], { stdio: "ignore", windowsHide: true, shell: false });
      k.once("error", () => resolve());
      k.once("close", () => resolve());
    } catch { resolve(); }
  });

export function createNodeProcessPort(o: { platform?: NodeJS.Platform; taskkill?: TaskkillRunner } = {}): ProcessPort {
  const platform = o.platform ?? process.platform;
  const windows = platform === "win32";
  const taskkill = o.taskkill ?? defaultTaskkill;
  return {
    spawn(spec: SpawnSpec): ProcessHandle {
      const child: ChildProcess = spawn(spec.program, [...spec.args], {
        cwd: spec.cwd, env: { ...spec.env }, shell: false, windowsHide: true, detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let exited = false;
      let killing: Promise<void> | undefined;
      const sweepGroup = (): void => {
        if (windows || child.pid === undefined) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
      };
      const done = new Promise<ExitInfo>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => { exited = true; sweepGroup(); resolve({ code, signal }); });
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      return {
        pid: child.pid,
        onStdout: (cb) => { child.stdout?.on("data", cb); },
        onStderr: (cb) => { child.stderr?.on("data", cb); },
        // Output is complete when the pipes close; after a kill they are destroyed so a stray grandchild cannot hold us.
        async wait() { const x = await done; await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2_000).unref())]); child.stdout?.destroy(); child.stderr?.destroy(); return x; },
        killTree() {
          killing ??= (async () => {
            if (child.pid === undefined) return;
            if (windows) { if (!exited) await taskkill(["/PID", String(child.pid), "/T", "/F"]); }
            else sweepGroup();
            try { child.kill("SIGKILL"); } catch { /* gone */ }
            child.stdout?.destroy(); child.stderr?.destroy();
          })();
          return killing;
        },
      };
    },
  };
}

export const systemTimers: TimerPort = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

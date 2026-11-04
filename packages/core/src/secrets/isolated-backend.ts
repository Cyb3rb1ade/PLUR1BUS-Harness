import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SecretError, type SecretBackend } from "./types.ts";
import { SECRET_ERROR_CODES, type BackendDescription, type BackendOperation, type BackendReply } from "./isolated-protocol.ts";

export const SECRET_IO_BUDGET_MS = 3000;
const CLOSE_BUDGET_MS = 250;
export interface IsolatedBackendOptions {
  budgetMs?: number;
  /** Trusted in-process test seam. No environment variable can select an executable or fixture module. */
  spawn?: (description: BackendDescription) => ChildProcess;
  onUnavailable?: () => void;
}

/** esbuild preserves import.meta.url; bundled helpers live beside core.js, source helpers one directory above this module. */
export function isolatedBackendHelper(moduleUrl = import.meta.url): URL {
  return new URL(moduleUrl.endsWith(".ts") ? "../secrets-isolated-bin.ts" : "./secrets-isolated-bin.js", moduleUrl);
}
function spawnBackend(): ChildProcess {
  const helper = isolatedBackendHelper();
  return fork(fileURLToPath(helper), [], {
    execArgv: helper.pathname.endsWith(".ts") ? ["--experimental-strip-types", "--conditions=source"] : [],
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true,
  });
}
const unavailable = () => new SecretError("backend-unavailable", "Secret-Store unavailable");

export function createIsolatedBackend(description: BackendDescription, o: IsolatedBackendOptions = {}): {
  backend: SecretBackend; cancel(): void; close(): Promise<void>;
} {
  type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout; register?: (value: string) => void };
  type Running = { child: ChildProcess; pending: Map<number, Pending>; dead: boolean };
  let running: Running | undefined, closed = false, sequence = 0;
  const retiring = new Set<Promise<void>>();

  function retire(r: Running): void {
    if (r.dead) return;
    r.dead = true;
    if (running === r) running = undefined;
    // Invalidate the generation before rejecting requests or touching the process/channel.
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(unavailable()); }
    r.pending.clear();
    const stopped = new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); r.child.off("exit", finish); resolve(); };
      const timer = setTimeout(finish, CLOSE_BUDGET_MS);
      r.child.once("exit", finish);
      if (r.child.exitCode !== null || r.child.signalCode !== null) finish();
    });
    retiring.add(stopped);
    void stopped.then(() => retiring.delete(stopped));
    try { if (r.child.connected) r.child.disconnect(); } catch { /* Already disconnected. */ }
    try { r.child.kill("SIGKILL"); } catch { /* No unbounded exit wait, including a stuck OS syscall. */ }
    r.child.unref(); r.child.channel?.unref();
  }
  function fail(r: Running): void {
    if (r.dead) return;
    o.onUnavailable?.();
    retire(r);
  }
  function start(): Running {
    if (closed) throw unavailable();
    if (running) return running;
    const child = (o.spawn ?? spawnBackend)(description);
    const r: Running = { child, pending: new Map(), dead: false };
    running = r;
    child.on("message", (reply: BackendReply) => {
      if (r.dead || running !== r || !reply || !Number.isSafeInteger(reply.id)) return;
      const p = r.pending.get(reply.id);
      if (!p) return;
      r.pending.delete(reply.id); clearTimeout(p.timer);
      try {
        for (const value of reply.registrations ?? []) if (typeof value === "string") p.register?.(value);
        if (reply.error && SECRET_ERROR_CODES.has(reply.error.code)) {
          p.reject(new SecretError(reply.error.code, reply.error.message, reply.error.detail));
        } else if (reply.error) p.reject(new SecretError("storage", "secret backend operation failed"));
        else p.resolve(reply.value);
      } catch { p.reject(unavailable()); }
    });
    child.on("error", () => fail(r));
    child.on("exit", () => fail(r));
    child.unref(); child.channel?.unref();
    return r;
  }
  function request<T>(operation: BackendOperation, args: unknown[] = [], register?: (value: string) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let r: Running;
      try { r = start(); } catch { o.onUnavailable?.(); reject(unavailable()); return; }
      const id = ++sequence;
      const timer = setTimeout(() => fail(r), o.budgetMs ?? SECRET_IO_BUDGET_MS);
      r.pending.set(id, { resolve: value => resolve(value as T), reject, timer, ...(register ? { register } : {}) });
      try { r.child.send({ id, backend: description, operation, args }, error => { if (error) fail(r); }); }
      catch { fail(r); }
    });
  }
  return {
    backend: {
      kind: description.kind,
      probe: () => request("probe"), get: name => request("get", [name]), list: () => request("list"),
      put: (name, value, now, by, text, register) => request("put", [name, value, now.getTime(), by, text], register),
      describe: (name, text, now, by, register) => request("describe", [name, text, now.getTime(), by], register),
      delete: (name, at) => request("delete", [name, at?.getTime()]),
      ...(description.kind === "file" ? { tombstones: () => request<Record<string, string>>("tombstones"),
        clearTombstone: (name: string) => request<void>("clearTombstone", [name]) } : {}),
    },
    cancel() { if (running) retire(running); },
    async close() { closed = true; if (running) retire(running); await Promise.all(retiring); },
  };
}

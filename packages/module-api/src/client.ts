import { createConnection, type Socket } from "node:net";
import { LineDecoder, encodeLine } from "./framing.ts";
import { checkAddress, type TrustOptions } from "./trust.ts";

/** An RPC or connection failure returned by {@link connect}, including the harness error metadata. */
export class RpcCallError extends Error {
  code: number; error: string; reason?: string; detail?: string; ids?: Record<string, string>;
  constructor(code: number, error: string, message: string, reason?: string, detail?: string, ids?: Record<string, string>) {
    super(message); this.name = "RpcCallError"; this.code = code; this.error = error;
    if (reason !== undefined) this.reason = reason;
    if (detail !== undefined) this.detail = detail;
    if (ids !== undefined) this.ids = ids;
  }
}

/** `error.data.ids` as sent, when it is a non-empty map of strings; anything else is dropped. */
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v).filter(([, x]) => typeof x === "string") as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Deprecation schedule and replacement method declared by the RPC schema. */
export interface Deprecation { since: string; removeAfter: string; replacement: string }
/** Stability metadata advertised for one RPC method, notification, or extension point. */
export interface CapabilityEntry { stability: "experimental" | "stable"; since: string; deprecated?: Deprecation }
/** RPC capabilities advertised by a server during its authentication handshake. */
export interface Capabilities {
  methods: Record<string, CapabilityEntry>;
  notifications: Record<string, CapabilityEntry>;
  extensionPoints: Record<string, CapabilityEntry>;
  features: readonly string[];
}

/** The handshake result: `core.auth`'s (with `contract`), `supervisor.auth`'s (without) or `module.auth`'s (with
 *  `module`). */
export interface Hello { contract?: string; rpc: string; instanceId: string; pid: number; module?: { name: string; version: string; apiVersion: string }; capabilities?: Capabilities }
/** Authenticated JSON-RPC connection to a core, supervisor, or module endpoint. */
export interface CoreClient {
  readonly hello: Hello;
  /** Calls a schema-validated RPC method and resolves to its result. */
  call<T = unknown>(method: string, params?: object): Promise<T>;
  /** Registers a notification listener and returns a function that removes it. */
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Called once when the connection ends (the peer closed it, an error, or close()). */
  onClose(handler: () => void): () => void;
  /** Closes the RPC connection and rejects any calls still pending on it. */
  close(): Promise<void>;
  /** true when the connected core lacks `capabilities` (an older core answers for itself) or when
   *  `capabilities.methods` names this method. */
  supports(method: string): boolean;
}
/** `endpoint` picks the handshake: `core.auth` (default), `supervisor.auth` (ruling S2) or `module.auth` (B9). */
export interface ConnectOptions {
  address: string; token: string; endpoint?: "core" | "supervisor" | "module"; connectTimeoutMs?: number; callTimeoutMs?: number;
  /** The pid that must serve `address`: the one in `run/core.pid` (core) or `run/supervisor.pid` (supervisor). On Windows,
   *  where any account can create a pipe of a free name, it is required: without it the connect is refused before it
   *  starts (`E_UNAUTHORIZED`, reason `server-pid-unknown`), so a missing pid file never means "skip the check"
   *  (ruling S11, audit M1). Unused on POSIX. */
  expectedServerPid?: number;
  /** The pid the OS names as the server of a connected pipe (`GetNamedPipeServerProcessId`). Node has no API for it, so
   *  by default there is none and the client falls back to comparing `hello.pid` with `expectedServerPid` after the
   *  handshake (which cannot keep the token from a squatter that answers); a host with a native lookup passes it here,
   *  and then a mismatch is refused before `core.auth` is sent. Also the test seam. */
  serverPidOf?: (sock: Socket) => number | undefined;
  /** Default `process.platform`; the Windows paths are testable on any host through it. */
  platform?: NodeJS.Platform;
  /** Test seam for the POSIX `run/` checks (uid, lstat). */
  trust?: Omit<TrustOptions, "platform">;
}

function untrusted(reason: string, message: string, detail?: string): RpcCallError {
  return new RpcCallError(-32000, "E_UNAUTHORIZED", message, reason, detail);
}

const SUPPORTED_RPC_MAJOR = 1;

/** Connects to a trusted local harness RPC endpoint, authenticates, and returns its client. */
export async function connect(opts: ConnectOptions): Promise<CoreClient> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 300;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const platform = opts.platform ?? process.platform;
  // Audit M2: a unix socket must sit in a real `run/` of ours and be ours; otherwise nothing is connected or sent.
  const trust = checkAddress(opts.address, { ...opts.trust, platform });
  if (!trust.ok) throw untrusted(trust.reason, "the local RPC endpoint is not trusted; nothing was sent", trust.detail);
  // Audit M1 / Low: on Windows a missing pid file is a refusal, not a skipped check.
  if (platform === "win32" && opts.expectedServerPid === undefined) {
    throw untrusted("server-pid-unknown", "the pipe's expected server pid is unknown (run/*.pid is missing); nothing was sent", "the recorded pid file is missing or unreadable");
  }
  const mismatch = (actual: number | undefined, late: boolean) => untrusted(
    "pipe-server-mismatch", "the pipe is not served by the expected process",
    `${actual === undefined ? "the OS does not name the server" : `served by pid ${actual}`}, expected pid ${opts.expectedServerPid}${late ? " (found after the token was sent)" : ""}`,
  );
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(opts.address);
    const timer = setTimeout(() => { s.destroy(); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connect timeout", "connect-timeout")); }, connectTimeoutMs);
    s.once("connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", e.message, e.code ?? "connect-error")); });
  });

  if (platform === "win32" && opts.serverPidOf) {
    let actual: number | undefined;
    try { actual = opts.serverPidOf(sock); } catch { actual = undefined; }
    if (actual !== opts.expectedServerPid) { sock.destroy(); throw mismatch(actual, false); }
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const handlers = new Set<(method: string, params: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  const dec = new LineDecoder();
  let nextId = 1; let closed = false;
  let lastSocketError: { code: string | undefined; message: string } | undefined;

  const failAll = (e: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  sock.on("data", (chunk) => {
    // A line that is not JSON is skipped; the valid lines around it are still delivered.
    const { values, tooLong } = dec.decode(chunk);
    const msgs = values as any[];
    if (tooLong) { sock.destroy(); failAll(new RpcCallError(-32602, "E_INVALID_PARAMS", tooLong.message, "line-too-long")); return; }
    for (const m of msgs) {
      if (m.id === undefined && typeof m.method === "string") { for (const h of handlers) h(m.method, m.params); continue; }
      const p = pending.get(m.id); if (!p) continue;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new RpcCallError(m.error.code, m.error.data?.error ?? "E_INTERNAL", m.error.message, m.error.data?.reason, m.error.data?.detail, stringMap(m.error.data?.ids)));
      else p.resolve(m.result);
    }
  });
  sock.on("close", () => {
    closed = true;
    failAll(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connection closed", "closed", lastSocketError ? `${lastSocketError.code || "error"}: ${lastSocketError.message}` : undefined));
    const hs = [...closeHandlers]; closeHandlers.clear();
    for (const h of hs) { try { h(); } catch { /* a close handler never breaks the others */ } }
  });
  sock.on("error", (e) => { const err = e as NodeJS.ErrnoException; lastSocketError = { code: err.code, message: err.message }; });

  function call<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (closed) return Promise.reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connection closed", "closed"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", `${method} timed out`, "call-timeout")); }, callTimeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }

  let hello: Hello;
  try {
    hello = await call<Hello>(`${opts.endpoint ?? "core"}.auth`, { token: opts.token });
    const major = Number(hello.rpc.split(".")[0]);
    if (major !== SUPPORTED_RPC_MAJOR) { sock.destroy(); throw new RpcCallError(-32000, "E_RPC_VERSION", `server rpc ${hello.rpc}, client supports ${SUPPORTED_RPC_MAJOR}.x`, "major-mismatch"); }
    // Without a native pid lookup the best a Node client can do on Windows: the server must at least claim the recorded pid.
    if (platform === "win32" && !opts.serverPidOf && hello.pid !== opts.expectedServerPid) { sock.destroy(); throw mismatch(hello.pid, true); }
  } catch (e) {
    sock.destroy();
    throw e;
  }

  return {
    hello,
    call,
    onNotification(h) { handlers.add(h); return () => handlers.delete(h); },
    onClose(h) { if (closed) { h(); return () => {}; } closeHandlers.add(h); return () => { closeHandlers.delete(h); }; },
    close: () => new Promise<void>((res) => { if (closed) return res(); sock.end(() => { sock.destroy(); res(); }); }),
    supports: (method) => !hello.capabilities || Object.hasOwn(hello.capabilities.methods, method),
  };
}

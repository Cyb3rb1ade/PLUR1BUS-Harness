import { createConnection, type Socket } from "node:net";
import { LineDecoder, LineTooLong, encodeLine } from "./framing.ts";

export class RpcCallError extends Error {
  code: number; error: string; reason?: string; detail?: string;
  constructor(code: number, error: string, message: string, reason?: string, detail?: string) {
    super(message); this.name = "RpcCallError"; this.code = code; this.error = error;
    if (reason !== undefined) this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface Hello { contract: string; rpc: string; instanceId: string; pid: number }
export interface CoreClient {
  readonly hello: Hello;
  call<T = unknown>(method: string, params?: object): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}
export interface ConnectOptions { address: string; token: string; connectTimeoutMs?: number; callTimeoutMs?: number }

const SUPPORTED_RPC_MAJOR = 1;

export async function connect(opts: ConnectOptions): Promise<CoreClient> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 300;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(opts.address);
    const timer = setTimeout(() => { s.destroy(); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connect timeout", "connect-timeout")); }, connectTimeoutMs);
    s.once("connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", e.message, e.code ?? "connect-error")); });
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const handlers = new Set<(method: string, params: unknown) => void>();
  const dec = new LineDecoder();
  let nextId = 1; let closed = false;
  let lastSocketError: { code: string | undefined; message: string } | undefined;

  const failAll = (e: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  sock.on("data", (chunk) => {
    let msgs: any[];
    try { msgs = dec.push(chunk) as any[]; } catch (e) { if (e instanceof LineTooLong) { sock.destroy(); failAll(new RpcCallError(-32602, "E_INVALID_PARAMS", e.message, "line-too-long")); } return; }
    for (const m of msgs) {
      if (m.id === undefined && typeof m.method === "string") { for (const h of handlers) h(m.method, m.params); continue; }
      const p = pending.get(m.id); if (!p) continue;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new RpcCallError(m.error.code, m.error.data?.error ?? "E_INTERNAL", m.error.message, m.error.data?.reason, m.error.data?.detail));
      else p.resolve(m.result);
    }
  });
  sock.on("close", () => { closed = true; failAll(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connection closed", "closed", lastSocketError ? `${lastSocketError.code || "error"}: ${lastSocketError.message}` : undefined)); });
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
    hello = await call<Hello>("core.auth", { token: opts.token });
    const major = Number(hello.rpc.split(".")[0]);
    if (major !== SUPPORTED_RPC_MAJOR) { sock.destroy(); throw new RpcCallError(-32000, "E_RPC_VERSION", `server rpc ${hello.rpc}, client supports ${SUPPORTED_RPC_MAJOR}.x`, "major-mismatch"); }
  } catch (e) {
    sock.destroy();
    throw e;
  }

  return {
    hello,
    call,
    onNotification(h) { handlers.add(h); return () => handlers.delete(h); },
    close: () => new Promise<void>((res) => { if (closed) return res(); sock.end(() => { sock.destroy(); res(); }); }),
  };
}

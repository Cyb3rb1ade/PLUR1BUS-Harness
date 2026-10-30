/** Private role-i import credential channel, distinct from extension launch leases and ordinary RPC. */
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { createSecurePath, unitAddress } from "@plur1bus/module-api";
import { acquireLease } from "../secrets/acquisition.ts";
import { isImportSecretName, type ImportSecretBinding, type ImportSecretLease,
  type ImportSourceSecrets } from "./source-secrets.ts";

const MAX_REQUEST_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SLOTS = 64;
const MAX_CONNECTIONS = 32;
const DEADLINE_MS = 10_000;
const ACK = 0x06;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;

// Shared with the supervisor client: u32BE payload length, status:u8, count:u16BE, then
// (key length:u16BE, UTF-8 key, value length:u32BE, UTF-8 value). Only success carries entries.
const STATUS = { success: 0, denied: 1, needsSetup: 2, invalid: 3, unavailable: 4 } as const;

/** Trusted Core ports; the token stays in this private listener closure, never in MCP registry definitions. */
export interface ImportSourceSecretBrokerOptions {
  home: string;
  token: string;
  secrets: ImportSourceSecrets;
  /** Resolves only an authenticated, unexpired Owner-bound ticket; no request supplies owner or plan hash. */
  binding(planId: string, preflightId: string): Promise<ImportSecretBinding | undefined>;
}

function fixedFailure(status: number): Buffer {
  const bytes = Buffer.alloc(7);
  bytes.writeUInt32BE(3, 0);
  bytes[4] = status;
  return bytes;
}

function encodeSecrets(lease: ImportSecretLease): Buffer {
  const entries = [...lease.entries()];
  if (entries.length > MAX_SLOTS) throw Error("invalid source transfer");
  let length = 3;
  for (const [key, value] of entries) {
    if (!isImportSecretName(key) || value.length > MAX_VALUE_BYTES) throw Error("invalid source transfer");
    length += 2 + Buffer.byteLength(key) + 4 + value.length;
    if (length > MAX_PAYLOAD_BYTES) throw Error("source transfer exceeds its limit");
  }
  const bytes = Buffer.alloc(length + 4);
  bytes.writeUInt32BE(length, 0);
  bytes[4] = STATUS.success;
  bytes.writeUInt16BE(entries.length, 5);
  let offset = 7;
  for (const [key, value] of entries) {
    const keyLength = Buffer.byteLength(key);
    bytes.writeUInt16BE(keyLength, offset);
    offset += 2;
    offset += bytes.write(key, offset, keyLength, "utf8");
    bytes.writeUInt32BE(value.length, offset);
    offset += 4;
    offset += value.copy(bytes, offset);
  }
  return bytes;
}

function entry(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameEntry(left: Stats, right: Stats | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

async function removeStaleSocket(address: string): Promise<void> {
  const existing = entry(address);
  if (!existing) return;
  if (!existing.isSocket() || existing.isSymbolicLink()) throw Error("invalid private socket");
  const stale = await new Promise<boolean>(resolve => {
    const socket = createConnection(address);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(false), 250);
    socket.once("connect", () => finish(false));
    socket.once("error", error => finish(["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")));
  });
  if (!stale || !sameEntry(existing, entry(address))) throw Error("private socket is busy");
  unlinkSync(address);
}

function prepareRunDirectory(home: string): void {
  if (!isAbsolute(home)) throw Error("invalid private run directory");
  const assertDirectory = (path: string) => {
    const value = entry(path);
    if (!value || !value.isDirectory() || value.isSymbolicLink() ||
        (process.platform !== "win32" && typeof process.getuid === "function" && value.uid !== process.getuid())) {
      throw Error("invalid private run directory");
    }
  };
  assertDirectory(home);
  const run = join(home, "run");
  try { mkdirSync(run, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertDirectory(run);
  if (!createSecurePath({ runDir: run })(run, { mode: 0o700 }).applied) throw Error("private permissions unavailable");
}

/** Native fetch happens before Core stop. ACK transfers responsibility to the native private buffer and revokes Core. */
export async function startImportSourceSecretBroker(options: ImportSourceSecretBrokerOptions): Promise<{
  address: string;
  close(): Promise<void>;
}> {
  if (typeof options.token !== "string" || !options.token.length || Buffer.byteLength(options.token) > MAX_REQUEST_BYTES) {
    throw Error("import source-secret broker unavailable");
  }
  const address = unitAddress(options.home, "i");
  const tokenDigest = createHash("sha256").update(options.token).digest();
  const connections = new Map<Socket, () => void>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  let ownedSocket: Stats | undefined;

  const server = createServer(socket => {
    if (closing || connections.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    const abort = new AbortController();
    let phase: "request" | "leasing" | "ack" | "closed" = "request";
    let input = Buffer.alloc(0);
    let output: Buffer | undefined;
    let lease: ImportSecretLease | undefined;
    const cleanup = () => {
      if (phase === "closed") return;
      phase = "closed";
      clearTimeout(timer);
      abort.abort();
      input.fill(0); input = Buffer.alloc(0);
      output?.fill(0); output = undefined;
      lease?.release(); lease = undefined;
    };
    const fail = (status: number) => {
      if (phase === "closed") return;
      cleanup();
      socket.end(fixedFailure(status), () => socket.destroy());
    };
    const timer = setTimeout(() => { cleanup(); socket.destroy(); }, DEADLINE_MS);
    connections.set(socket, cleanup);
    socket.on("error", () => { cleanup(); socket.destroy(); });
    socket.on("close", () => { cleanup(); connections.delete(socket); });
    socket.on("end", cleanup);

    async function transfer(planId: string, preflightId: string): Promise<void> {
      try {
        const binding = await acquireLease(() => options.binding(planId, preflightId), () => {}, abort.signal);
        if (!binding || binding.planId !== planId || binding.preflightId !== preflightId) {
          fail(STATUS.unavailable);
          return;
        }
        if (abort.signal.aborted) return;
        lease = options.secrets.take(binding);
        try { output = encodeSecrets(lease); } catch { fail(STATUS.unavailable); return; }
        phase = "ack";
        const frame = output;
        socket.write(frame, error => {
          frame.fill(0);
          if (output === frame) output = undefined;
          if (error) { cleanup(); socket.destroy(); }
        });
      } catch {
        fail(STATUS.needsSetup);
      }
    }

    socket.on("data", (chunk: Buffer) => {
      if (phase === "closed") return;
      if (phase === "ack") {
        if (chunk.length === 1 && chunk[0] === ACK) { cleanup(); socket.end(() => socket.destroy()); }
        else { cleanup(); socket.destroy(); }
        return;
      }
      if (phase !== "request" || input.length + chunk.length > MAX_REQUEST_BYTES) { fail(STATUS.invalid); return; }
      const previous = input;
      input = Buffer.concat([previous, chunk]); previous.fill(0);
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== input.length - 1) { fail(STATUS.invalid); return; }
      let request: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid request");
        request = value as Record<string, unknown>;
        if (Object.keys(request).length !== 4 || request.v !== 1 || typeof request.token !== "string" ||
            typeof request.planId !== "string" || !UUID.test(request.planId) ||
            typeof request.preflightId !== "string" || !UUID.test(request.preflightId)) throw Error("invalid request");
      } catch { fail(STATUS.invalid); return; }
      finally { input.fill(0); input = Buffer.alloc(0); }
      const candidate = createHash("sha256").update(request.token as string).digest();
      const accepted = timingSafeEqual(candidate, tokenDigest);
      candidate.fill(0); request.token = undefined;
      if (!accepted) { fail(STATUS.denied); return; }
      phase = "leasing";
      const task = transfer(request.planId as string, request.preflightId as string);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
  });

  try {
    prepareRunDirectory(options.home);
    if (process.platform !== "win32") await removeStaleSocket(address);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => { server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") {
      ownedSocket = entry(address);
      if (!ownedSocket?.isSocket() || !createSecurePath()(address).applied) throw Error("private permissions unavailable");
    }
  } catch {
    server.close();
    tokenDigest.fill(0);
    throw Error("import source-secret broker unavailable");
  }

  return {
    address,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
        for (const [socket, cleanup] of connections) { cleanup(); socket.destroy(); }
        await stopped;
        // A disconnected native peer owns no transfer. The abort/late-value cleanup remains attached, but
        // an unavailable keyring must never keep Core shutdown waiting for the backend to return.
        pending.clear();
        options.secrets.close();
        tokenDigest.fill(0);
        if (process.platform !== "win32" && ownedSocket && sameEntry(ownedSocket, entry(address))) unlinkSync(address);
      })();
      return closing;
    },
  };
}

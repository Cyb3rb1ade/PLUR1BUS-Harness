/** M-A7 private native-child credential channel. Values never enter JSON-RPC, events or cached child specs. */
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { createSecurePath, unitAddress } from "@plur1bus/module-api";
import type { LeasedLaunchEnvironment } from "../mcp/env.ts";
import { createExtensionSecrets, type ExtensionSecretsOptions } from "./secret-env.ts";

const MAX_REQUEST_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SLOTS = 256;
const MAX_CONNECTIONS = 32;
const DEADLINE_MS = 10_000;
const ACK = 0x06;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLOT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// Shared with the supervisor client: u32BE payload length, status:u8, count:u16BE, then
// (key length:u16BE, UTF-8 key, value length:u32BE, UTF-8 value). Only success carries entries.
const STATUS = { success: 0, denied: 1, needsSetup: 2, invalid: 3, unavailable: 4 } as const;

/** Trusted Core ports; the token stays in this private listener closure, never in MCP registry definitions. */
export interface ExtensionSpawnSecretsOptions extends ExtensionSecretsOptions {
  token: string;
}

function fixedFailure(status: number): Buffer {
  const bytes = Buffer.alloc(7);
  bytes.writeUInt32BE(3, 0);
  bytes[4] = status;
  return bytes;
}

function encodeEnvironment(env: Record<string, string>): Buffer {
  const entries = Object.entries(env);
  if (entries.length > MAX_SLOTS) throw Error("invalid spawn environment");
  const seen = new Set<string>();
  let length = 3;
  for (const [slot, value] of entries) {
    const key = `P1X_SECRET_${slot}`;
    const identity = process.platform === "win32" ? key.toUpperCase() : key;
    if (!SLOT.test(slot) || seen.has(identity) || typeof value !== "string" || value.includes("\0") ||
        Buffer.byteLength(value) > MAX_VALUE_BYTES) throw Error("invalid spawn environment");
    seen.add(identity);
    length += 2 + Buffer.byteLength(key) + 4 + Buffer.byteLength(value);
    if (length > MAX_PAYLOAD_BYTES) throw Error("spawn environment exceeds its limit");
  }
  const bytes = Buffer.alloc(length + 4);
  bytes.writeUInt32BE(length, 0);
  bytes[4] = STATUS.success;
  bytes.writeUInt16BE(entries.length, 5);
  let offset = 7;
  for (const [slot, value] of entries) {
    const key = `P1X_SECRET_${slot}`;
    const keyLength = Buffer.byteLength(key);
    const valueLength = Buffer.byteLength(value);
    bytes.writeUInt16BE(keyLength, offset); offset += 2;
    offset += bytes.write(key, offset, keyLength, "utf8");
    bytes.writeUInt32BE(valueLength, offset); offset += 4;
    offset += bytes.write(value, offset, valueLength, "utf8");
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

/** Starts the authenticated role-e pipe. Each lease ends on ACK, disconnect, failure, deadline or Core shutdown. */
export async function startExtensionSpawnSecrets(options: ExtensionSpawnSecretsOptions): Promise<{
  address: string;
  close(): Promise<void>;
}> {
  if (typeof options.token !== "string" || !options.token.length || Buffer.byteLength(options.token) > MAX_REQUEST_BYTES) {
    throw Error("extension spawn-secret broker unavailable");
  }
  const address = unitAddress(options.home, "e");
  const tokenDigest = createHash("sha256").update(options.token).digest();
  const service = createExtensionSecrets(options);
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
    let lease: LeasedLaunchEnvironment | undefined;
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

    async function transfer(name: string): Promise<void> {
      try {
        const acquired = await service.leaseSlots(name, abort.signal);
        if (abort.signal.aborted) { acquired.release(); return; }
        lease = acquired;
        try { output = encodeEnvironment(acquired.env); } catch { fail(STATUS.unavailable); return; }
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
        if (Object.keys(request).length !== 3 || request.v !== 1 || typeof request.token !== "string" ||
            typeof request.name !== "string" || !NAME.test(request.name)) throw Error("invalid request");
      } catch { fail(STATUS.invalid); return; }
      finally { input.fill(0); input = Buffer.alloc(0); }
      const candidate = createHash("sha256").update(request.token as string).digest();
      const accepted = timingSafeEqual(candidate, tokenDigest);
      candidate.fill(0); request.token = undefined;
      if (!accepted) { fail(STATUS.denied); return; }
      phase = "leasing";
      const task = transfer(request.name as string);
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
    throw Error("extension spawn-secret broker unavailable");
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
        tokenDigest.fill(0);
        if (process.platform !== "win32" && ownedSocket && sameEntry(ownedSocket, entry(address))) unlinkSync(address);
      })();
      return closing;
    },
  };
}

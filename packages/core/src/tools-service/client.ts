/** D120 native tools connection. Core owns standalone children; the supervisor owns supervised children.
 * Provider credentials and ambient secrets never enter the child environment or the tools wire. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  connect,
  readRecordedPid,
  readRunToken,
  RpcCallError,
  unitAddress,
  type CoreClient,
  type HarnessLogger,
} from "@plur1bus/module-api";
import {
  validateResult,
  type ToolsHealthResult,
  type ToolsServiceStatus,
} from "@plur1bus/rpc-schema";
import { helperPinned } from "../attestation/helper.ts";
import { RpcError } from "../rpc/errors.ts";
import { toolsPipeServerPid } from "./pipe-peer.ts";
import { toolsEnvironment } from "./environment.ts";
import { openToolsLog } from "./stderr-log.ts";

/** Local lifecycle options; no registered secret values are accepted. */
export interface ToolsClientOptions {
  home: string;
  supervised: boolean;
  orphanGraceMs?: number;
  binary?: string;
  /** Native CLI for the credential-free Windows pipe peer lookup. The CLI normally sets PLUR1BUS_NATIVE_BIN. */
  nativeBinary?: string;
  pollIntervalMs?: number;
}

const unavailable = () =>
  new RpcError("E_NOT_AVAILABLE", "native tools are unavailable", {
    reason: "tools-unavailable",
  });

interface ToolsChannel {
  connection: CoreClient | undefined;
  connecting: Promise<CoreClient> | undefined;
}

export { toolsEnvironment } from "./environment.ts";

function binaryPath(options: ToolsClientOptions): string {
  if (options.binary !== undefined) return options.binary;
  if (process.env.PLUR1BUS_TOOLS_BIN) return process.env.PLUR1BUS_TOOLS_BIN;
  const name = `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`;
  return process.env.PLUR1BUS_NATIVE_BIN
    ? join(dirname(process.env.PLUR1BUS_NATIVE_BIN), name)
    : join(options.home, "runtime", "bin", name);
}

function nativeCliPath(options: ToolsClientOptions): string {
  // Direct Core embeddings may supply only the tools path; the shipped release pair keeps its CLI beside it.
  return options.nativeBinary ?? process.env.PLUR1BUS_NATIVE_BIN ?? join(dirname(binaryPath(options)), "plur1bus.exe");
}

function recordedServerPid(home: string): { expectedServerPid?: number } {
  const pid = readRecordedPid(join(home, "run", "tools.pid"));
  return pid === undefined ? {} : { expectedServerPid: pid };
}

/** Reconnecting authenticated client, with one per-Core-start ticket key and synchronous diagnostic snapshots. */
export class ToolsClient {
  private readonly options: ToolsClientOptions;
  private readonly key = randomBytes(32);
  private readonly abort = new AbortController();
  private readonly work: ToolsChannel = {
    connection: undefined,
    connecting: undefined,
  };
  private readonly probe: ToolsChannel = {
    connection: undefined,
    connecting: undefined,
  };
  private child: ChildProcess | undefined;
  private stderrLog: HarnessLogger | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cached: ToolsServiceStatus = {
    ready: false,
    pid: null,
    checkedAt: null,
  };
  private nextSpawnAt = 0;
  private spawnBackoffMs = 250;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: ToolsClientOptions) {
    this.options = options;
  }

  /** Begin non-blocking health refreshes; absence never holds up Core readiness. */
  start(): void {
    if (this.timer !== undefined || this.closed) return;
    const tick = async () => {
      try {
        await this.health();
      } catch {
        /* health records the explicit unavailable snapshot; Core remains usable. */
      }
      if (!this.closed) {
        this.timer = setTimeout(() => {
          void tick();
        }, this.options.pollIntervalMs ?? 1000);
        this.timer.unref();
      }
    };
    void tick();
  }

  /** Cached readiness only: core.status keeps its no-I/O latency contract. */
  snapshot(): ToolsServiceStatus {
    return { ...this.cached };
  }

  /** Probe tools.health with the Core principal; unavailable/restarting tools are a typed refusal. */
  async health(): Promise<ToolsHealthResult> {
    try {
      const result = await this.request<ToolsHealthResult>(
        this.probe,
        "tools.health",
        {},
        1000,
      );
      this.cached = {
        ready: result.process.state === "ready",
        pid: result.pid,
        checkedAt: Date.now(),
      };
      if (this.cached.ready) this.spawnBackoffMs = 250;
      return result;
    } catch {
      this.cached = { ready: false, pid: null, checkedAt: Date.now() };
      throw unavailable();
    }
  }

  /** Call an internal tools method. All results are validated against the shared schema before exposure. */
  async call<T = unknown>(
    method: string,
    params: object,
    timeoutMs = 1000,
  ): Promise<T> {
    return this.request<T>(this.work, method, params, timeoutMs);
  }

  private async request<T>(
    channel: ToolsChannel,
    method: string,
    params: object,
    timeoutMs: number,
  ): Promise<T> {
    if (this.closed || !method.startsWith("tools.") || method === "tools.hello")
      throw unavailable();
    let connection: CoreClient | undefined;
    try {
      connection = await this.connected(channel);
      const result = await connection.call<T>(method, params, timeoutMs);
      if (!validateResult(method, result).ok) throw unavailable();
      return result;
    } catch (error) {
      if (error instanceof RpcCallError) {
        // The pending request has expired; the framing client still owns the other requests and drops late replies.
        if (error.reason === "call-timeout") throw unavailable();
        if (error.error !== "E_CORE_UNAVAILABLE") throw error;
      }
      if (connection && channel.connection === connection) {
        channel.connection = undefined;
        await connection.close();
      }
      throw unavailable();
    }
  }

  private async connected(channel: ToolsChannel): Promise<CoreClient> {
    if (channel.connection) return channel.connection;
    if (this.closed) throw unavailable();
    if (!channel.connecting) {
      channel.connecting = this.open(channel).finally(() => {
        channel.connecting = undefined;
      });
    }
    return channel.connecting;
  }

  private async open(channel: ToolsChannel): Promise<CoreClient> {
    if (!this.options.supervised) await this.spawnStandalone();
    const deadline = Date.now() + (this.child ? 2500 : 300);
    do {
      try {
        const run = join(this.options.home, "run");
        const connection = await connect({
          address: unitAddress(this.options.home, "tools"),
          endpoint: "tools",
          token: readRunToken(this.options.home, join(run, "tools-core.token")),
          ticketKey: this.key.toString("hex"),
          signal: this.abort.signal,
          ...recordedServerPid(this.options.home),
          ...(process.platform === "win32"
            ? { serverPidOf: (socket) => toolsPipeServerPid(socket, nativeCliPath(this.options)) }
            : {}),
          connectTimeoutMs: 300,
          callTimeoutMs: 1000,
          handshakeTimeoutMs: 1000,
        });
        if (
          !validateResult("tools.hello", connection.hello).ok ||
          this.closed
        ) {
          await connection.close();
          throw unavailable();
        }
        channel.connection = connection;
        connection.onClose(() => {
          if (channel.connection === connection) {
            channel.connection = undefined;
            if (channel === this.probe)
              this.cached = { ready: false, pid: null, checkedAt: Date.now() };
          }
        });
        return connection;
      } catch {
        if (!this.child || this.closed || Date.now() >= deadline)
          throw unavailable();
        await delay(25, undefined, { signal: this.abort.signal });
      }
    } while (!this.closed);
    throw unavailable();
  }

  private async spawnStandalone(): Promise<void> {
    if (this.child || Date.now() < this.nextSpawnAt) return;
    const binary = binaryPath(this.options);
    if (!isAbsolute(binary) || !helperPinned(binary)) throw unavailable();
    this.stderrLog ??= openToolsLog(this.options.home);
    const child = spawn(
      binary,
      [
        "serve",
        "--home",
        this.options.home,
        "--lifeline",
        "stdin",
        "--grace-ms",
        String(this.options.orphanGraceMs ?? 10_000),
      ],
      {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        env: toolsEnvironment(process.env),
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bound every record; JSON quoting prevents child output from forging a log record.
      this.stderrLog?.error(chunk.subarray(0, 8192).toString("utf8"), { source: "tools-stderr" });
    });
    child.stdin?.on("error", () => {
      /* A crashed child can close its lifeline before shutdown finishes. */
    });
    this.child = child;
    const exited = () => {
      if (this.child === child) {
        this.child = undefined;
        this.nextSpawnAt = Date.now() + this.spawnBackoffMs;
        this.spawnBackoffMs = Math.min(this.spawnBackoffMs * 2, 30_000);
        this.cached = { ready: false, pid: null, checkedAt: Date.now() };
      }
    };
    child.once("exit", exited);
    child.once("error", exited);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(unavailable()));
    });
  }

  /** Close transport, erase the key, and stop/reap a standalone child unless a supervisor adopted it. */
  close(): Promise<void> {
    this.closing ??= this.stop().finally(async () => { await this.stderrLog?.close(); });
    return this.closing;
  }

  private async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    for (const channel of [this.work, this.probe]) {
      await channel.connecting?.catch(() => {
        /* An interrupted connection is expected on shutdown. */
      });
      await channel.connection?.close();
      channel.connection = undefined;
    }
    this.key.fill(0);
    const child = this.child;
    if (!child) return;
    const adopted = await this.stopOwnedChild().catch(() => false);
    child.stdin?.end();
    if (adopted) {
      child.unref();
      this.child = undefined;
      return;
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = undefined;
  }

  private async stopOwnedChild(): Promise<boolean> {
    const run = join(this.options.home, "run");
    const control = await connect({
      address: unitAddress(this.options.home, "tools"),
      endpoint: "module",
      token: readRunToken(this.options.home, join(run, "tools.token")),
      ...recordedServerPid(this.options.home),
      ...(process.platform === "win32"
        ? { serverPidOf: (socket) => toolsPipeServerPid(socket, nativeCliPath(this.options)) }
        : {}),
      connectTimeoutMs: 300,
      callTimeoutMs: 300,
    });
    try {
      const status = await control.call<{ detail?: { adopted?: boolean } }>(
        "module.status",
        {},
      );
      if (status.detail?.adopted === true) return true;
      await control.call("module.shutdown", {});
      return false;
    } finally {
      await control.close();
    }
  }
}

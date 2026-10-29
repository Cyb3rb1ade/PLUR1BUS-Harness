// The SDK owns MCP; this transport owns bounded framing and the lifetime of spawned code.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransportConfig } from "./types.ts";
import { isolatedStdioEnv, stdioSpawnEnv, windowsKeptEnv, type LeasedLaunchEnvironment } from "./env.ts";
import { windowsJobCommand, windowsLauncherEnv } from "./windows-job.ts";
import { acquireLease } from "../secrets/acquisition.ts";

type Pipes = { input: Writable; output: Readable; stderr?: Readable };
type StdioConfig = Extract<McpTransportConfig, { type: "stdio" }>;
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Trusted spawn-time lease acquisition; neither the configuration nor the transport stores credential values. */
export interface StdioLaunchOptions {
  signal?: AbortSignal;
  launchEnvironment?: () => Promise<LeasedLaunchEnvironment | undefined>;
  redact?: (value: string) => void;
}

export class BoundedStdioTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new PassThrough();
  private child: ChildProcessWithoutNullStreams | null = null;
  private pipes: Pipes | null = null;
  // Parts of the current line; joined once per frame so many tiny reads cost linear, not quadratic, copying.
  private parts: Buffer[] = [];
  private size = 0;
  private closing: Promise<void> | null = null;
  private closed = false;
  private started = false;
  private pidValue: number | null = null;
  private readonly source: Pipes | StdioConfig;
  private readonly limit: number;
  private readonly grace: number;
  private readonly host: NodeJS.ProcessEnv;
  private readonly launch: StdioLaunchOptions;
  private readonly launchAbort = new AbortController();
  constructor(source: Pipes | StdioConfig, limit = MAX_FRAME_BYTES, grace = 2000,
    host: NodeJS.ProcessEnv = process.env, launch: StdioLaunchOptions = {}) {
    this.source = source; this.limit = limit; this.grace = grace; this.host = host; this.launch = launch;
  }
  get pid(): number | null { return this.pidValue; }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("stdio transport already started or closed");
    this.started = true;
    if ("input" in this.source) this.pipes = this.source;
    else {
      const t = this.source;
      await this.spawn(t);
      const child = this.child;
      if (!child) throw new Error("MCP child launch failed");
      this.pidValue = child.pid ?? null;
      this.pipes = { input: child.stdin, output: child.stdout, stderr: child.stderr };
      child.on("close", () => { this.finish(); if (!this.closing) void this.killTree("SIGKILL"); });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => { const e = new Error("MCP child spawn failed"); this.onerror?.(e); reject(e); });
      });
    }
    this.pipes.stderr?.pipe(this.stderr);
    this.pipes.input.on("error", () => this.fail("MCP stdin failed"));
    this.pipes.output.on("error", () => this.fail("MCP stdout failed"));
    this.pipes.output.on("end", () => {
      if (this.size) this.fail("MCP incomplete frame at EOF");
      else if (!this.closing) void this.close();
    });
    this.pipes.output.on("data", (chunk: Buffer | string) => this.read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  private async spawn(t: StdioConfig): Promise<void> {
    let leased: LeasedLaunchEnvironment | undefined;
    let env: Record<string, string> | undefined;
    let spawnEnv: Record<string, string> | undefined;
    try {
      if (this.launch.signal?.aborted || this.closed || this.closing) throw new Error("MCP launch aborted");
      const signal = this.launch.signal
        ? AbortSignal.any([this.launch.signal, this.launchAbort.signal]) : this.launchAbort.signal;
      leased = await acquireLease(() => this.launch.launchEnvironment?.() ?? Promise.resolve(undefined),
        late => late?.release(), signal);
      if (this.launch.signal?.aborted || this.closed || this.closing) throw new Error("MCP launch aborted");
      env = leased ? isolatedStdioEnv(leased.env) : stdioSpawnEnv(t, this.host);
      if (leased) for (const value of Object.values(env)) this.launch.redact?.(value);
      const command = process.platform === "win32"
        ? windowsJobCommand(t.command, t.args, this.host, windowsKeptEnv(env, leased !== undefined))
        : { command: t.command, args: t.args };
      spawnEnv = process.platform === "win32" ? windowsLauncherEnv(env) : env;
      leased?.validate?.();
      this.child = spawn(command.command, command.args, { env: spawnEnv, cwd: t.cwd, shell: false,
        windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
    } catch {
      // Backend/platform exceptions may contain credential values; only a fixed error crosses the transport boundary.
      throw new Error("MCP child launch failed");
    } finally {
      try { leased?.release(); } catch { throw new Error("MCP launch lease release failed"); }
      if (leased) {
        if (env) for (const key of Object.keys(env)) delete env[key];
        if (spawnEnv) for (const key of Object.keys(spawnEnv)) delete spawnEnv[key];
      }
    }
  }
  private read(chunk: Buffer): void {
    if (this.closed || this.closing) return;
    // Process each line before retaining a tail: many small frames in a single read are legal.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.size + part.length > this.limit) { this.fail("MCP frame exceeds byte limit"); return; }
      if (part.length) { this.parts.push(part); this.size += part.length; }
      if (newline < 0) return;
      try {
        const line = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
        const message = JSONRPCMessageSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        this.parts = []; this.size = 0; this.onmessage?.(message);
      } catch { this.fail("MCP malformed JSON-RPC frame"); return; }
      offset = newline + 1;
    }
  }
  private fail(message: string): void { this.onerror?.(new Error(message)); void this.close(); }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.pipes || this.closed || this.closing) throw new Error("MCP stdio is closed");
    const wire = JSON.stringify(message);
    if (Buffer.byteLength(wire) > this.limit) throw new Error("MCP frame exceeds byte limit");
    await new Promise<void>((resolve, reject) => this.pipes!.input.write(wire + "\n", e => e ? reject(new Error("MCP stdin write failed")) : resolve()));
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    this.launchAbort.abort();
    this.pipes?.input.end();
    const child = this.child;
    if (child) {
      const exited = new Promise<void>(r => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once("exit", () => r()); });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>(r => { timer = setTimeout(r, this.grace); })]);
      clearTimeout(timer);
      await this.killTree("SIGTERM");
      await Promise.race([exited, new Promise<void>(r => { timer = setTimeout(r, this.grace); })]);
      clearTimeout(timer);
      await this.killTree("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
    this.parts = []; this.size = 0; this.finish();
  }
  private async killTree(signal: NodeJS.Signals): Promise<void> {
    const pid = this.pidValue;
    if (pid === null) return;
    if (process.platform === "win32") {
      // taskkill traverses descendants; child.kill() only kills the direct child on Windows.
      if (this.child?.exitCode !== null || this.child?.signalCode !== null) return;
      await new Promise<void>(r => {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const timeout = setTimeout(() => { killer.kill(); r(); }, this.grace + 1000);
        killer.once("error", () => { clearTimeout(timeout); r(); });
        killer.once("exit", () => { clearTimeout(timeout); r(); });
      });
    } else {
      try { process.kill(-pid, signal); } catch { /* process group has already gone */ }
    }
  }
  private finish(): void { if (this.closed) return; this.closed = true; this.onclose?.(); }
}

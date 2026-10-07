// The SDK owns MCP; this transport owns bounded framing and the lifetime of spawned code.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransportConfig } from "./types.ts";
import { buildChildEnv } from "./env.ts";
import { windowsJobCommand } from "./windows-job.ts";

type Pipes = { input: Writable; output: Readable; stderr?: Readable };
type StdioConfig = Extract<McpTransportConfig, { type: "stdio" }>;
export const MAX_FRAME_BYTES = 1024 * 1024;

export class BoundedStdioTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new PassThrough();
  private child: ChildProcessWithoutNullStreams | null = null;
  private pipes: Pipes | null = null;
  private buffer = Buffer.alloc(0);
  private closing: Promise<void> | null = null;
  private closed = false;
  private started = false;
  private pidValue: number | null = null;
  private readonly source: Pipes | StdioConfig;
  private readonly limit: number;
  private readonly grace: number;
  private readonly host: NodeJS.ProcessEnv;
  constructor(source: Pipes | StdioConfig, limit = MAX_FRAME_BYTES, grace = 2000, host: NodeJS.ProcessEnv = process.env) {
    this.source = source; this.limit = limit; this.grace = grace; this.host = host;
  }
  get pid(): number | null { return this.pidValue; }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("stdio transport already started or closed");
    this.started = true;
    if ("input" in this.source) this.pipes = this.source;
    else {
      const t = this.source;
      const env: Record<string, string> = {};
      for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = this.host[key] ?? process.env[key];
        if (value !== undefined && !value.startsWith("()")) env[key] = value;
      }
      Object.assign(env, buildChildEnv(t, this.host).env);
      const launch = process.platform === "win32" ? windowsJobCommand(t.command, t.args, this.host) : { command: t.command, args: t.args };
      this.child = spawn(launch.command, launch.args, { env, cwd: t.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
      this.pidValue = this.child.pid ?? null;
      this.pipes = { input: this.child.stdin, output: this.child.stdout, stderr: this.child.stderr };
      this.child.on("close", () => { this.finish(); if (!this.closing) void this.killTree("SIGKILL"); });
      await new Promise<void>((resolve, reject) => {
        this.child!.once("spawn", resolve);
        this.child!.once("error", () => { const e = new Error("MCP child spawn failed"); this.onerror?.(e); reject(e); });
      });
    }
    this.pipes.stderr?.pipe(this.stderr);
    this.pipes.input.on("error", () => this.fail("MCP stdin failed"));
    this.pipes.output.on("error", () => this.fail("MCP stdout failed"));
    this.pipes.output.on("end", () => {
      if (this.buffer.length) this.fail("MCP incomplete frame at EOF");
      else if (!this.closing) void this.close();
    });
    this.pipes.output.on("data", (chunk: Buffer | string) => this.read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }
  private read(chunk: Buffer): void {
    if (this.closed || this.closing) return;
    // Process each line before retaining a tail: many small frames in a single read are legal.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.buffer.length + part.length > this.limit) { this.fail("MCP frame exceeds byte limit"); return; }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (newline < 0) return;
      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffer)));
        this.buffer = Buffer.alloc(0); this.onmessage?.(message);
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
    this.buffer = Buffer.alloc(0); this.finish();
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

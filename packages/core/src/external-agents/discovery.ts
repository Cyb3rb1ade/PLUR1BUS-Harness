// Finds installed external CLIs. Login state is existence and mode only. File contents are never inspected.
import { constants as fsc, accessSync, lstatSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AcpClient, AcpClientError } from "./acp-client.ts";
import type { ConnectorId } from "./engine.ts";
import type { WatchdogDetail } from "./watchdog-detail.ts";
import { launchExternalAgent, LaunchError, type LaunchHandle } from "./launcher.ts";

export interface ConnectorDescriptor {
  id: ConnectorId;
  /** Gated connectors are required for the nightly matrix. agy is best-effort. */
  effort: "gated" | "best-effort";
  bins: readonly string[];
  /** Paths relative to the user home. */
  loginPaths: readonly string[];
}

export const DESCRIPTORS: readonly ConnectorDescriptor[] = [
  { id: "claude-code", effort: "gated", bins: ["claude-agent-acp", "claude"], loginPaths: [".claude/.credentials.json"] },
  { id: "codex", effort: "gated", bins: ["codex-acp", "codex"], loginPaths: [".codex/auth.json"] },
  { id: "goose", effort: "gated", bins: ["goose"], loginPaths: [".config/goose"] },
  { id: "agy", effort: "best-effort", bins: ["agy", "gemini"], loginPaths: [".agy", ".gemini"] },
];

export interface LoginProbe { path: string; exists: boolean; mode?: number }
export interface ConnectorProbe {
  id: ConnectorId;
  effort: ConnectorDescriptor["effort"];
  bin: string | null;
  version: string | null;
  protocol: "ok" | "refused" | "unprobed";
  reason?: string;
  /** Validated native-helper cause, independently retained for each probe without changing its decision. */
  diagnostics?: { version?: WatchdogDetail; initialize?: WatchdogDetail };
  login: LoginProbe[];
}

export async function discoverConnectors(o: {
  home: string;
  pathEnv?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  limitsHelper?: string;
}): Promise<ConnectorProbe[]> {
  const pathEnv = o.pathEnv ?? o.env?.PATH ?? "";
  const platform = o.platform ?? process.platform;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const out: ConnectorProbe[] = [];
  for (const descriptor of DESCRIPTORS) {
    const bin = findBin(descriptor.bins, pathEnv);
    const login = descriptor.loginPaths.map((rel) => loginStatus(o.home, rel));
    if (!bin) {
      out.push({ id: descriptor.id, effort: descriptor.effort, bin: null, version: null, protocol: "unprobed", login });
      continue;
    }
    if (platform === "win32") {
      out.push({ id: descriptor.id, effort: descriptor.effort, bin, version: null, protocol: "unprobed", reason: "sandbox-unavailable", login });
      continue;
    }
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "p1b-acp-probe-")));
    let version: { version: string | null; detail?: WatchdogDetail };
    let handshake: { protocol: "ok" | "refused"; reason?: string; detail?: WatchdogDetail };
    try {
      const options = { home: o.home, probe: true, ...(o.limitsHelper ? { limitsHelper: o.limitsHelper } : {}) };
      version = await captureVersion(bin, scratch, o.env, timeoutMs, platform, options);
      handshake = await probeInitialize(bin, scratch, o.env, timeoutMs, platform, options);
    } finally { await rm(scratch, { recursive: true, force: true }); }
    out.push({ id: descriptor.id, effort: descriptor.effort, bin, version: version.version, protocol: handshake.protocol, ...(handshake.reason ? { reason: handshake.reason } : {}),
      ...(version.detail || handshake.detail ? { diagnostics: { ...(version.detail ? { version: version.detail } : {}), ...(handshake.detail ? { initialize: handshake.detail } : {}) } } : {}), login });
  }
  return out;
}

export function findBin(names: readonly string[], pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        const st = lstatSync(candidate);
        if (!st.isFile()) continue;
        accessSync(candidate, fsc.X_OK);
        return candidate;
      } catch { /* not this directory */ }
    }
  }
  return null;
}

function loginStatus(home: string, rel: string): LoginProbe {
  const path = join(home, rel);
  try {
    const st = lstatSync(path);
    try { accessSync(path, fsc.F_OK); } catch { /* the link exists; the target may not */ }
    return { path, exists: true, mode: st.mode };
  } catch {
    return { path, exists: false };
  }
}

async function captureVersion(bin: string, cwd: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number, platform: NodeJS.Platform, options: { home: string; probe: boolean; limitsHelper?: string }): Promise<{ version: string | null; detail?: WatchdogDetail }> {
  try {
    const handle = await launchExternalAgent({ ...options, argv: [bin, "--version"], cwd, ...(env ? { env } : {}), timeoutMs, platform });
    let out = "";
    handle.stderr.resume();
    handle.stdout.on("data", (chunk: Buffer) => { if (out.length < 200) out += chunk.toString("utf8").slice(0, 200 - out.length); });
    await handle.exited;
    const text = out.trim();
    return { version: text.length > 0 ? text : null, ...(handle.exitStatus.detail ? { detail: handle.exitStatus.detail } : {}) };
  } catch {
    return { version: null };
  }
}

async function probeInitialize(bin: string, cwd: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number, platform: NodeJS.Platform, options: { home: string; probe: boolean; limitsHelper?: string }): Promise<{ protocol: "ok" | "refused"; reason?: string; detail?: WatchdogDetail }> {
  let stop = () => {};
  let exited: Promise<number | null> | undefined;
  let handle: LaunchHandle | undefined;
  let result: { protocol: "ok" | "refused"; reason?: string; detail?: WatchdogDetail };
  try {
    handle = await launchExternalAgent({ ...options, argv: [bin], cwd, ...(env ? { env } : {}), timeoutMs, platform });
    stop = handle.stop;
    exited = handle.exited;
    handle.stderr.resume();
    const client = new AcpClient({
      input: handle.stdout,
      output: handle.stdin,
      handlers: {
        async readText() { throw new AcpClientError("not-in-probe"); },
        async writeText() { throw new AcpClientError("not-in-probe"); },
        async permission() { throw new AcpClientError("not-in-probe"); },
        async terminal() { throw new AcpClientError("not-in-probe"); },
        onUpdate() {},
      },
    });
    await client.initialize();
    result = { protocol: "ok" };
  } catch (e) {
    const reason = e instanceof AcpClientError ? e.reason : e instanceof LaunchError ? e.reason : "handshake";
    result = { protocol: "refused", reason };
  } finally { stop(); await exited; }
  // The helper detail arrives on its dedicated pipe, possibly after ACP stdout has already ended.
  return { ...result, ...(handle?.exitStatus.detail ? { detail: handle.exitStatus.detail } : {}) };
}

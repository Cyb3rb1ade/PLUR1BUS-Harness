// Tailscale detection and the `tailscale serve` command plan (D72, desktop spec §6.2 "tailnet"). Nothing here runs a
// process by itself: every command goes through an injected ExecPort, so tests feed fake output and the API package
// decides how processes are spawned (fixed argv, no shell). Funnel is blocked structurally: assertNoFunnel() runs on
// every plan before the first command, and nothing in this module builds a funnel command.

export interface ExecResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
export interface ExecPort {
  /** Rejects with an error whose `code` is "ENOENT" when the file does not exist. A non-zero exit resolves. */
  run(file: string, args: readonly string[], opts?: { readonly timeoutMs?: number }): Promise<ExecResult>;
}
export interface Command { readonly file: string; readonly args: readonly string[] }

export type TailscaleState = "not-installed" | "daemon-down" | "needs-login" | "stopped" | "running";
export interface TailscaleStatus {
  readonly state: TailscaleState;
  readonly loggedIn: boolean;
  readonly cliPath?: string;
  readonly version?: string;
  readonly tailnetName?: string;
  readonly magicDnsName?: string;
  readonly magicDnsSuffix?: string;
  readonly message?: string;
}

/** PATH first, then the places the official installers put the CLI (macOS app bundle, Homebrew, Windows). */
export const CLI_CANDIDATES: readonly string[] = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "tailscale.exe",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];
const TIMEOUT = { timeoutMs: 8000 } as const;

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export async function detectTailscale(exec: ExecPort, candidates: readonly string[] = CLI_CANDIDATES): Promise<TailscaleStatus> {
  let cli: string | undefined;
  let version: string | undefined;
  for (const candidate of candidates) {
    try {
      const r = await exec.run(candidate, ["version"], TIMEOUT);
      cli = candidate;
      version = r.stdout.split(/\r?\n/)[0]?.trim() || undefined;
      break;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (cli === undefined) return { state: "not-installed", loggedIn: false, message: "no Tailscale CLI found" };
  const base = { cliPath: cli, ...(version !== undefined ? { version } : {}) };

  const r = await exec.run(cli, ["status", "--json"], TIMEOUT);
  if (r.code !== 0) return { state: "daemon-down", loggedIn: false, ...base, message: (r.stderr || r.stdout).trim() || "tailscale status failed" };
  let json: Record<string, unknown> | undefined;
  try { json = rec(JSON.parse(r.stdout)); } catch { json = undefined; }
  if (!json) return { state: "daemon-down", loggedIn: false, ...base, message: "unparseable status output" };

  const backend = str(json["BackendState"]);
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") return { state: "needs-login", loggedIn: false, ...base };
  if (backend !== "Running") return { state: "stopped", loggedIn: false, ...base, ...(backend ? { message: `backend state ${backend}` } : {}) };

  const tailnet = rec(json["CurrentTailnet"]);
  const self = rec(json["Self"]);
  const tailnetName = str(tailnet?.["Name"]);
  const dns = str(self?.["DNSName"])?.replace(/\.$/, "");
  const suffix = str(tailnet?.["MagicDNSSuffix"]) ?? str(json["MagicDNSSuffix"]);
  return {
    state: "running", loggedIn: true, ...base,
    ...(tailnetName ? { tailnetName } : {}),
    ...(dns ? { magicDnsName: dns } : {}),
    ...(suffix ? { magicDnsSuffix: suffix } : {}),
  };
}

// --- serve plan ----------------------------------------------------------------------------------------------------

const HTTPS_PORTS = new Set([443, 8443, 10000]);

/** `tailscale serve` publishes inside the tailnet only; the target is always the loopback API port. */
export function planServe(o: { cli: string; port: number; httpsPort?: 443 | 8443 | 10000 }): Command[] {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error("port must be an integer from 1 to 65535");
  const httpsPort = o.httpsPort ?? 443;
  if (!HTTPS_PORTS.has(httpsPort)) throw new Error("httpsPort must be 443, 8443 or 10000");
  return [{ file: o.cli, args: ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${o.port}`] }];
}

export function planServeOff(o: { cli: string; httpsPort?: 443 | 8443 | 10000 }): Command[] {
  const httpsPort = o.httpsPort ?? 443;
  if (!HTTPS_PORTS.has(httpsPort)) throw new Error("httpsPort must be 443, 8443 or 10000");
  return [{ file: o.cli, args: ["serve", `--https=${httpsPort}`, "off"] }];
}

/** The API is never published to the internet. Any command that mentions funnel, in any argument, is refused. */
export function assertNoFunnel(commands: readonly Command[]): void {
  for (const c of commands) {
    if (/funnel/i.test(c.file) || c.args.some((a) => /funnel/i.test(a))) {
      throw new Error(`refusing a funnel command: ${[c.file, ...c.args].join(" ")}`);
    }
  }
}

/** Runs the commands in order and stops at the first one that exits non-zero (that result is the last one returned). */
export async function runServePlan(exec: ExecPort, commands: readonly Command[]): Promise<ExecResult[]> {
  assertNoFunnel(commands);
  const results: ExecResult[] = [];
  for (const c of commands) {
    const r = await exec.run(c.file, c.args, TIMEOUT);
    results.push(r);
    if (r.code !== 0) break;
  }
  return results;
}

export interface ServeStatus { readonly funnelActive: boolean; readonly proxies: readonly string[] }

/** Reads `tailscale serve status --json`. Empty output means nothing is served; undefined means the text is not JSON. */
export function parseServeStatus(text: string): ServeStatus | undefined {
  if (text.trim() === "") return { funnelActive: false, proxies: [] };
  let json: Record<string, unknown> | undefined;
  try { json = rec(JSON.parse(text)); } catch { return undefined; }
  if (!json) return undefined;
  const allow = rec(json["AllowFunnel"]);
  const funnelActive = allow !== undefined && Object.values(allow).some((v) => v === true);
  const proxies: string[] = [];
  for (const site of Object.values(rec(json["Web"]) ?? {})) {
    for (const handler of Object.values(rec(rec(site)?.["Handlers"]) ?? {})) {
      const proxy = str(rec(handler)?.["Proxy"]);
      if (proxy) proxies.push(proxy);
    }
  }
  return { funnelActive, proxies };
}

export async function detectServe(exec: ExecPort, cli: string): Promise<ServeStatus | undefined> {
  const r = await exec.run(cli, ["serve", "status", "--json"], TIMEOUT);
  return r.code === 0 ? parseServeStatus(r.stdout) : undefined;
}

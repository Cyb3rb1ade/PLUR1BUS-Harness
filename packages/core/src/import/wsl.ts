// WSL discovery, enumeration and probing (§B.2, gap G5, owner decision C12).
// WSL output is UTF-16LE on Windows; runner calls have hard timeouts and all wsl.exe calls are injectable.
import { execFile } from "node:child_process";
import { ImportError } from "./types.ts";

export interface WslDistro {
  name: string;
  state: "Running" | "Stopped";
  version: number;
  isDefault: boolean;
}

export type WslRunner = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }>;

export const defaultWslRunner: WslRunner = async (cmd, opts) => {
  const timeout = opts?.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    execFile(cmd[0]!, cmd.slice(1), { timeout, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as any;
        if (e.code === "ENOENT") {
          resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from("wsl.exe not found"), exitCode: 127 });
          return;
        }
        if (e.killed || e.signal === "SIGTERM") {
          reject(new ImportError("E_SOURCE_BUSY", "wsl-timeout", `wsl.exe timed out after ${timeout}ms`));
          return;
        }
        resolve({
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ?? Buffer.alloc(0),
          exitCode: typeof e.code === "number" ? e.code : 1,
        });
        return;
      }
      resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0), exitCode: 0 });
    });
  });
};

/** Decodes wsl.exe output defensively: UTF-16LE (with or without BOM) or UTF-8. */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

/** Parses `wsl.exe -l -v` text output into structured distro records. Listing never boots a distro (C12). */
export function parseWslListOutput(text: string): WslDistro[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const distros: WslDistro[] = [];
  for (const line of lines) {
    if (/^\s*NAME\s+STATE\s+VERSION\s*$/i.test(line)) continue;
    const m = /^\s*(\*?)\s*(.+?)\s+(Running|Stopped)\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const isDefault = m[1] === "*";
    const name = m[2]!.trim();
    const state = m[3]!.toLowerCase() === "running" ? "Running" : "Stopped";
    const version = parseInt(m[4]!, 10);
    distros.push({ name, state, version, isDefault });
  }
  return distros;
}

/** Lists installed WSL distros using `wsl.exe -l -v`. */
export async function listWslDistros(runner: WslRunner = defaultWslRunner, timeoutMs = 10_000): Promise<WslDistro[]> {
  try {
    const res = await runner(["wsl.exe", "-l", "-v"], { timeoutMs });
    if (res.exitCode !== 0) return [];
    const text = decodeWslOutput(res.stdout);
    return parseWslListOutput(text);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    return [];
  }
}

export interface WslCandidate {
  sourceType: "openclaw" | "hermes";
  distro: string;
  state: "Running" | "Stopped";
  sourceRoot: string;
  accessRoot: string;
  sourceHome: string;
  accessHome: string;
  profile?: string | null;
  probed: boolean;
  reason?: string;
}

export interface WslProbeOptions {
  runner?: WslRunner | undefined;
  probeWsl?: boolean | undefined;
  timeoutMs?: number | undefined;
}

const PROBE_SCRIPT = `H="$HOME"
OC_STATE="\${OPENCLAW_STATE_DIR:-\$H/.openclaw}"
OC_LEGACY="\$H/.clawdbot"
H_HOME="\${HERMES_HOME:-\$H/.hermes}"
echo "HOME=\$H"
if [ -d "$OC_STATE" ]; then echo "OPENCLAW=\$OC_STATE"; elif [ -d "$OC_LEGACY" ]; then echo "OPENCLAW=\$OC_LEGACY"; fi
if [ -d "$H_HOME" ]; then echo "HERMES=\$H_HOME"; fi
`;

/** Probes one WSL distro for OpenClaw or Hermes source installations (§B.2).
 *  Stopped distros are only probed when `opts.probeWsl` is true (C12). */
export async function probeWslDistro(distro: WslDistro, opts: WslProbeOptions = {}): Promise<WslCandidate[]> {
  const runner = opts.runner ?? defaultWslRunner;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (distro.state === "Stopped" && !opts.probeWsl) {
    return [{
      sourceType: "openclaw",
      distro: distro.name,
      state: "Stopped",
      sourceRoot: "",
      accessRoot: "",
      sourceHome: "",
      accessHome: "",
      probed: false,
      reason: "stopped (not probed)",
    }];
  }

  const res = await runner(["wsl.exe", "-d", distro.name, "-e", "sh", "-lc", PROBE_SCRIPT], { timeoutMs });
  if (res.exitCode !== 0) {
    return [{
      sourceType: "openclaw",
      distro: distro.name,
      state: distro.state,
      sourceRoot: "",
      accessRoot: "",
      sourceHome: "",
      accessHome: "",
      probed: false,
      reason: `probe-failed: exit ${res.exitCode}`,
    }];
  }

  const text = decodeWslOutput(res.stdout);
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  const sourceHome = vars.HOME || "/home";
  const prefix = `\\\\wsl.localhost\\${distro.name}`;
  const toAccess = (p: string) => `${prefix}${p.replace(/\//g, "\\")}`;

  const candidates: WslCandidate[] = [];
  if (vars.OPENCLAW) {
    candidates.push({
      sourceType: "openclaw",
      distro: distro.name,
      state: distro.state,
      sourceRoot: vars.OPENCLAW,
      accessRoot: toAccess(vars.OPENCLAW),
      sourceHome,
      accessHome: toAccess(sourceHome),
      probed: true,
    });
  }
  if (vars.HERMES) {
    candidates.push({
      sourceType: "hermes",
      distro: distro.name,
      state: distro.state,
      sourceRoot: vars.HERMES,
      accessRoot: toAccess(vars.HERMES),
      sourceHome,
      accessHome: toAccess(sourceHome),
      probed: true,
    });
  }
  return candidates;
}

/** Lists all WSL distros and probes candidates. */
export async function enumerateWslCandidates(opts: WslProbeOptions = {}): Promise<WslCandidate[]> {
  const runner = opts.runner ?? defaultWslRunner;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const distros = await listWslDistros(runner, timeoutMs);
  const out: WslCandidate[] = [];
  for (const d of distros) {
    const candidates = await probeWslDistro(d, opts);
    out.push(...candidates);
  }
  return out;
}

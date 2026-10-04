// WSL discovery, enumeration and probing (§B.2, gap G5, owner decision C12).
// WSL output is UTF-16LE on Windows; runner calls have hard timeouts and all wsl.exe calls are injectable.
import { execFile, spawn } from "node:child_process";
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
    execFile(cmd[0]!, cmd.slice(1), { timeout, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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

/** Spawns wsl.exe streaming tar extraction directly without buffering the entire archive into memory (§B.3, I2). */
export function spawnWslTarStream(
  distro: string,
  sourceRoot: string,
  subpaths: string[],
  opts: { timeoutMs?: number } = {}
): { stream: AsyncIterable<Buffer>; abort: () => void } {
  if (!distro || /[\/\\:\0\r\n]/.test(distro) || distro.startsWith("-")) {
    throw new ImportError("E_INVALID_PARAMS", "invalid-distro-name", `Invalid WSL distro name: ${distro}`, 2);
  }
  for (const p of subpaths) {
    if (p.startsWith("-")) {
      throw new ImportError("E_TAR_SECURITY", "invalid-subpath", `Subpath cannot start with '-': ${p}`, 3);
    }
    if (p.includes("\0")) {
      throw new ImportError("E_TAR_SECURITY", "invalid-subpath", "Subpath cannot contain NUL byte", 3);
    }
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const args = ["-d", distro, "--exec", "tar", "-h", "-C", sourceRoot, "-cf", "-", "--", ...subpaths];
  const child = spawn("wsl.exe", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch {}
  }, timeoutMs);

  async function* generator(): AsyncIterable<Buffer> {
    try {
      for await (const chunk of child.stdout) {
        yield chunk as Buffer;
      }
      clearTimeout(timer);
      if (timedOut) {
        throw new ImportError("E_SOURCE_BUSY", "wsl-timeout", `wsl.exe tar timed out after ${timeoutMs}ms`);
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        const stderr = child.stderr ? child.stderr.read() : null;
        const errText = stderr ? (stderr as Buffer).toString("utf8") : "";
        throw new ImportError("E_IMPORT_FAILED", "wsl-tar-failed", `wsl.exe tar failed (exit ${child.exitCode}): ${errText}`, 2);
      }
    } finally {
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  return {
    stream: generator(),
    abort: () => {
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
    },
  };
}

/** Decodes wsl.exe output defensively: UTF-16LE (with or without BOM) or UTF-8. */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 4) {
    // UTF-16LE has high byte 0x00 for ASCII chars (0..127); sample across up to 100 bytes
    let nullCount = 0;
    const sample = Math.min(buf.length, 100);
    for (let i = 1; i < sample; i += 2) {
      if (buf[i] === 0x00) nullCount++;
    }
    if (nullCount >= Math.floor(sample / 4)) {
      return buf.toString("utf16le");
    }
  }
  return buf.toString("utf8");
}

/** Parses `wsl.exe -l -v` text output into structured distro records with language-neutral status matching (I7). */
export function parseWslListOutput(text: string): WslDistro[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const distros: WslDistro[] = [];
  for (const line of lines) {
    if (/^\s*(NAME|NOM|NOMBRE)\s+(STATE|STATUS|STATUT|ESTADO)\s+(VERSION|VERSIÓN)\s*$/i.test(line)) continue;
    // Version is always the last numeric column
    const mVer = /\s+(\d+)\s*$/.exec(line);
    if (!mVer) {
      if (/^\s*$/.test(line)) continue;
      if (/NAME|VERSION|STATUS|STATE/i.test(line)) continue;
      throw new ImportError("E_IMPORT_FAILED", "wsl-unparseable", `Could not parse WSL output line: ${line}`, 2);
    }
    const version = parseInt(mVer[1]!, 10);
    const rest = line.slice(0, mVer.index).trim();
    const isDefault = rest.startsWith("*");
    const cleanRest = (isDefault ? rest.slice(1) : rest).trim();

    // Split on 2 or more spaces separating NAME and STATE
    const parts = cleanRest.split(/\s{2,}/);
    if (parts.length >= 2) {
      const name = parts[0]!.trim();
      const stateRaw = parts[parts.length - 1]!.trim().toLowerCase();
      const isRunning = /running|wird ausgeführt|en cours|attivo|em execução|en ejecución/i.test(stateRaw);
      const isStopped = /stopped|beendet|arrêté|interrompido|disattivato|detenido/i.test(stateRaw);
      if (!isRunning && !isStopped) {
        throw new ImportError("E_IMPORT_FAILED", "wsl-unparseable", `Could not recognize WSL distro state: ${stateRaw}`, 2);
      }
      const state: "Running" | "Stopped" = isRunning ? "Running" : "Stopped";
      distros.push({ name, state, version, isDefault });
    } else {
      const m = /^(.+?)\s+(Running|Stopped|Wird ausgeführt|Beendet|En cours|Arrêté)\s*$/i.exec(cleanRest);
      if (m) {
        const name = m[1]!.trim();
        const stateRaw = m[2]!.toLowerCase();
        const isRunning = /running|wird ausgeführt|en cours/i.test(stateRaw);
        distros.push({ name, state: isRunning ? "Running" : "Stopped", version, isDefault });
      } else {
        throw new ImportError("E_IMPORT_FAILED", "wsl-unparseable", `Could not parse WSL distro name and state: ${cleanRest}`, 2);
      }
    }
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

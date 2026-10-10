// The native helper (crates/plur1bus-attest) as a child process: one JSON line in on stdin, one JSON line out on stdout, then it
// exits. The core pins the helper twice. By file system: an absolute path to a regular file that is not writable by group or others
// (`helperPinned`). By content: when the installation hands the core a `HelperPin`, the file must have the expected SHA-256 and,
// where configured, a valid macOS code signature of the expected team or Windows Authenticode signature of the expected signer.
// A deviation is no helper (`refused`, with a reason for the audit log), never a dialog. A helper that does not answer within
// the deadline is killed.
import { execFile, spawn } from "node:child_process";
import { constants as fsc, createReadStream, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

/** What the installation expects of the helper binary. Absent fields are not checked; a present but malformed one fails closed. */
export interface HelperPin {
  /** Lower- or upper-case hex SHA-256 of the helper binary (release build constant). */
  sha256?: string;
  /** macOS: Apple team id (10 upper-case letters or digits) the code signature must carry (`codesign --verify`). */
  macTeamId?: string;
  /** Windows: SHA-1 thumbprint (40 hex digits) of the Authenticode signer certificate. */
  winThumbprint?: string;
}

export interface HelperSpec {
  /** Absolute path of the executable. */
  path: string;
  /** Arguments before the mode flag (`--attest` / `--probe`); tests run a Node script this way. */
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  pin?: HelperPin;
}

/** Why a helper was not run. These strings go to the audit log (`reason`). */
export type HelperRefusal =
  | "helper-not-pinned" | "helper-pin-malformed" | "helper-unreadable" | "helper-hash-mismatch"
  | "helper-signature-invalid" | "helper-signature-unchecked" | "helper-changed-during-run";

export type HelperOutcome = { kind: "reply"; value: Record<string, unknown> } | { kind: "timeout" } | { kind: "missing" } | { kind: "broken" } | { kind: "refused"; reason: HelperRefusal };

/**
 * Absolute, regular, not group/world-writable, owned by root or by the core's own user, and in a directory that is neither
 * group/world-writable nor owned by anyone else (POSIX): otherwise another user could swap the file. A relative path, a link, a
 * directory or a missing file is `false`. This stops other users, not the owner's own processes (docs/security/os-attestation-2026-10.md).
 */
export function helperPinned(path: string): boolean {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    const me = process.getuid?.() ?? -1;
    if ((st.mode & 0o022) !== 0 || (st.uid !== 0 && st.uid !== me)) return false;
    const dir = lstatSync(dirname(path));
    // A sticky shared directory (/tmp) is writable by everyone on purpose and is still no place for a helper.
    return dir.isDirectory() && (dir.mode & 0o022) === 0 && (dir.uid === 0 || dir.uid === me);
  } catch { return false; }
}

export type ExecFn = (file: string, args: readonly string[], o?: { env?: Record<string, string | undefined> }) => Promise<{ code: number; stdout: string }>;

/** `execFile` (never a shell): a non-zero exit is a result, anything else (missing tool, timeout) is a throw. */
const defaultExec: ExecFn = (file, args, o) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024, env: (o?.env ?? process.env) as NodeJS.ProcessEnv }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout: String(stdout) });
    const c = (err as NodeJS.ErrnoException).code;
    if (typeof c === "number") return resolve({ code: c, stdout: String(stdout) });
    reject(err);
  });
});

export interface VerifyDeps { platform?: NodeJS.Platform; exec?: ExecFn }
export type HelperVerdict = { ok: true; fingerprint: string } | { ok: false; reason: HelperRefusal };

const SHA256_RE = /^[0-9a-f]{64}$/u;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/u;
const THUMBPRINT_RE = /^[0-9A-F]{40}$/u;
// Constant script: the path reaches PowerShell through the environment, never through the command text.
const AUTHENTICODE_SCRIPT = "$s = Get-AuthenticodeSignature -LiteralPath $env:PLUR1BUS_VERIFY_PATH; if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { exit 2 }; [Console]::Out.Write($s.SignerCertificate.Thumbprint)";

/** SHA-256 of the file read through one open descriptor that is also the file at `path` (no link, same dev+ino): a swap between
 *  the lstat and the read cannot make the hash describe a different file than the one that was checked. */
async function hashOpened(path: string): Promise<{ sha: string; stamp: string } | null> {
  let fh;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile()) return null;
    fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    const st = await fh.stat({ bigint: true });
    if (st.dev !== before.dev || st.ino !== before.ino) return null;
    const h = createHash("sha256");
    for await (const chunk of createReadStream(path, { fd: fh.fd, autoClose: false, start: 0 })) h.update(chunk as Buffer);
    const after = await fh.stat({ bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) return null; // changed while being read
    return { sha: h.digest("hex"), stamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` };
  } catch { return null; }
  finally { await fh?.close().catch(() => {}); }
}

/**
 * Checks the helper against its pin. Called before every start and once more after the reply: the file is not trusted because
 * it was fine at start-up. The returned fingerprint (file identity, times, hash) lets the caller see a change during a run.
 * RESIDUAL: the window between this check and the `exec` of the same path is not closed (Node cannot exec a descriptor); the
 * check after the reply discards an answer from anything that changed the file meanwhile. An attacker who can write the
 * helper's directory as the owner and restore the file in time is not stopped (docs/security/os-attestation-2026-10.md).
 */
export async function verifyHelper(spec: HelperSpec, deps: VerifyDeps = {}): Promise<HelperVerdict> {
  if (!helperPinned(spec.path)) return { ok: false, reason: "helper-not-pinned" };
  const pin = spec.pin;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  if (pin === undefined) return { ok: true, fingerprint: "" };
  let fingerprint = "";
  if (pin.sha256 !== undefined) {
    const want = pin.sha256.toLowerCase();
    if (!SHA256_RE.test(want)) return { ok: false, reason: "helper-pin-malformed" };
    const got = await hashOpened(spec.path);
    if (got === null) return { ok: false, reason: "helper-unreadable" };
    if (got.sha !== want) return { ok: false, reason: "helper-hash-mismatch" };
    fingerprint = `${got.stamp}:${got.sha}`;
  }
  if (platform === "darwin" && pin.macTeamId !== undefined) {
    if (!TEAM_ID_RE.test(pin.macTeamId)) return { ok: false, reason: "helper-signature-invalid" };
    // The team id is validated above, so it cannot close the quoted string or add a clause to the requirement.
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${pin.macTeamId}"`;
    try {
      const r = await exec("/usr/bin/codesign", ["--verify", "--strict", "--test-requirement", requirement, spec.path]);
      if (r.code !== 0) return { ok: false, reason: "helper-signature-invalid" };
    } catch { return { ok: false, reason: "helper-signature-unchecked" }; }
  }
  if (platform === "win32" && pin.winThumbprint !== undefined) {
    const want = pin.winThumbprint.toUpperCase();
    if (!THUMBPRINT_RE.test(want)) return { ok: false, reason: "helper-signature-invalid" };
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      const r = await exec(ps, ["-NoProfile", "-NonInteractive", "-Command", AUTHENTICODE_SCRIPT], { env: { ...process.env, PLUR1BUS_VERIFY_PATH: spec.path } });
      if (r.code !== 0 || r.stdout.trim().toUpperCase() !== want) return { ok: false, reason: "helper-signature-invalid" };
    } catch { return { ok: false, reason: "helper-signature-unchecked" }; }
  }
  return { ok: true, fingerprint };
}

const MAX_REPLY_BYTES = 64 * 1024;

function runVerified(spec: HelperSpec, mode: "--attest" | "--probe", request: unknown, deadlineMs: number): Promise<HelperOutcome> {
  return new Promise<HelperOutcome>((resolve) => {
    let settled = false;
    const finish = (o: HelperOutcome): void => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(o); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.path, [...(spec.args ?? []), mode], { stdio: ["pipe", "pipe", "ignore"], windowsHide: false, env: { ...process.env, ...spec.env } });
    } catch { return resolve({ kind: "missing" }); }
    const timer = setTimeout(() => finish({ kind: "timeout" }), deadlineMs);
    let out = "";
    child.on("error", () => finish({ kind: "missing" }));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => {
      out += c;
      if (out.length > MAX_REPLY_BYTES) return finish({ kind: "broken" });
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      try {
        const v = JSON.parse(out.slice(0, nl)) as unknown;
        if (typeof v !== "object" || v === null || Array.isArray(v)) return finish({ kind: "broken" });
        finish({ kind: "reply", value: v as Record<string, unknown> });
      } catch { finish({ kind: "broken" }); }
    });
    child.on("close", () => finish({ kind: "broken" }));
    child.stdin!.on("error", () => { /* the close handler reports it */ });
    child.stdin!.end(request === undefined ? "" : `${JSON.stringify(request)}\n`);
  });
}

export async function runHelper(spec: HelperSpec, mode: "--attest" | "--probe", request: unknown, deadlineMs: number, deps: VerifyDeps = {}): Promise<HelperOutcome> {
  const before = await verifyHelper(spec, deps);
  if (!before.ok) return before.reason === "helper-not-pinned" ? { kind: "missing" } : { kind: "refused", reason: before.reason };
  const out = await runVerified(spec, mode, request, deadlineMs);
  if (out.kind !== "reply" || spec.pin === undefined) return out;
  // The answer counts only if the file that gave it is still the one that was checked.
  const after = await verifyHelper(spec, deps);
  return after.ok && after.fingerprint === before.fingerprint ? out : { kind: "refused", reason: "helper-changed-during-run" };
}

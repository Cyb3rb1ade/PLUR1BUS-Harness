// The native helper (crates/plur1bus-attest) as a child process: one JSON line in on stdin, one JSON line out on stdout, then it
// exits. The core pins the helper: an absolute path to a regular file that is not writable by group or others. A helper that
// does not answer within the deadline is killed.
import { spawn } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { lstatSync } from "node:fs";

export interface HelperSpec {
  /** Absolute path of the executable. */
  path: string;
  /** Arguments before the mode flag (`--attest` / `--probe`); tests run a Node script this way. */
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export type HelperOutcome = { kind: "reply"; value: Record<string, unknown> } | { kind: "timeout" } | { kind: "missing" } | { kind: "broken" };

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

const MAX_REPLY_BYTES = 64 * 1024;

export function runHelper(spec: HelperSpec, mode: "--attest" | "--probe", request: unknown, deadlineMs: number): Promise<HelperOutcome> {
  if (!helperPinned(spec.path)) return Promise.resolve({ kind: "missing" });
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

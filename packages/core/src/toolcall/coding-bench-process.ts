/** Owned, credential-free commands for trusted fixtures and provisioning. Live candidate checks use VerifierPort. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "GOTOOLCHAIN",
  "GOPROXY",
  "GOSUMDB",
  "CGO_ENABLED",
  "GOMAXPROCS",
  "CARGO_HOME",
  "CARGO_NET_OFFLINE",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/** Copy only explicit fixture/toolchain variables; ambient credentials and loader injection never survive. */
export function codingEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => ENVIRONMENT.has(key) && typeof value === "string" && !value.includes("\0"),
    ),
  );
}

/** Closed failure vocabulary; compiler/candidate diagnostics are private, never public report fields. */
export type CodingCommandReason =
  "platform-unavailable" | "invalid-command" | "spawn-failed" | "aborted" | "timeout" | "output-limit";
/** Captured streams remain private to the checker coordinator. */
export interface CodingCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: CodingCommandReason;
}
/** A caller-owned private directory and bounded lifetime; no ambient environment is inherited. */
export interface CodingCommandOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal: AbortSignal;
}

/** Reap the leader and kill its owned group, including descendants retaining output pipes after the leader exits. */
export async function runCodingCommand(
  program: string,
  args: readonly string[],
  options: CodingCommandOptions,
): Promise<CodingCommandResult> {
  const empty = (reason: CodingCommandReason): CodingCommandResult => ({ code: null, stdout: "", stderr: "", reason });
  // Windows has no process-group ownership primitive here. Refuse instead of claiming cleanup we cannot guarantee.
  if (process.platform === "win32") return empty("platform-unavailable");
  if (
    !isAbsolute(program) ||
    !isAbsolute(options.root) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 300_000
  )
    return empty("invalid-command");
  if (options.signal.aborted) return empty("aborted");
  const cap = options.maxOutputBytes ?? 65_536;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1_048_576) return empty("invalid-command");
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      cwd: options.root,
      env: codingEnvironment(options.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let reason: CodingCommandReason | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* The owned group has already exited. */
      }
    };
    const stop = (why: CodingCommandReason) => {
      if (reason) return;
      reason = why;
      kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 100);
      hardKill.unref();
    };
    const data = (target: Buffer[], chunk: Buffer) => {
      const left = cap - size;
      if (left > 0) target.push(chunk.subarray(0, left));
      size += chunk.length;
      if (size > cap) stop("output-limit");
    };
    const abort = () => stop("aborted");
    child.stdout.on("data", (chunk) => data(stdout, chunk));
    child.stderr.on("data", (chunk) => data(stderr, chunk));
    // `exit`, rather than only `close`: a grandchild may otherwise keep the leader's output pipes open forever.
    child.once("exit", () => kill("SIGKILL"));
    child.once("error", () => {
      reason = "spawn-failed";
    });
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(hardKill);
      options.signal.removeEventListener("abort", abort);
      kill("SIGKILL");
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(reason ? { reason } : {}),
      });
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
}

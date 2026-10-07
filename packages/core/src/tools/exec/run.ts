// exec.run: validate -> tier gate -> policy.decide (-> approval) -> audit -> spawn -> bounded collection -> audit.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { decide, type Call } from "../../policy/index.ts";
import { canonicalisePath } from "../../policy/paths.ts";
import { argsMatchPattern, findAllowed, validateArgs, validateProgram } from "./args.ts";
import { buildEnv, DEFAULT_ENV_ALLOW } from "./env.ts";
import { ExecFailure, type ExecDeps, type ExecRequest, type ExecResult } from "./types.ts";

export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
export const EXEC_MAX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function clampInt(v: unknown, def: number, max: number, what: string): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ExecFailure("invalid-input", `${what} must be a positive integer`);
  return Math.min(v, max);
}

/** Collects up to `limit` bytes; the rest is read and dropped so the child never blocks on a full pipe. */
class Capture {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  truncated = false;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  push(c: Uint8Array): void {
    const room = this.limit - this.size;
    if (room <= 0) { if (c.length > 0) this.truncated = true; return; }
    const take = c.length > room ? c.subarray(0, room) : c;
    if (take.length < c.length) this.truncated = true;
    this.chunks.push(take);
    this.size += take.length;
  }
  /** Decoded as UTF-8; a multi-byte character cut by the limit becomes U+FFFD, never an error. */
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

export async function execRun(req: ExecRequest, deps: ExecDeps, signal?: AbortSignal): Promise<ExecResult> {
  const { config } = deps;
  const platform = deps.platform ?? process.platform;
  const windows = platform === "win32";
  const host = deps.host ?? "local";
  const audit = (action: string, target: string, detail: Record<string, unknown>): void => {
    try {
      deps.audit.append({ at: deps.timers.now(), actor: { user: deps.policyContext.principal.person, host }, action, target, detail });
    } catch {
      throw new ExecFailure("audit-failed", "the audit line could not be written; nothing was run");
    }
  };

  // Input shape first: a malformed call is refused (and recorded) whatever the tier.
  let program: string; let args: string[]; let timeoutMs: number; let maxOut: number;
  try {
    program = validateProgram(req.program);
    args = validateArgs(req.args);
    timeoutMs = clampInt(req.timeoutMs, config.defaultTimeoutMs ?? EXEC_TIMEOUT_MS, config.maxTimeoutMs ?? EXEC_MAX_TIMEOUT_MS, "timeoutMs");
    maxOut = clampInt(req.maxOutputBytes, config.defaultMaxOutputBytes ?? EXEC_MAX_OUTPUT_BYTES, config.maxMaxOutputBytes ?? EXEC_MAX_MAX_OUTPUT_BYTES, "maxOutputBytes");
    if (typeof req.cwd !== "string") throw new ExecFailure("invalid-input", "cwd must be a string");
  } catch (e) {
    if (e instanceof ExecFailure) audit("exec.refused", typeof req.program === "string" ? req.program : "?", { code: e.code });
    throw e;
  }
  const refuse = (code: ExecFailure["code"], msg: string, extra: Record<string, unknown> = {}): never => {
    audit("exec.refused", program, { code, argc: args.length, ...extra });
    throw new ExecFailure(code, msg);
  };

  // Tier `deny` (the default): nothing is started and nothing is asked.
  if (config.mode !== "ask" && config.mode !== "allowlist") return refuse("disabled", "exec.run is disabled (mode: deny)");

  // The working directory must be a directory inside a granted root.
  const cwd = await canonicalisePath(req.cwd, { roots: config.roots, ...(config.deny ? { deny: config.deny } : {}), access: "read", requireRoot: true, platform });
  if (!cwd.ok) return refuse("cwd-refused", `cwd refused: ${cwd.reason}`, { reason: cwd.reason });
  let isDir = false;
  try { isDir = (await stat(cwd.canonical)).isDirectory(); } catch { /* not a directory */ }
  if (!isDir) return refuse("cwd-refused", "cwd is not an existing directory", { reason: "not-directory" });

  let env: Record<string, string>;
  try {
    env = buildEnv({ allow: config.envAllow ?? DEFAULT_ENV_ALLOW, base: deps.baseEnv ?? process.env, requested: req.env, windows });
  } catch (e) {
    return refuse("env-refused", e instanceof Error ? e.message : "environment refused");
  }

  const entry = findAllowed(config.allowlist, program, windows);
  if (config.mode === "allowlist" && (!entry || !argsMatchPattern(entry, args))) {
    return refuse("not-allowlisted", entry ? "an argument does not match the program's allowlist pattern" : "program is not on the allowlist");
  }
  // RULING: the allowlist only relaxes the `allowlist` tier; in `ask` every run is asked (or covered by a grant).
  const allowlisted = config.mode === "allowlist" && entry !== undefined && argsMatchPattern(entry, args);

  const envNames = Object.keys(env).sort();
  const actionHash = createHash("sha256").update(JSON.stringify({ c: "shell.exec", t: "exec.run", program, args, cwd: cwd.canonical, env: envNames })).digest("hex");
  const call: Call = {
    capability: "shell.exec", tool: "exec.run", effect: "local-write", targets: [cwd.canonical], access: "write", actionHash,
    flags: { outsideRoots: false, denyListHit: false, shellAllowlisted: allowlisted, sandboxed: false },
  };
  const decision = decide(call, deps.policyContext, deps.policy);
  const base = { argc: args.length, argsSha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"), cwd: cwd.canonical, envNames, mode: config.mode, actionHash };

  let via: string;
  if (decision.kind === "deny") {
    return refuse("policy-denied", `policy refused: ${decision.rule}`, { ...base, rule: decision.rule });
  } else if (decision.kind === "ask") {
    // RULING: a parked (headless) or unanswerable request is a refusal, never a wait.
    const answer = decision.park || !deps.approvals ? { approved: false } : await deps.approvals.request(decision.request).catch(() => ({ approved: false }));
    if (answer.approved !== true) return refuse("approval-denied", "approval was not given", { ...base, why: decision.why });
    via = "approval";
  } else {
    via = decision.via;
  }

  audit("exec.run", program, { ...base, decision: "allow", via });

  const started = deps.timers.now();
  const out = new Capture(maxOut);
  const err = new Capture(maxOut);
  let handle;
  try {
    handle = deps.process.spawn({ program, args, cwd: cwd.canonical, env });
  } catch (e) {
    audit("exec.result", program, { actionHash, outcome: "spawn-failed" });
    throw new ExecFailure("spawn-failed", e instanceof Error ? e.message : "spawn failed");
  }
  handle.onStdout((c) => out.push(c));
  handle.onStderr((c) => err.push(c));

  let timedOut = false; let aborted = false;
  const kill = (): void => { void handle.killTree(); };
  const timer = deps.timers.setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const onAbort = (): void => { aborted = true; kill(); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const exit = await handle.wait();
    if (timedOut || aborted) await handle.killTree(); // the tree is gone before we report
    const result: ExecResult = {
      exitCode: exit.code, signal: exit.signal, stdout: out.text(), stderr: err.text(),
      stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timedOut, aborted, durationMs: deps.timers.now() - started,
    };
    audit("exec.result", program, { actionHash, outcome: timedOut ? "timeout" : aborted ? "aborted" : "exited", exitCode: exit.code, signal: exit.signal, truncated: out.truncated || err.truncated, durationMs: result.durationMs });
    return result;
  } catch (e) {
    await handle.killTree();
    try { audit("exec.result", program, { actionHash, outcome: "spawn-failed" }); } catch { /* the failure below is the report */ }
    throw new ExecFailure("spawn-failed", e instanceof Error ? e.message : "spawn failed");
  } finally {
    deps.timers.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

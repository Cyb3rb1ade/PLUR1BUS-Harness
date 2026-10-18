// exec.run: validate -> tier gate -> policy.decide (-> approval) -> audit -> spawn -> bounded collection -> audit.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { decide, type Call } from "../../policy/index.ts";
import { canonicalisePath } from "../../policy/paths.ts";
import type { ApprovalAsk } from "../approval.ts";
import { argsMatchPattern, findAllowed, validateArgs, validateProgram } from "./args.ts";
import { buildEnv, DEFAULT_ENV_ALLOW, envFingerprint, isSecretishName } from "./env.ts";
import type { ToolClassification } from "../registry.ts";
import { OutputLines } from "../../logs/output.ts";
import { ExecFailure, type ExecDeps, type ExecRequest, type ExecResult } from "./types.ts";

export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
export const EXEC_MAX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// RULING: these decide which executable a bare name or a script resolves to. An allowlist entry names a program, not a
// search path, so in the unattended `allowlist` tier a request may not set them (`env: { PATH }` would swap `git`).
const LOOKUP_VARS: ReadonlySet<string> = new Set(["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT"]);
/** Inherited / requested lookup and locale names are not registered as log secrets. */
const BANAL_ENV: ReadonlySet<string> = new Set([...LOOKUP_VARS, "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TEMP", "TMP", "HOME"]);

function wrapSecrets(env: Record<string, string>, requested: Readonly<Record<string, string>> | undefined, windows: boolean): string[] {
  const asked = new Set(Object.keys(requested ?? {}).map((n) => (windows ? n.toUpperCase() : n)));
  const fold = (n: string) => (windows ? n.toUpperCase() : n);
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value.length < 8) continue;
    if (isSecretishName(name) || (asked.has(fold(name)) && !BANAL_ENV.has(name.toUpperCase()))) out.push(value);
  }
  return out;
}

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

export async function execRun(req: ExecRequest, deps: ExecDeps, signal?: AbortSignal, classified?: ToolClassification): Promise<ExecResult> {
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

  if (config.mode === "allowlist") {
    const steering = Object.keys(req.env ?? {}).find((n) => LOOKUP_VARS.has(n.toUpperCase()));
    if (steering !== undefined) return refuse("env-refused", `environment variable ${steering} decides which program runs and cannot be requested for an allowlisted program`);
  }

  const entry = findAllowed(config.allowlist, program, windows);
  if (config.mode === "allowlist" && (!entry || !argsMatchPattern(entry, args))) {
    return refuse("not-allowlisted", entry ? "an argument does not match the program's allowlist pattern" : "program is not on the allowlist");
  }
  // RULING: the allowlist only relaxes the `allowlist` tier; in `ask` every run is asked (or covered by a grant).
  const allowlisted = config.mode === "allowlist" && entry !== undefined && argsMatchPattern(entry, args);

  const envNames = Object.keys(env).sort();
  // The hash is what an approval or a once-grant is bound to, so it covers the values (PATH=/usr/bin is another action than
  // PATH=/tmp/x); the audit still records names only.
  const envPairs = envNames.map((n) => [n, env[n]]);
  const actionHash = createHash("sha256").update(JSON.stringify({ c: "shell.exec", t: "exec.run", program, args, cwd: cwd.canonical, env: envPairs })).digest("hex");
  const call: Call = {
    capability: "shell.exec", tool: "exec.run", effect: "local-write", targets: [cwd.canonical], access: "write", actionHash,
    flags: { outsideRoots: false, denyListHit: false, shellAllowlisted: allowlisted, sandboxed: false },
  };
  const base = { argc: args.length, argsSha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"), cwd: cwd.canonical, envNames, mode: config.mode, actionHash };

  const notStarted = (): ExecResult => {
    audit("exec.result", program, { actionHash, outcome: "aborted", started: false });
    return { exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: true, durationMs: 0 };
  };

  let via: string;
  // Dispatcher already gated this invocation; do not decide or consume again.
  if (deps.policyContext.overrides?.["shell.exec"] === "allowed") {
    via = "override";
  } else {
    const decision = decide(call, deps.policyContext, deps.policy);
    if (decision.kind === "deny") {
      return refuse("policy-denied", `policy refused: ${decision.rule}`, { ...base, rule: decision.rule });
    } else if (decision.kind === "ask") {
      // RULING: a parked (headless) or unanswerable request is a refusal, never a wait.
      const answer = decision.park || !deps.approvals ? { approved: false } : await raceAbort(deps.approvals.request(decision.request).catch(() => ({ approved: false })), signal);
      if (answer === "aborted") return notStarted();
      if (answer.approved !== true) return refuse("approval-denied", "approval was not given", { ...base, why: decision.why });
      if (deps.approvals?.begin) {
        const ctx = deps.policyContext;
        const ask: ApprovalAsk = {
          request: decision.request, callId: actionHash, tool: "exec.run", args: req,
          agentId: ctx.subject.agentId, principal: ctx.principal.person, park: decision.park,
          signal: signal ?? new AbortController().signal,
          subjectKind: ctx.subject.kind,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          ...(call.targets ? { targets: call.targets } : {}),
          ...(call.access ? { access: call.access } : {}),
        };
        let began = false;
        try { began = deps.approvals.begin(answer, ask) === true; } catch { began = false; }
        if (!began) return refuse("approval-denied", "the approval could not be used (already used, expired or bound to another action)", { ...base, why: decision.why });
      }
      via = "approval";
    } else {
      via = decision.via;
      if (via === "grant" && decision.grantId && deps.consumeOnce) {
        const g = deps.policy.grants.get(decision.grantId);
        if (!g || (g.scope === "once" && !deps.consumeOnce(decision.grantId, { person: g.person, agent: g.agent, actionHash: g.actionHash ?? actionHash }))) {
          return refuse("policy-denied", "the one-time grant was already used", { ...base, grantId: decision.grantId });
        }
      }
    }
  }

  if (classified) {
    const liveFp = envFingerprint(env);
    if (classified.targets?.[0] !== undefined && classified.targets[0] !== cwd.canonical) {
      return refuse("cwd-refused", "cwd no longer matches the classified call");
    }
    if (classified.hashExtra !== undefined && classified.hashExtra !== liveFp) {
      return refuse("env-refused", "environment no longer matches the classified call");
    }
  }

  if (signal?.aborted) return notStarted(); // nothing is started for a call that was cancelled while it waited
  audit("exec.run", program, via === "override" ? { ...base } : { ...base, decision: "allow", via });

  const started = deps.timers.now();
  const out = new Capture(maxOut);
  const err = new Capture(maxOut);
  const localSecrets = wrapSecrets(env, req.env, windows);
  const wrapOpts = { now: () => deps.timers.now(), ...(localSecrets.length ? { secrets: localSecrets } : {}) };
  const stdoutWrap = deps.output ? new OutputLines(deps.output, "stdout", wrapOpts) : null;
  const stderrWrap = deps.output ? new OutputLines(deps.output, "stderr", wrapOpts) : null;
  let handle;
  try {
    handle = deps.process.spawn({ program, args, cwd: cwd.canonical, env });
  } catch (e) {
    stdoutWrap?.close(); stderrWrap?.close();
    audit("exec.result", program, { actionHash, outcome: "spawn-failed" });
    throw new ExecFailure("spawn-failed", e instanceof Error ? e.message : "spawn failed");
  }
  handle.onStdout((c) => { out.push(c); stdoutWrap?.push(Buffer.from(c)); });
  handle.onStderr((c) => { err.push(c); stderrWrap?.push(Buffer.from(c)); });
  let tickHandle: unknown;
  const armTick = (): void => {
    tickHandle = deps.timers.setTimeout(() => {
      stdoutWrap?.tick(); stderrWrap?.tick();
      try { deps.output?.flush(); } catch { /* queued lines retry on the next tick or close */ }
      armTick();
    }, 1000);
  };
  if (stdoutWrap || stderrWrap) armTick();

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
    if (tickHandle !== undefined) deps.timers.clearTimeout(tickHandle);
    stdoutWrap?.close(); stderrWrap?.close();
    deps.output?.flush();
    deps.timers.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Settles with `"aborted"` as soon as the signal fires; the pending promise is left to settle on its own. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | "aborted"> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const on = (): void => resolve("aborted");
    signal.addEventListener("abort", on, { once: true });
    void p.then((v) => { signal.removeEventListener("abort", on); resolve(v); });
  });
}

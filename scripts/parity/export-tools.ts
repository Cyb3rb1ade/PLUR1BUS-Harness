// Parity vectors (mode V) for the executors behind the typestate gate (P4-K K10a, plan P4-30 without web): `exec.run`
// (`packages/core/src/tools/exec/`) and the file tools (`packages/core/src/tools/fs/`).
//
// - `exec-rules.json` (pure, replayed on every system): program and argument validation, the allowlist lookup and the
//   argument pattern, the child's environment (allowlist, the secret-looking names, requested names, Windows folding),
//   the environment fingerprint, and the bounded capture of a stream (byte limit, the cut inside a character, secrets).
// - `exec-runs.json` (recorded on darwin against real directories): `createExecTool(...).execute` on the path the
//   dispatcher uses (the policy already decided: `overrides["shell.exec"] = "allowed"`), with the fake process port and
//   the fake timers of the TypeScript tests. Every run records the outcome, every audit line, what was spawned and how
//   often the tree was killed. The action hash depends on the directory of the run, so the vector holds its preimage with
//   `$ROOT` in it; the exporter checks that the preimage hashes to what the TypeScript code recorded.
// - `fs.json` (recorded on darwin against real files, differential like `policy-fs`): a file tree per case, then tool
//   calls and changes of the tree in turn, with every outcome and what is on disk afterwards.
// - `fs-meta.json` (pure): the failure texts, the schemas and the capability rows.
//
// A value `{ "$repeat": [text, n] }` in an input stands for `text.repeat(n)` and `{ "$fill": [value, n] }` for an array
// of `n` copies: the big inputs of the size limits are not written out. Secret-shaped test material is stored in parts
// (`{ "parts": [...] }`). Recorded, never edited by hand.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-tools.ts [--check]
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecretMatcher } from "../../packages/core/src/logs/secret-matcher.ts";
import { memoryAuditSink } from "../../packages/core/src/rbac/audit.ts";
import {
  argsMatchPattern, buildEnv, createExecTool, DEFAULT_ENV_ALLOW, envFingerprint, ExecFailure, findAllowed, isSecretishName, programKey,
  validateArgs, validateProgram, EXEC_MAX_MAX_OUTPUT_BYTES, EXEC_MAX_OUTPUT_BYTES, EXEC_MAX_TIMEOUT_MS, EXEC_RUN_SCHEMA, EXEC_TIMEOUT_MS,
  type ExecConfig, type ExecDeps,
} from "../../packages/core/src/tools/exec/index.ts";
import { BoundedCapture } from "../../packages/core/src/tools/sandbox/capture.ts";
import { FsFailure, type FsFailureCode } from "../../packages/core/src/tools/fs/failure.ts";
import { DEFAULT_LIMITS, type FsConfig } from "../../packages/core/src/tools/fs/ops.ts";
import { createFsTools, FILE_LIST_SCHEMA, FILE_READ_SCHEMA, FILE_STAT_SCHEMA, FILE_WRITE_SCHEMA, FS_CAPABILITIES } from "../../packages/core/src/tools/fs/tools.ts";
import { FakeClock, MemoryGrants, ctx } from "../../packages/core/test/policy/helpers.ts";
import { FakePort, FakeProcess, FakeTimers } from "../../packages/core/test/tools/exec/helpers.ts";
import { exporterMain } from "./lib.mjs";

export const RECORDED_ON = "darwin";

// --- input notation ---------------------------------------------------------------------------------------------------------

/** Expands `$repeat` and `$fill`, and replaces `$ROOT` in every string when a root is given. */
function expand(v: unknown, root?: string): unknown {
  if (typeof v === "string") return root === undefined ? v : v.replaceAll("$ROOT", root);
  if (Array.isArray(v)) return v.map((x) => expand(x, root));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.$repeat)) return String(o.$repeat[0]).repeat(Number(o.$repeat[1]));
    if (Array.isArray(o.$fill)) return Array.from({ length: Number(o.$fill[1]) }, () => expand(o.$fill[0], root));
    if (Array.isArray(o.parts)) return o.parts.join("");
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expand(x, root)]));
  }
  return v;
}
/** The reverse for outputs: the directory of this run becomes `$ROOT` again. */
function mask(v: unknown, root: string): unknown {
  // A temporary file a write left behind has a random name (K10-D2: see the `races` case).
  if (typeof v === "string") return v.replaceAll(root, "$ROOT").replace(/^\.[^/]*\.[0-9a-f]{12}\.p1tmp$/, "$TMPFILE");
  if (Array.isArray(v)) return v.map((x) => mask(x, root));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mask(x, root)]));
  return v;
}
const failure = (e: unknown): unknown => (e instanceof ExecFailure ? { code: e.code, message: e.message } : { threw: String(e) });
const attempt = <T>(f: () => T): unknown => { try { return { ok: f() }; } catch (e) { return failure(e); } };
const rep = (text: string, n: number) => ({ $repeat: [text, n] });

// --- exec: the pure rules ---------------------------------------------------------------------------------------------------

const PROGRAMS: unknown[] = [
  "git", "/usr/bin/git", "./tool", "C:\\Program Files\\Git\\bin\\git.exe", "", 7, null, ["git"], "a\u0000b", "a\nb", "a\rb", " git", "git ", "\tgit",
  "\u00a0git", "git\ufeff", "\u2028git", "-rf", "--version", "sh", "/bin/bash", "bash", "BASH", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish", "cmd",
  "cmd.exe", "CMD.EXE", "powershell", "PowerShell.exe", "pwsh", "wsl", "wsl.exe", "busybox", "/bin/busybox", "sudo", "doas", "pkexec", "su", "runas",
  "gsudo", "expect", "sshpass", "/usr/bin/sudo", "C:\\x\\run.bat", "a.CMD", "x.bat.", "x.bat . .", "bash.exe.", "bash.exe . .", "zsh.com", "sh.exe.exe",
  "git.bat.exe", "shx", "xsh", "x/sh", "x\\sh", "x\\sh.exe", "sh/", "sh\\", "bash.EXE", "ba\u017fh", "\u017fh", "sub/dir/", "a.batx", "a.cmdlet", "su.do",
  rep("a", 4096), rep("a", 4097), rep("\ud83d\ude00", 2048), rep("\ud83d\ude00", 2049),
];
const ARGS: unknown[] = [
  undefined, null, [], ["status", "-s"], "status -s", { 0: "a" }, [1], ["a", null], ["a\u0000b"], ["; rm -rf /", "$(id)", "`id`", "a && b", "x | y", "*", "'q'", "\n"],
  { $fill: ["a", 256] }, { $fill: ["a", 257] }, [rep("a", 32 * 1024)], [rep("a", 32 * 1024 + 1)], [rep("\u00e9", 16 * 1024)], [rep("\u00e9", 16 * 1024 + 1)],
  { $fill: [rep("a", 1024), 256] }, { $fill: [rep("a", 1025), 256] }, [""], ["", "", ""],
];
const ALLOW_LISTS: unknown[] = [undefined, [], [{ program: "git" }], [{ program: "/usr/bin/git" }, { program: "git", argPattern: "^[a-z]+$" }], [{ program: "Git" }, { program: "git" }]];
const ALLOW_PROGRAMS = ["git", "Git", "GIT", "/usr/bin/git", "/USR/BIN/GIT", "gi", "git "];
// `subset`: the pattern is in the dialect the Rust port accepts (see `exec/pattern.rs`); the others it declines (allows nothing).
const PATTERNS: { pattern: string; subset: boolean }[] = [
  { pattern: "^[a-z]+$", subset: true }, { pattern: "^(status|log|diff)$", subset: true }, { pattern: "^--?[a-z-]+(=.*)?$", subset: true },
  { pattern: "^\\d+$", subset: true }, { pattern: "^\\w+$", subset: true }, { pattern: ".", subset: true }, { pattern: "^.$", subset: true },
  { pattern: "a{2,3}", subset: true }, { pattern: "^a{2}$", subset: true }, { pattern: "^a{2,}$", subset: true }, { pattern: "^[^/]+$", subset: true },
  { pattern: "\\/", subset: true }, { pattern: "^(?:a|b)c*?$", subset: true }, { pattern: "^[\\w.-]+$", subset: true }, { pattern: "^a\\.b$", subset: true },
  { pattern: "^[A-Z\\d]+$", subset: true }, { pattern: "", subset: true }, { pattern: "^\\n$", subset: true }, { pattern: "x|^$", subset: true },
  { pattern: "(?=a)a", subset: false }, { pattern: "\\bgit\\b", subset: false }, { pattern: "(?<n>a)", subset: false }, { pattern: "\\p{L}+", subset: false },
  { pattern: "[[:alpha:]]", subset: false }, { pattern: "(", subset: false }, { pattern: "a{", subset: false }, { pattern: "\\s", subset: false },
  { pattern: "[a&&b]", subset: false }, { pattern: "[]", subset: false }, { pattern: "[^]", subset: false }, { pattern: "\u00e9+", subset: false },
  { pattern: "\\1", subset: false }, { pattern: "(?i)a", subset: false }, { pattern: "a**", subset: false }, { pattern: "[a-]", subset: true }, { pattern: "^*a", subset: false }, { pattern: "*a", subset: false }, { pattern: "a|*", subset: false }, { pattern: "[\\d-z]", subset: false }, { pattern: "[a-\\d]", subset: false }, { pattern: "a+?", subset: true }, { pattern: "a??b", subset: true }, { pattern: "a+??", subset: false }, { pattern: "^[-a]$", subset: true },
  { pattern: "\\D", subset: false }, { pattern: "\\u0041", subset: false }, { pattern: "^[a--b]$", subset: false }, { pattern: "a{2,1}", subset: false },
];
const PATTERN_ARGS: string[][] = [
  [], ["status"], ["status", "log"], ["Status"], ["12"], ["\u0661\u0662"], ["\u00e9"], ["a_b9"], ["\r"], ["\n"], ["\u2028"], ["\u2029"], [""], ["aa"], ["aaa"],
  ["aaaa"], ["a/b"], ["--opt=a b"], ["-x"], ["a.b"], ["axb"], ["ac"], ["bcc"], ["git"], ["a"], ["A1"], ["\ud83d\ude00"], ["a-"], ["x"],
];

type EnvCase = { allow?: string[]; base: [string, string | null][]; requested?: [string, unknown][] | null; windows: boolean };
const BASE_ENV: [string, string | null][] = [
  ["PATH", "/usr/bin"], ["HOME", "/home/x"], ["LANG", "C.UTF-8"], ["TZ", "UTC"], ["TERM", "xterm"], ["API_TOKEN", "t-value"], ["AWS_SECRET_ACCESS_KEY", "k"],
  ["EDITOR", "vi"], ["UNSET", null],
];
const SECRETISH_NAMES = [
  "TOKEN", "API_TOKEN", "token", "MY_SECRET", "secrets", "PASSWORD", "DB_PASSWD", "CREDENTIALS", "credential_file", "API_KEY", "API-KEY", "APIKEY", "apikey",
  "PRIVATE_KEY", "PRIVATE-KEY", "PRIVATEKEY", "KEY", "SSH_KEY", "KEYS", "KEYBOARD", "MONKEY", "MON_KEY", "KEY_FILE", "AUTH", "AUTHOR", "OAUTH_URL", "COOKIE",
  "COOKIES_DIR", "SESSION", "SESSION_ID", "TMUX_SESSION", "PATH", "HOME", "LANG", "EDITOR", "KEYX", "_KEY", "A_KEY_B", "PASS", "PWD", "AUTHORIZATION",
  "API_KEY_FILE", "X_API_KEY_2", "PRIVATE_KEY_PATH", "MY_PRIVATE_KEY_PEM", "API-KEY-FILE", "PRIVATE-KEY-PATH", "APIKEYS", "PRIVATEKEYS", "API__KEY", "API KEY", "KEY_", "TOKENS", "x-token-y",
];
const ENV_CASES: EnvCase[] = [
  { base: BASE_ENV, windows: false },
  { base: BASE_ENV, requested: [["LANG", "de_DE.UTF-8"], ["TZ", "Europe/Berlin"]], windows: false },
  { base: BASE_ENV, requested: [["HOME", "/tmp"]], windows: false },
  { base: BASE_ENV, requested: [["BAD NAME", "x"]], windows: false }, { base: BASE_ENV, requested: [["1X", "x"]], windows: false },
  { base: BASE_ENV, requested: [["A=B", "x"]], windows: false }, { base: BASE_ENV, requested: [["", "x"]], windows: false },
  { base: BASE_ENV, requested: [["LANG", "a\u0000b"]], windows: false }, { base: BASE_ENV, requested: [["LANG", 7]], windows: false },
  { base: BASE_ENV, requested: [["LANG", null]], windows: false }, { base: BASE_ENV, requested: [["LANG", ""]], windows: false },
  { base: BASE_ENV, requested: null, windows: false },
  { allow: ["API_TOKEN", "EDITOR", "HOME"], base: BASE_ENV, windows: false },
  { allow: ["API_TOKEN", "EDITOR"], base: BASE_ENV, requested: [["API_TOKEN", "explicit-value"]], windows: false },
  { allow: [], base: BASE_ENV, windows: false }, { allow: [], base: BASE_ENV, requested: [["PATH", "/x"]], windows: false },
  { allow: ["path", "Lang"], base: BASE_ENV, windows: false }, { allow: ["path", "Lang"], base: BASE_ENV, windows: true },
  { base: [["Path", "C:\\Windows"], ["SystemRoot", "C:\\Windows"], ["systemroot", "c:\\other"], ["ComSpec", "C:\\Windows\\cmd.exe"], ["Api_Key", "k"], ["temp", "C:\\T"]], windows: true },
  { base: [["Path", "C:\\Windows"]], requested: [["PATH", "C:\\Tools"]], windows: true }, { base: [["Path", "C:\\Windows"]], requested: [["path", "C:\\Tools"], ["Path", "C:\\Last"]], windows: true },
  { base: [["Path", "C:\\Windows"]], requested: [["PATH", "C:\\Tools"]], windows: false },
  { base: [["PATH", "/a"], ["LC_ALL", "C"], ["LC_CTYPE", "C"], ["TEMP", "/t"], ["TMP", "/t"], ["PATHEXT", ".EXE"], ["COMSPEC", "c"], ["SYSTEMROOT", "r"]], windows: false },
];

type CaptureCase = { limit: number; chunks: string[]; secrets?: { parts: string[] }[]; complete?: boolean };
const b64 = (s: string | number[]) => Buffer.from(s as never).toString("base64");
const SECRET = { parts: ["plain", "-marker-", "value"] };
const CAPTURE_CASES: CaptureCase[] = [
  { limit: 10, chunks: [] }, { limit: 10, chunks: [b64("hello")] }, { limit: 10, chunks: [b64("0123456789")] }, { limit: 10, chunks: [b64("0123456789a")] },
  { limit: 10, chunks: [b64("01234"), b64("56789"), b64("abc")] }, { limit: 4, chunks: [b64("a\u00e9\u00e9")] }, { limit: 3, chunks: [b64("\u20ac\u20ac")] },
  { limit: 5, chunks: [b64("\ud83d\ude00\ud83d\ude00")] }, { limit: 8, chunks: [b64([0xff, 0xfe, 0x61, 0x80])] }, { limit: 2, chunks: [b64([0xe2, 0x82]), b64([0xac])] },
  { limit: 1, chunks: [b64([0xff])] }, { limit: 2, chunks: [b64([0xff])] }, { limit: 3, chunks: [b64([0xff])] }, { limit: 5, chunks: [b64([0x61, 0xf0, 0x9f, 0x98])] },
  { limit: 64, chunks: [b64("before plain-marker-value after")], secrets: [SECRET] },
  { limit: 64, chunks: [b64("before plain-mar"), b64("ker-value after")], secrets: [SECRET] },
  { limit: 20, chunks: [b64("before plain-marker-value after")], secrets: [SECRET] },
  { limit: 64, chunks: [b64("before plain-marker-val")], secrets: [SECRET], complete: false },
  { limit: 12, chunks: [b64("plain-marker-value")], secrets: [SECRET] }, { limit: 64, chunks: [b64("no secret here")], secrets: [SECRET] },
  { limit: 8, chunks: [b64("0123456789"), b64("plain-marker-value")], secrets: [SECRET] },
];

function buildExecRules() {
  return {
    constants: { timeoutMs: EXEC_TIMEOUT_MS, maxTimeoutMs: EXEC_MAX_TIMEOUT_MS, maxOutputBytes: EXEC_MAX_OUTPUT_BYTES, maxMaxOutputBytes: EXEC_MAX_MAX_OUTPUT_BYTES, defaultEnvAllow: DEFAULT_ENV_ALLOW, schema: EXEC_RUN_SCHEMA },
    programs: PROGRAMS.map((input) => { const p = expand(input); return { input: input === undefined ? null : input, result: attempt(() => validateProgram(p)), ...(typeof p === "string" ? { key: programKey(p) } : {}) }; }),
    args: ARGS.map((input) => {
      const r = attempt(() => validateArgs(expand(input))) as { ok?: string[] };
      // The accepted list is the input: its size and a hash stand for it.
      return { absent: input === undefined, input: input === undefined ? null : input, result: r.ok ? { ok: { count: r.ok.length, sha256: createHash("sha256").update(JSON.stringify(r.ok)).digest("hex") } } : r };
    }),
    allow: ALLOW_LISTS.flatMap((list, li) => ALLOW_PROGRAMS.flatMap((program) => [false, true].map((windows) => {
      const e = findAllowed(list as never, program, windows);
      return { list: li, program, windows, found: e === undefined ? null : (list as unknown[]).indexOf(e) };
    }))),
    allowLists: ALLOW_LISTS.map((l) => l ?? null),
    patterns: PATTERNS.map(({ pattern, subset }) => ({ pattern, subset, matches: PATTERN_ARGS.map((args) => argsMatchPattern({ program: "x", argPattern: pattern }, args)) })),
    patternArgs: PATTERN_ARGS,
    noPattern: argsMatchPattern({ program: "x" }, ["anything", "\n"]),
    secretish: SECRETISH_NAMES.map((name) => ({ name, secretish: isSecretishName(name) })),
    env: ENV_CASES.map((c) => {
      const base = Object.fromEntries(c.base.map(([k, v]) => [k, v === null ? undefined : v]));
      const requested = c.requested === undefined ? undefined : c.requested === null ? undefined : (Object.fromEntries(c.requested) as Record<string, string>);
      const r = attempt(() => buildEnv({ allow: c.allow ?? DEFAULT_ENV_ALLOW, base, requested, windows: c.windows })) as { ok?: Record<string, string> };
      return { allow: c.allow ?? null, base: c.base, requested: c.requested ?? null, windows: c.windows, result: r.ok ? { ok: Object.entries(r.ok), fingerprint: envFingerprint(r.ok) } : r };
    }),
    capture: CAPTURE_CASES.map((c) => {
      const forms = (c.secrets ?? []).map((s) => s.parts.join(""));
      const snapshot = { forms, matcher: createSecretMatcher(forms) };
      const cap = new BoundedCapture(c.limit, c.secrets ? () => snapshot : undefined);
      for (const chunk of c.chunks) cap.push(Buffer.from(chunk, "base64"));
      const text = cap.text(c.complete ?? true);
      return { ...c, text, truncated: cap.truncated };
    }),
  };
}

// --- exec: runs against the fake process port -------------------------------------------------------------------------------

type Ev = { out: string } | { outB64: string } | { err: string } | { advance: number } | { exit: number } | { abort: true } | { fail: string };
type Run = {
  name: string; config?: Record<string, unknown>; args: unknown; baseEnv?: [string, string][]; platform?: string;
  /** What the gate classified: `live` (default) is this call's own cwd and environment; an object replaces a part. */
  classified?: "live" | "none" | { target?: string; hashExtra?: string };
  script?: Ev[]; aborted?: boolean; spawnThrows?: string; auditFails?: string[]; tree?: { file: string }[];
};
const CWD = "$ROOT/work";
const RUNS: Run[] = [
  { name: "runs-and-exits", args: { program: "git", args: ["status", "-s"], cwd: CWD }, script: [{ out: "M a\n" }, { err: "warn\n" }, { advance: 12 }, { exit: 0 }] },
  { name: "exit-code", args: { program: "git", cwd: CWD }, script: [{ exit: 3 }] },
  { name: "deny-is-the-default", config: { mode: "deny" }, args: { program: "git", args: ["status"], cwd: CWD } },
  { name: "unknown-mode", config: { mode: "yolo" }, args: { program: "git", cwd: CWD } },
  { name: "mode-absent", config: { mode: null }, args: { program: "git", cwd: CWD } },
  { name: "shell-refused", config: { allowlist: [{ program: "sh" }] }, args: { program: "sh", args: ["-c", "id"], cwd: CWD } },
  { name: "escalator-refused", config: { mode: "ask" }, args: { program: "/usr/bin/sudo", args: ["id"], cwd: CWD } },
  { name: "batch-refused", args: { program: "C:\\x\\run.bat", cwd: CWD } }, { name: "dash-program", args: { program: "-rf", cwd: CWD } },
  { name: "empty-program", args: { program: "", cwd: CWD } }, { name: "program-not-string", args: { program: 7, cwd: CWD } },
  { name: "metacharacters-are-literal", args: { program: "git", args: ["; rm -rf /", "$(id)", "`id`", "a && b", "x | y", "--opt=a b", "*", "'q'", "\"d\"", "\n"], cwd: CWD }, script: [{ exit: 0 }] },
  { name: "nul-in-argument", args: { program: "git", args: ["a\u0000b"], cwd: CWD } }, { name: "argument-not-string", args: { program: "git", args: [1], cwd: CWD } },
  { name: "args-not-array", args: { program: "git", args: "status -s", cwd: CWD } },
  { name: "not-allowlisted", args: { program: "ls", cwd: CWD } }, { name: "path-spelling-of-bare-entry", args: { program: "/usr/bin/git", cwd: CWD } },
  { name: "pattern-refuses", config: { allowlist: [{ program: "git", argPattern: "^(status|log)$" }] }, args: { program: "git", args: ["status", "push"], cwd: CWD } },
  { name: "pattern-allows", config: { allowlist: [{ program: "git", argPattern: "^(status|log)$" }] }, args: { program: "git", args: ["status", "log"], cwd: CWD }, script: [{ exit: 0 }] },
  { name: "ask-tier-ignores-allowlist", config: { mode: "ask", allowlist: [] }, args: { program: "ls", args: ["-la"], cwd: CWD }, script: [{ exit: 0 }] },
  { name: "cwd-outside-root", args: { program: "git", cwd: "$ROOT/../" } }, { name: "cwd-missing", args: { program: "git", cwd: "$ROOT/work/none" } },
  { name: "cwd-is-a-file", tree: [{ file: "work/f.txt" }], args: { program: "git", cwd: "$ROOT/work/f.txt" } }, { name: "cwd-not-string", args: { program: "git", cwd: 5 } },
  { name: "cwd-relative", args: { program: "git", cwd: "work" } }, { name: "cwd-deny-listed", config: { deny: [{ path: "$ROOT/work" }] }, args: { program: "git", cwd: CWD } },
  { name: "cwd-is-the-root", args: { program: "git", cwd: "$ROOT" }, script: [{ exit: 0 }] },
  { name: "env-only-allowlisted", args: { program: "git", cwd: CWD }, script: [{ exit: 0 }] },
  { name: "env-requested", args: { program: "git", cwd: CWD, env: { LANG: "de_DE.UTF-8" } }, script: [{ exit: 0 }] },
  { name: "env-not-allowlisted", args: { program: "git", cwd: CWD, env: { HOME: "/tmp" } } }, { name: "env-bad-value", args: { program: "git", cwd: CWD, env: { LANG: "a\u0000b" } } },
  { name: "env-steering-path", args: { program: "git", cwd: CWD, env: { PATH: "/tmp/evil" } } }, { name: "env-steering-lower", config: { envAllow: ["path", "LANG"] }, args: { program: "git", cwd: CWD, env: { path: "/tmp/evil" } } },
  { name: "env-path-in-ask-tier", config: { mode: "ask" }, args: { program: "git", cwd: CWD, env: { PATH: "/opt/bin" } }, script: [{ exit: 0 }] },
  { name: "env-secret-requested", config: { envAllow: ["API_TOKEN", "PATH"] }, args: { program: "git", cwd: CWD, env: { API_TOKEN: "explicit-value" } }, script: [{ exit: 0 }] },
  { name: "timeout-kills-the-tree", args: { program: "git", cwd: CWD, timeoutMs: 50 }, script: [{ out: "partial" }, { advance: 49 }, { advance: 1 }] },
  { name: "timeout-clamped", config: { maxTimeoutMs: 100 }, args: { program: "git", cwd: CWD, timeoutMs: 5000 }, script: [{ advance: 99 }, { exit: 0 }] },
  { name: "timeout-default", config: { defaultTimeoutMs: 70 }, args: { program: "git", cwd: CWD }, script: [{ advance: 70 }] },
  { name: "timeout-invalid", args: { program: "git", cwd: CWD, timeoutMs: 0 } }, { name: "timeout-fraction", args: { program: "git", cwd: CWD, timeoutMs: 1.5 } },
  { name: "timeout-string", args: { program: "git", cwd: CWD, timeoutMs: "5" } }, { name: "max-output-invalid", args: { program: "git", cwd: CWD, maxOutputBytes: -1 } },
  { name: "abort-ends-the-tree", args: { program: "git", cwd: CWD }, script: [{ out: "x" }, { advance: 5 }, { abort: true }] },
  { name: "aborted-before-start", args: { program: "git", cwd: CWD }, aborted: true },
  { name: "spawn-throws", args: { program: "git", cwd: CWD }, spawnThrows: "spawn git ENOENT" },
  { name: "wait-rejects", args: { program: "git", cwd: CWD }, script: [{ out: "x" }, { fail: "spawn git EACCES" }] },
  { name: "output-limit", args: { program: "git", cwd: CWD, maxOutputBytes: 8 }, script: [{ out: "0123456789" }, { err: "abcdefgh" }, { err: "i" }, { exit: 0 }] },
  { name: "output-limit-clamped", config: { maxMaxOutputBytes: 4 }, args: { program: "git", cwd: CWD, maxOutputBytes: 100 }, script: [{ out: "0123456789" }, { exit: 0 }] },
  { name: "output-cut-in-a-character", args: { program: "git", cwd: CWD, maxOutputBytes: 4 }, script: [{ out: "a\u20ac\u20ac" }, { exit: 0 }] },
  { name: "output-invalid-utf8", args: { program: "git", cwd: CWD }, script: [{ outB64: b64([0x61, 0xff, 0x62]) }, { exit: 0 }] },
  { name: "audit-fails-before-spawn", args: { program: "git", cwd: CWD }, auditFails: ["exec.run"], script: [{ exit: 0 }] },
  { name: "audit-fails-on-refusal", config: { mode: "deny" }, args: { program: "git", cwd: CWD }, auditFails: ["exec.refused"] },
  { name: "audit-fails-on-result", args: { program: "git", cwd: CWD }, auditFails: ["exec.result"], script: [{ exit: 0 }] },
  { name: "classified-other-cwd", args: { program: "git", cwd: CWD }, classified: { target: "$ROOT" } },
  { name: "classified-other-env", args: { program: "git", cwd: CWD }, classified: { hashExtra: "0".repeat(64) } },
  { name: "unknown-argument", args: { program: "git", cwd: CWD, shell: true } }, { name: "arguments-not-object", args: ["git"] }, { name: "arguments-null", args: null },
  { name: "env-not-object", args: { program: "git", cwd: CWD, env: ["A=B"] } }, { name: "env-null", args: { program: "git", cwd: CWD, env: null } },
  { name: "windows-trailing-dots", platform: "win32", args: { program: "bash.exe.", cwd: CWD } }, { name: "windows-batch-with-dot", platform: "win32", args: { program: "x.bat.", cwd: CWD } },
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function freshRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "work"));
  return root;
}

async function execRunCase(k: Run) {
  const root = freshRoot("p4k-exec-");
  try {
    for (const t of k.tree ?? []) writeFileSync(join(root, t.file), "x");
    const args = expand(k.args, root);
    const audit = memoryAuditSink();
    const failing = new Set(k.auditFails ?? []);
    const timers = new FakeTimers();
    const port = new FakePort();
    const controller = new AbortController();
    if (k.aborted) controller.abort();
    const baseEnv = Object.fromEntries(k.baseEnv ?? [["PATH", "/usr/bin"], ["HOME", "/home/x"], ["LANG", "C"], ["API_TOKEN", "t-value"], ["AWS_SECRET_ACCESS_KEY", "k"]]);
    const config = { mode: "allowlist", roots: [{ id: "r", path: root }], allowlist: [{ program: "git" }], ...(expand(k.config ?? {}, root) as object) } as ExecConfig;
    if ((config as { mode: unknown }).mode === null) delete (config as { mode?: unknown }).mode;
    const platform = (k.platform ?? process.platform) as NodeJS.Platform;
    const deps: ExecDeps = {
      config, timers, baseEnv, platform, host: "h1",
      process: { spawn: (spec) => { if (k.spawnThrows !== undefined) throw new Error(k.spawnThrows); return port.spawn(spec); } },
      audit: { append: (e) => { if (failing.has(e.action)) throw new Error("audit sink failed"); audit.append(e); } },
      policy: { grants: new MemoryGrants([]), clock: new FakeClock() },
      policyContext: ctx({ overrides: { "shell.exec": "allowed" } }),
    };
    port.onSpawn = (p: FakeProcess) => {
      for (const ev of k.script ?? []) {
        if ("out" in ev) p.stdout(ev.out); else if ("outB64" in ev) p.stdout(Buffer.from(ev.outB64, "base64")); else if ("err" in ev) p.stderr(ev.err);
        else if ("advance" in ev) timers.advance(ev.advance); else if ("exit" in ev) p.exit(ev.exit); else if ("abort" in ev) controller.abort(); else p.fail(new Error(ev.fail));
      }
    };
    // What the gate classified for this call (`classifyExecRun` of the composition), computed leniently: a call the
    // classifier would refuse is given to the executor anyway, so that its own refusals are recorded.
    let classified: { targets?: string[]; hashExtra?: string } | undefined;
    if (k.classified !== "none") {
      const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as { cwd?: unknown; env?: unknown };
      let target: string | undefined; let hashExtra: string | undefined;
      try { target = realpathSync.native(String(a.cwd)); } catch { /* unresolvable: no target */ }
      try { hashExtra = envFingerprint(buildEnv({ allow: config.envAllow ?? DEFAULT_ENV_ALLOW, base: baseEnv, requested: a.env as never, windows: platform === "win32" })); } catch { /* refused: no fingerprint */ }
      if (typeof k.classified === "object") { target = k.classified.target !== undefined ? expand(k.classified.target, root) as string : target; hashExtra = k.classified.hashExtra ?? hashExtra; }
      classified = { ...(target !== undefined ? { targets: [target] } : {}), ...(hashExtra !== undefined ? { hashExtra } : {}) };
    }
    let outcome: unknown;
    try { outcome = await createExecTool(deps).execute(args, { signal: controller.signal, ...(classified ? { classified } : {}) }); } catch (e) { outcome = { threw: String(e) }; }
    // The action hash depends on the directory: record its preimage with `$ROOT`, after checking it against the recorded hash.
    let hashPreimage: string | undefined;
    const withHash = audit.events.find((e) => typeof e.detail.actionHash === "string");
    const spec = port.spawned[0]?.spec;
    if (withHash && spec) {
      const pre = JSON.stringify({ c: "shell.exec", t: "exec.run", program: spec.program, args: spec.args, cwd: spec.cwd, env: Object.keys(spec.env).sort().map((n) => [n, spec.env[n]]) });
      if (sha(pre) !== withHash.detail.actionHash) throw new Error(`${k.name}: the action hash preimage is not what exec.run hashed`);
      hashPreimage = pre.replaceAll(root, "$ROOT");
    }
    const hashOf = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? "$HASH" : v);
    return mask({
      name: k.name, config: k.config ?? {}, args: k.args === undefined ? null : k.args, platform, baseEnv: Object.entries(baseEnv), classified: k.classified ?? "live",
      script: k.script ?? [], aborted: k.aborted ?? false, spawnThrows: k.spawnThrows ?? null, auditFails: k.auditFails ?? [], tree: k.tree ?? [],
      outcome, hashPreimage: hashPreimage ?? null,
      audit: audit.events.map((e) => ({ at: e.at, user: e.actor.user, host: e.actor.host, action: e.action, target: e.target, detail: Object.entries(e.detail).map(([n, v]) => [n, n === "actionHash" ? hashOf(v) : v]) })),
      spawned: port.spawned.map((p) => ({ program: p.spec.program, args: p.spec.args, cwd: p.spec.cwd, env: Object.entries(p.spec.env), kills: p.kills })),
    }, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// --- fs: differential cases against real files -------------------------------------------------------------------------------

type Op =
  | { mkdir: string } | { file: string; text?: string; b64?: string } | { symlink: string; target: string } | { link: string; to: string } | { fifo: string }
  | { rm: string } | { rename: string; to: string } | { chmod: string; mode: number } | { mtime: string; ms: number };
type FsStep =
  | { tool: "file.stat" | "file.list" | "file.read" | "file.write"; args: unknown; afterCheck?: Op[]; secrets?: { parts: string[] }[] }
  | { fs: Op[] } | { peek: string };
type FsCase = { name: string; tree?: Op[]; config?: { deny?: unknown; limits?: Record<string, number>; cwd?: string }; steps: FsStep[]; divergence?: string };
const FS_BASE: Op[] = [
  { mkdir: "root/sub" }, { mkdir: "outside" }, { file: "root/file.txt", text: "inside\n" }, { file: "root/sub/deep.txt", text: "deep" },
  { file: "outside/secret.txt", text: "outside-secret" }, { mtime: "root/file.txt", ms: 1_790_000_000_500 }, { mtime: "root/sub", ms: 1_790_000_100_000 },
];
const t = (tool: string, args: unknown, extra: Record<string, unknown> = {}): FsStep => ({ tool, args, ...extra } as FsStep);
const R = "$ROOT/root";
const FS_CASES: FsCase[] = [
  { name: "stat", tree: [{ symlink: "root/to-file", target: "$ROOT/root/sub/deep.txt" }, { symlink: "root/out", target: "$ROOT/outside/secret.txt" },
    { mtime: "root/sub/deep.txt", ms: 1_600_000_000_000 }, { mtime: "root/sub", ms: 1_790_000_100_000 }, { mtime: "root", ms: 1_700_000_000_250 }], steps: [
    t("file.stat", { path: `${R}/file.txt` }), t("file.stat", { path: `${R}/sub` }), t("file.stat", { path: "sub/deep.txt" }), t("file.stat", { path: `${R}/none` }),
    t("file.stat", { path: `${R}` }), t("file.stat", { path: `${R}/to-file` }), t("file.stat", { path: `${R}/out` }), t("file.stat", { path: "$ROOT/outside/secret.txt" }),
    t("file.stat", { path: 7 }), t("file.stat", {}), t("file.stat", { path: `${R}/file.txt`, follow: true }), t("file.stat", null), t("file.stat", ["x"]), t("file.stat", { path: "" }),
    t("file.stat", { path: `${R}/file.txt/x` }), t("file.stat", { path: `${R}/a\u0000b` }),
  ] },
  { name: "list", tree: [{ file: "root/b.txt", text: "bb" }, { file: "root/A.txt", text: "a" }, { symlink: "root/link", target: "$ROOT/outside" }, { mkdir: "root/.ssh" }, { file: "root/.env", text: "K=V" }, { fifo: "root/pipe" }],
    config: { deny: [{ name: ".env" }, { path: "$ROOT/root/.ssh" }] }, steps: [
    t("file.list", { path: R }), t("file.list", { path: R, maxEntries: 2 }), t("file.list", { path: R, maxEntries: 1000 }), t("file.list", { path: R, maxEntries: 0 }),
    t("file.list", { path: R, maxEntries: 1001 }), t("file.list", { path: R, maxEntries: 1.5 }), t("file.list", { path: R, maxEntries: "3" }), t("file.list", { path: `${R}/file.txt` }),
    t("file.list", { path: `${R}/none` }), t("file.list", { path: `${R}/sub` }), t("file.list", { path: `${R}/link` }), t("file.list", { path: `${R}/.ssh` }), t("file.list", { path: "$ROOT/outside" }),
  ] },
  { name: "list-limit", config: { limits: { maxListEntries: 2 } }, steps: [t("file.list", { path: R }), t("file.list", { path: R, maxEntries: 3 }), t("file.list", { path: R, maxEntries: 1 })] },
  { name: "read-text", tree: [{ file: "root/empty", text: "" }, { file: "root/uni.txt", text: "a\u20acb\ud83d\ude00c" }, { file: "root/bom.txt", b64: b64([0xef, 0xbb, 0xbf, 0x68, 0x69]) }, { file: "root/quotes.txt", text: "\"\n\\\t\u0001" }], steps: [
    t("file.read", { path: `${R}/file.txt` }), t("file.read", { path: `${R}/empty` }), t("file.read", { path: `${R}/file.txt`, encoding: "utf8" }), t("file.read", { path: `${R}/file.txt`, encoding: "base64" }),
    t("file.read", { path: `${R}/file.txt`, encoding: "latin1" }), t("file.read", { path: `${R}/file.txt`, offset: 2 }), t("file.read", { path: `${R}/file.txt`, offset: 2, length: 3 }),
    t("file.read", { path: `${R}/file.txt`, offset: 7 }), t("file.read", { path: `${R}/file.txt`, offset: 99 }), t("file.read", { path: `${R}/file.txt`, offset: 99, length: 4 }),
    t("file.read", { path: `${R}/file.txt`, length: 0 }), t("file.read", { path: `${R}/file.txt`, offset: -1 }), t("file.read", { path: `${R}/file.txt`, offset: 1.5 }),
    t("file.read", { path: `${R}/file.txt`, length: 1048577 }), t("file.read", { path: `${R}/file.txt`, length: 1048576 }), t("file.read", { path: `${R}/file.txt`, offset: 9007199254740992 }),
    t("file.read", { path: `${R}/uni.txt` }), t("file.read", { path: `${R}/uni.txt`, length: 2 }), t("file.read", { path: `${R}/uni.txt`, length: 3 }), t("file.read", { path: `${R}/uni.txt`, length: 4 }),
    t("file.read", { path: `${R}/uni.txt`, offset: 2 }), t("file.read", { path: `${R}/uni.txt`, offset: 2, encoding: "base64" }), t("file.read", { path: `${R}/uni.txt`, offset: 5, length: 3 }),
    t("file.read", { path: `${R}/uni.txt`, offset: 5, length: 4 }), t("file.read", { path: `${R}/uni.txt`, offset: 1, length: 3 }), t("file.read", { path: `${R}/bom.txt` }), t("file.read", { path: `${R}/quotes.txt` }),
    t("file.read", { path: `${R}/sub` }), t("file.read", { path: `${R}/none` }), t("file.read", { path: "$ROOT/outside/secret.txt" }), t("file.read", { path: `${R}/file.txt`, extra: 1 }),
  ] },
  { name: "read-binary", tree: [{ file: "root/nul.bin", b64: b64([0x61, 0x00, 0x62]) }, { file: "root/bad.bin", b64: b64([0x61, 0xff, 0x62]) }, { file: "root/cut.bin", b64: b64([0x61, 0xe2, 0x82]) }, { fifo: "root/pipe" }], steps: [
    t("file.read", { path: `${R}/nul.bin` }), t("file.read", { path: `${R}/nul.bin`, encoding: "base64" }), t("file.read", { path: `${R}/bad.bin` }), t("file.read", { path: `${R}/bad.bin`, encoding: "utf8" }),
    t("file.read", { path: `${R}/bad.bin`, length: 1 }), t("file.read", { path: `${R}/cut.bin` }), t("file.read", { path: `${R}/cut.bin`, length: 2 }), t("file.read", { path: `${R}/cut.bin`, encoding: "base64" }),
    t("file.read", { path: `${R}/pipe` }),
  ], divergence: "K2-D6" },
  { name: "read-limits", tree: [{ file: "root/big.txt", text: "0123456789abcdef" }, { file: "root/esc.txt", text: "\n\n\n\n\n\n\n\n" }], config: { limits: { maxReadBytes: 8, maxResultBytes: 105 } }, steps: [
    t("file.read", { path: `${R}/big.txt` }), t("file.read", { path: `${R}/big.txt`, length: 8 }), t("file.read", { path: `${R}/big.txt`, length: 9 }), t("file.read", { path: `${R}/big.txt`, offset: 8 }),
    t("file.read", { path: `${R}/big.txt`, offset: 9 }), t("file.read", { path: `${R}/esc.txt` }), t("file.read", { path: `${R}/esc.txt`, encoding: "base64" }), t("file.read", { path: `${R}/file.txt` }),
  ] },
  { name: "read-secrets", tree: [{ file: "root/s.txt", text: "before plain-marker-value after" }], steps: [
    t("file.read", { path: `${R}/s.txt` }, { secrets: [SECRET] }), t("file.read", { path: `${R}/s.txt`, encoding: "base64" }, { secrets: [SECRET] }),
    t("file.read", { path: `${R}/s.txt`, offset: 10, length: 6 }, { secrets: [SECRET] }), t("file.read", { path: `${R}/s.txt`, offset: 26 }, { secrets: [SECRET] }),
    t("file.read", { path: `${R}/file.txt` }, { secrets: [SECRET] }),
  ] },
  { name: "write-create", steps: [
    t("file.write", { path: `${R}/new.txt`, content: "hello\n" }), { peek: "root/new.txt" }, t("file.write", { path: `${R}/new.txt`, content: "again" }), { peek: "root/new.txt" },
    t("file.write", { path: `${R}/new.txt`, content: "replaced", overwrite: true }), { peek: "root/new.txt" }, t("file.write", { path: "sub/rel.txt", content: "" }), { peek: "root/sub/rel.txt" },
    t("file.write", { path: `${R}/b64.bin`, content: b64([0x00, 0xff, 0x10]), encoding: "base64" }), { peek: "root/b64.bin" }, t("file.write", { path: `${R}/uni.txt`, content: "\u20ac\ud83d\ude00" }), { peek: "root/uni.txt" },
    t("file.list", { path: R }),
  ] },
  { name: "write-keeps-the-mode", tree: [{ file: "root/m.txt", text: "old" }, { chmod: "root/m.txt", mode: 0o640 }], steps: [
    t("file.write", { path: `${R}/m.txt`, content: "new", overwrite: true }), { peek: "root/m.txt" }, t("file.write", { path: `${R}/fresh.txt`, content: "x", overwrite: true }), { peek: "root/fresh.txt" },
  ] },
  { name: "write-refusals", tree: [{ link: "root/hard.txt", to: "outside/secret.txt" }, { symlink: "root/to-out", target: "$ROOT/outside/secret.txt" }, { symlink: "root/to-in", target: "$ROOT/root/sub/deep.txt" }, { file: "root/.env", text: "K" }],
    config: { deny: [{ name: ".env" }], limits: { maxWriteBytes: 8 } }, steps: [
    t("file.write", { path: `${R}/x.txt`, content: 7 }), t("file.write", { path: `${R}/x.txt` }), t("file.write", { path: `${R}/x.txt`, content: "a", overwrite: "yes" }),
    t("file.write", { path: `${R}/x.txt`, content: "a", encoding: "hex" }), t("file.write", { path: `${R}/x.txt`, content: "not base64!", encoding: "base64" }),
    t("file.write", { path: `${R}/x.txt`, content: "YQ=", encoding: "base64" }), { peek: "root/x.txt" }, t("file.write", { path: `${R}/y.txt`, content: "YQ===", encoding: "base64" }),
    t("file.write", { path: `${R}/big.txt`, content: "123456789" }), t("file.write", { path: `${R}/big.txt`, content: "12345678" }), t("file.write", { path: `${R}/huge.txt`, content: rep("a", 17) }),
    t("file.write", { path: `${R}/e.txt`, content: "\u20ac\u20ac\u20ac" }), t("file.write", { path: `${R}/sub`, content: "x", overwrite: true }), t("file.write", { path: `${R}/sub`, content: "x" }),
    t("file.write", { path: `${R}/none/x.txt`, content: "x" }), t("file.write", { path: `${R}/hard.txt`, content: "x", overwrite: true }), { peek: "outside/secret.txt" },
    t("file.write", { path: `${R}/to-out`, content: "x", overwrite: true }), { peek: "outside/secret.txt" }, t("file.write", { path: `${R}/to-in`, content: "via", overwrite: true }), { peek: "root/sub/deep.txt" },
    t("file.write", { path: `${R}/.env`, content: "x", overwrite: true }), { peek: "root/.env" }, t("file.write", { path: "$ROOT/outside/n.txt", content: "x" }), t("file.write", { path: `${R}/x.txt`, content: "a", mode: 511 }),
    t("file.write", { path: 5, content: "a" }), t("file.list", { path: R }),
  ] },
  { name: "races", tree: [{ file: "root/r.txt", text: "first" }, { file: "root/w.txt", text: "old" }], steps: [
    t("file.read", { path: `${R}/r.txt` }, { afterCheck: [{ rm: "root/r.txt" }, { symlink: "root/r.txt", target: "$ROOT/outside/secret.txt" }] }),
    { fs: [{ rm: "root/r.txt" }, { file: "root/r.txt", text: "first" }] },
    t("file.read", { path: `${R}/r.txt` }, { afterCheck: [{ rm: "root/r.txt" }, { file: "root/r.txt", text: "other" }] }),
    t("file.read", { path: `${R}/r.txt` }, { afterCheck: [{ rm: "root/r.txt" }] }),
    t("file.write", { path: `${R}/w.txt`, content: "new", overwrite: true }, { afterCheck: [{ rm: "root/w.txt" }, { file: "root/w.txt", text: "swapped" }] }), { peek: "root/w.txt" },
    t("file.write", { path: `${R}/w.txt`, content: "new", overwrite: true }, { afterCheck: [{ rm: "root/w.txt" }, { symlink: "root/w.txt", target: "$ROOT/outside/secret.txt" }] }), { peek: "outside/secret.txt" },
    { fs: [{ rm: "root/w.txt" }] },
    t("file.write", { path: `${R}/w.txt`, content: "new" }, { afterCheck: [{ file: "root/w.txt", text: "appeared" }] }), { peek: "root/w.txt" },
    t("file.write", { path: `${R}/sub/n.txt`, content: "new" }, { afterCheck: [{ rename: "root/sub", to: "root/sub.old" }, { symlink: "root/sub", target: "$ROOT/outside" }] }),
    { peek: "outside/n.txt" }, t("file.list", { path: "$ROOT/root/sub.old" }),
  ], divergence: "K10-D2" },
];

function applyOps(ops: Op[], root: string): void {
  for (const op of ops) {
    const at = (rel: string) => join(root, rel);
    if ("mkdir" in op) mkdirSync(at(op.mkdir), { recursive: true });
    else if ("file" in op) { mkdirSync(dirname(at(op.file)), { recursive: true }); writeFileSync(at(op.file), op.b64 !== undefined ? Buffer.from(op.b64, "base64") : op.text ?? ""); }
    else if ("symlink" in op) symlinkSync(op.target.replaceAll("$ROOT", root), at(op.symlink));
    else if ("link" in op) linkSync(at(op.to), at(op.link));
    else if ("fifo" in op) execFileSync("mkfifo", [at(op.fifo)]);
    else if ("rm" in op) rmSync(at(op.rm), { recursive: true, force: true });
    else if ("rename" in op) renameSync(at(op.rename), at(op.to));
    else if ("chmod" in op) chmodSync(at(op.chmod), op.mode);
    else utimesSync(at(op.mtime), op.ms / 1000, op.ms / 1000);
  }
}

async function fsCase(k: FsCase) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "p4k-fstool-")));
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  try {
    applyOps([...FS_BASE, ...(k.tree ?? [])], root);
    let pending: Op[] | undefined;
    const cfg: FsConfig = {
      roots: [{ id: "ws", path: join(root, "root") }], home: join(root, "no-home"),
      ...(k.config?.deny ? { deny: expand(k.config.deny, root) as never } : {}), ...(k.config?.limits ? { limits: k.config.limits } : {}),
      ...(k.config?.cwd ? { cwd: expand(k.config.cwd, root) as string } : {}),
      testHooks: { afterCheck: async () => { const ops = pending; pending = undefined; if (ops) applyOps(ops, root); } },
    };
    const { tools } = createFsTools(cfg);
    const results: unknown[] = [];
    for (const step of k.steps) {
      if ("fs" in step) { applyOps(step.fs, root); results.push(null); continue; }
      if ("peek" in step) {
        try { const st = lstatSync(join(root, step.peek)); results.push(st.isFile() ? { b64: readFileSync(join(root, step.peek)).toString("base64"), mode: st.mode & 0o777 } : { kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "other" }); }
        catch { results.push({ missing: true }); }
        continue;
      }
      pending = step.afterCheck;
      const forms = (step.secrets ?? []).map((s) => s.parts.join(""));
      const snapshot = { forms, matcher: createSecretMatcher(forms) };
      const tool = tools.find((x) => x.name === step.tool)!;
      let outcome: unknown;
      try { outcome = await tool.execute(expand(step.args, root), { signal: undefined, ...(step.secrets ? { knownSecrets: () => snapshot } : {}) }); } catch (e) { outcome = { threw: String(e) }; }
      pending = undefined;
      results.push(mask(outcome, root));
    }
    return { name: k.name, tree: k.tree ?? [], config: k.config ?? {}, steps: k.steps, results, ...(k.divergence ? { divergence: k.divergence } : {}) };
  } finally {
    delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    rmSync(root, { recursive: true, force: true });
  }
}

function buildFsMeta() {
  const codes: FsFailureCode[] = ["invalid-arguments", "path-refused", "not-found", "not-a-file", "not-a-directory", "exists", "too-large", "binary-content", "changed", "aborted", "io-error", "internal-error"];
  return {
    limits: DEFAULT_LIMITS,
    failures: codes.map((code) => new FsFailure(code, "m").toResult().error),
    withReason: new FsFailure("path-refused", "outside-root: d", "outside-root").toResult(),
    schemas: { "file.stat": FILE_STAT_SCHEMA, "file.list": FILE_LIST_SCHEMA, "file.read": FILE_READ_SCHEMA, "file.write": FILE_WRITE_SCHEMA },
    capabilities: FS_CAPABILITIES,
    tools: createFsTools({ roots: [{ id: "x", path: "/nowhere" }] }).tools.map((x) => ({ name: x.name, description: x.description, effect: x.effect, parallelSafe: x.parallelSafe })),
  };
}

/** The vectors that do not touch the file system; built and compared on every system. */
export function buildToolsPureVectors() {
  return { "exec-rules": buildExecRules(), "fs-meta": buildFsMeta() };
}

/** The vectors recorded against real directories and files on `RECORDED_ON`. */
export async function buildToolsRecordedVectors() {
  if (process.platform !== RECORDED_ON) throw new Error(`the tool vectors against real files are recorded on ${RECORDED_ON}, not ${process.platform}`);
  const runs = [];
  for (const k of RUNS) runs.push(await execRunCase(k));
  const cases = [];
  for (const k of FS_CASES) cases.push(await fsCase(k));
  return { "exec-runs": { platform: RECORDED_ON, runs }, fs: { platform: RECORDED_ON, base: FS_BASE, cases } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let rc = await exporterMain({ area: "tools", build: buildToolsPureVectors });
  if (process.platform !== RECORDED_ON) {
    console.log(`skip  fixtures/parity/tools/{exec-runs,fs}.json: recorded on ${RECORDED_ON}, this machine is ${process.platform}; not compared, not written`);
  } else {
    rc = Math.max(rc, await exporterMain({ area: "tools", build: buildToolsRecordedVectors }));
  }
  process.exitCode = rc;
}

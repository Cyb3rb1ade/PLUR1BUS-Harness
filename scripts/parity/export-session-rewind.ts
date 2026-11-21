// Parity vectors (mode V) for the file-checkpoint half of rewind (P4-K K5c, plan P4-40): `RewindCheckpoints.capture` and
// `.restore` of `packages/core/src/session/rewind-checkpoints.ts`. `crates/plur1bus-core/src/sessions/rewind_vectors.rs`
// replays every case. Recorded, never edited by hand.
//
// Git is a child process behind `checkpoint-git-process.ts`, which has no injection point. The exporter therefore puts a `git`
// shim first on the PATH: it appends the argument list and the `GIT_*` environment of every call to a log, fixes the author and
// committer dates (so a commit id is the same on every run), and runs the real git. The log is what the Rust port must send its
// own Git process port, byte for byte, after the run-specific names are replaced by placeholders: `$ROOT` (the real path of the
// repository), `$TMP` (the private temporary directory of one operation), `$SID` and `$TURN` (session and turn identifiers).
// The repository is built with real git in a temporary directory with an isolated configuration; the files of a case are listed
// in the case so the replay can build the same tree. A case's `after` holds the file contents that remain.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-session-rewind.ts [--check]
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryAuditSink } from "../../packages/core/src/rbac/audit.ts";
import { RewindCheckpoints } from "../../packages/core/src/session/rewind-checkpoints.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { exporterMain } from "./lib.mjs";

const DATE = "2026-01-02T03:04:05Z";

interface Case {
  name: string;
  /** What the case does, in order: `capture`, `edit <file> <text>`, `restore`, `restore-asked-then-edit <file> <text>`. */
  steps: string[];
  approve: boolean;
  /** `none`, `no-repository`, `no-commit` */
  repository: string;
}

const CASES: Case[] = [
  { name: "capture-restore", repository: "none", approve: true,
    steps: ["edit tracked.txt checkpoint working contents\n", "edit untracked.txt untracked must survive\n", "capture", "edit tracked.txt failed edit\n", "restore"] },
  { name: "restore-denied", repository: "none", approve: false,
    steps: ["edit tracked.txt checkpoint working contents\n", "capture", "edit tracked.txt failed edit\n", "restore"] },
  { name: "restore-changed-while-asking", repository: "none", approve: true,
    steps: ["edit tracked.txt checkpoint working contents\n", "capture", "edit tracked.txt failed edit\n", "restore-asked-then-edit tracked.txt changed while the human thought\n"] },
  { name: "restore-refuses-to-overwrite-untracked", repository: "none", approve: true,
    steps: ["edit sub/new.txt tracked at the checkpoint\n", "track sub/new.txt", "capture", "untrack sub/new.txt", "restore"] },
  { name: "capture-no-repository", repository: "no-repository", approve: true, steps: ["capture"] },
  { name: "capture-no-commit", repository: "no-commit", approve: true, steps: ["edit tracked.txt only staged\n", "capture"] },
];

function normalise(text: string, root: string, sid: string, turn: string): string {
  return text.split(root).join("$ROOT").split(sid).join("$SID").split(turn).join("$TURN")
    .replace(/(?:\/[^/\0\s=]+)*\/p1b-checkpoint-[A-Za-z0-9]+/g, "$TMP");
}

const SHIM = (log: string, real: string) => `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const env = Object.entries(process.env).filter(([k]) => k.toUpperCase().startsWith("GIT_")).sort(([a], [b]) => a < b ? -1 : 1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env }) + "\\n");
const r = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { env: { ...process.env, GIT_AUTHOR_DATE: ${JSON.stringify(DATE)}, GIT_COMMITTER_DATE: ${JSON.stringify(DATE)} }, stdio: ["ignore", "pipe", "pipe"] });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
`;

async function run(c: Case) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rewind-vec-")));
  const root = join(base, "repo"), home = join(base, "home"), bin = join(base, "bin"), log = join(base, "git.log");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const isolated = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE };
  const git = (...args: string[]) => execFileSync(real, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args], { cwd: root, env: isolated, encoding: "utf8" });
  const write = (rel: string, text: string) => { mkdirSync(join(root, rel).replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(join(root, rel), text); };
  if (c.repository !== "no-repository") {
    git("init", "-q");
    write("tracked.txt", "original\n"); write("other.txt", "other\n");
    if (c.repository === "none") { git("add", "-A"); git("commit", "-q", "-m", "fixture"); }
    else git("add", "-A");
  }
  const store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "card", agentId: "a", owner: "owner" });
  const asks: string[] = [];
  let onAsk: (() => void) | undefined;
  const checkpoints = new RewindCheckpoints({ store, audit: memoryAuditSink(), now: () => 42, fileProjects: () => ["p"],
    retentionTurns: () => 50, cardEnded: () => false, project: () => ({ projectId: "p", cardId: "c", root }),
    approval: { request: async ask => { asks.push(ask.tool); onAsk?.(); return { approved: c.approve, scope: "once" as const }; },
      begin: () => true } });
  writeFileSync(join(bin, "git"), SHIM(log, real)); chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  const turn = store.beginTurn(session.id, "edit", 1).turn.id;
  const results: unknown[] = [];
  const calls = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const mark: number[] = [];
  const outcome = async (op: () => Promise<void>) => {
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    const before = calls().length;
    let result: Record<string, unknown> = { ok: true };
    try { await op(); } catch (e: any) {
      result = { ok: false, name: e?.name, code: e?.code, reason: e?.reason, message: String(e?.message ?? ""),
        gitExit: typeof e?.cause?.code === "number" ? e.cause.code : null };
    } finally { process.env.PATH = oldPath; }
    const all = calls().slice(before).map(x => ({ args: x.args.map((a: string) => normalise(a, root, session.id, turn)),
      env: x.env.map(([k, v]: [string, string]) => [k, normalise(v, root, session.id, turn)]) }));
    mark.push(all.length);
    return { result, calls: all };
  };
  try {
    for (const step of c.steps) {
      const [verb, ...rest] = step.split(" ");
      const text = rest.join(" ");
      if (verb === "edit") { const [file, ...t] = text.split(" "); write(file!, t.join(" ")); }
      else if (verb === "track") { git("add", text); }
      else if (verb === "untrack") { git("rm", "-q", "--cached", text); }
      else if (verb === "capture") {
        results.push({ step: "capture", ...await outcome(() => checkpoints.capture({ sessionId: session.id, turnId: turn, personId: "owner", signal: new AbortController().signal })) });
        store.completeTurn(turn, { text: "done", tokens: 1 });
      } else if (verb === "restore" || verb === "restore-asked-then-edit") {
        if (verb !== "restore") { const [file, ...t] = text.split(" "); onAsk = () => write(file!, t.join(" ")); }
        const recorded = await outcome(() => checkpoints.restore({ sessionId: session.id, parentSeq: 0, hiddenFromSeq: 1, hiddenToSeq: 2,
          checkpointTurnId: turn, approver: { person: "owner", surface: 2 }, signal: new AbortController().signal, validate: () => {} }));
        const invokes = (call: (typeof recorded.calls)[number], name: string) => call.args.includes(name);
        const apply = recorded.calls.findIndex(call => invokes(call, "restore"));
        const writeTree = recorded.calls.findLastIndex(call => invokes(call, "write-tree"));
        const workTree = recorded.calls.findLastIndex((call, i) => i < writeTree && call.args.at(-2) === "--git-path" && call.args.at(-1) === "index");
        const list = recorded.calls.findLastIndex((call, i) => i < apply && invokes(call, "ls-tree"));
        const recheck = apply < 0 ? undefined : {
          divergence: "K5-D8", beforeCall: apply,
          calls: [...recorded.calls.slice(list, list + 2), ...recorded.calls.slice(workTree, writeTree + 2)],
        };
        results.push({ step: verb, ...recorded, ...(recheck ? { recheck } : {}) });
        onAsk = undefined;
      }
    }
    const row = store.checkpoint(session.id, turn);
    const after: Record<string, string | null> = {};
    for (const f of ["tracked.txt", "untracked.txt", "other.txt", "sub/new.txt"]) {
      try { after[f] = readFileSync(join(root, f), "utf8"); } catch { after[f] = null; }
    }
    return { name: c.name, repository: c.repository, approve: c.approve, steps: c.steps, results, asks,
      checkpoint: row ? { tree: row.tree, commitId: row.commitId, ref: normalise(row.ref, root, session.id, turn) } : null, after };
  } finally {
    process.env.PATH = oldPath;
    // The retention runs in the background; let it stop before the store closes, or a late job touches a closed database
    // after the parity test has ended.
    await checkpoints.close();
    store.close(); rmSync(base, { recursive: true, force: true });
  }
}

export async function buildRewindVectors() {
  const cases = [];
  for (const c of CASES) cases.push(await run(c));
  return { cases };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "session-rewind", build: buildRewindVectors });
}

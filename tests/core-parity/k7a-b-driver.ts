// User jobs and system-jobs ledger round trip, parity mode B (P4-K K7a, plan P4-51): the TypeScript side that
// `crates/plur1bus-core/tests/k7a_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/k7a-b-driver.ts prepare <dir>
//   node ... tests/core-parity/k7a-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>, with the product code of each store:
//   user-jobs-ts.sqlite      one job, one finished run and one run that was still `running` when the process stopped
//   user-jobs-ref.sqlite     the store opened and closed with no data: the reference for the schema text of a fresh Rust file
//   ledger-ts/ledger.jsonl   system job runs, and ledger.jsonl.1 after the rotation at 1 MiB
//   manifest.json            the clock and the ids the Rust test needs
// The Rust test reads and writes copies (`user-jobs-rust.sqlite`, `ledger-rust/`) and creates a fresh file
// (`user-jobs-fresh-rust.sqlite`); `verify` opens those with the product code (on copies) and prints one JSON object. Test
// tooling only; no product code imports it.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy } from "./store-roundtrip.ts";
import { UserJobs } from "../../packages/core/src/user-jobs/index.ts";
import { createSystemJobs } from "../../packages/core/src/system-jobs/index.ts";

const NOW = Date.UTC(2026, 5, 1, 8, 0);
const MEL = { userId: "mel", role: "member", kind: "person", agentRights: { main: "manage" } };
const OLGA = { userId: "olga", role: "owner", kind: "person" };
const PRINCIPALS: Record<string, any> = { mel: MEL, olga: OLGA };

function userJobs(path: string, now: number): UserJobs {
  return new UserJobs({
    path, clock: () => now, audit: { append: () => {} } as any,
    agentExists: (id: string) => id === "main", agents: () => ["main"],
    resolve: (id: string) => (PRINCIPALS[id] ? { ...PRINCIPALS[id] } : null),
    budgetBlocked: () => false, notify: () => {}, submitTurn: async () => "completed", isStopping: () => false,
  } as any);
}

function systemJobs(ledgerPath: string, now: number) {
  const jobs = createSystemJobs({
    ledgerPath, clock: { now: () => now, setTimer: () => ({}) as any } as any, securePath: () => ({ applied: true }),
    logger: { warn: () => {} }, engineHasJob: () => false,
  });
  jobs.register({
    spec: { name: "j", needsLlm: false, singleton: true, schedule: { every: 60_000, jitter: 0.1 } },
    nextRunAt: () => null, validateArgs: (a: unknown) => (a ?? {}) as Record<string, unknown>,
    run: async () => ({ outcome: "completed", detail: null }),
  } as any);
  return jobs;
}

async function prepare(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "user-jobs-ts.sqlite");
  const d = userJobs(path, NOW);
  const job = d.create({ name: "Daily", agentId: "main", prompt: "Summarize", schedule: { cron: "0 9 * * *", timezone: "Europe/Berlin" }, enabled: true }, { ...MEL } as any);
  d.close();
  const db = new DatabaseSync(path);
  const run = (id: string, outcome: string, over: Record<string, unknown> = {}) => ({ runId: id, jobId: job.id, agentId: "main", job: "Daily", kind: "user", runAs: "mel", runAsDisplayName: "mel", trigger: "recurring", startedAt: NOW - 9000, finishedAt: NOW - 8000, durationMs: 1000, outcome, ...over });
  db.prepare("INSERT INTO user_job_runs VALUES (?,?,?)").run("run-done", job.id, JSON.stringify(run("run-done", "completed")));
  db.prepare("INSERT INTO user_job_runs VALUES (?,?,?)").run("run-open", job.id, JSON.stringify(run("run-open", "running", { startedAt: NOW - 5000, finishedAt: NOW - 5000, durationMs: 0 })));
  db.close();
  userJobs(join(dir, "user-jobs-ref.sqlite"), NOW).close();
  // The ledger: two runs, then a ledger past 1 MiB so that the next run rotates it.
  const ledger = join(dir, "ledger-ts", "ledger.jsonl");
  const s = systemJobs(ledger, NOW);
  await s.run("j", { a: 1, b: [1, 2] }, { trigger: "manual" });
  await s.run("j", undefined, { trigger: "cron" });
  writeFileSync(ledger, readFileSync(ledger, "utf8") + "\n".repeat(1_048_576));
  const rotating = await s.run("j", { c: 3 }, { trigger: "cron" });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ now: NOW, jobId: job.id, tsRotatingRunId: rotating.record.runId, ledgerBytes: statSync(ledger).size, rotated: existsSync(`${ledger}.1`) }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what the code that made the file produced. */
function schemaOf(copy: StoreCopy): string {
  return JSON.stringify(copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
}

async function verify(dir: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const c: Record<string, StoreCopy> = {};
  for (const n of ["user-jobs-rust", "user-jobs-fresh-rust", "user-jobs-ref"]) c[n] = StoreCopy.open(join(dir, `${n}.sqlite`));
  const scratch = mkdtempSync(join(tmpdir(), "p4k-k7a-"));
  try {
    const out: Record<string, unknown> = {
      sameSchema: { fresh: schemaOf(c["user-jobs-fresh-rust"]!) === schemaOf(c["user-jobs-ref"]!), written: schemaOf(c["user-jobs-rust"]!) === schemaOf(c["user-jobs-ref"]!) },
    };
    // The product code reads what Rust wrote: both jobs, the run Rust abandoned and the ones TypeScript left.
    const d = userJobs(c["user-jobs-rust"]!.path, manifest.now + 20_000);
    out.userJobs = {
      jobs: d.list(OLGA as any).map((j: any) => [j.name, j.runAs, j.enabled, j.nextRunAt === null]).sort(),
      history: d.history(undefined, OLGA as any).map((r: any) => [r.runId, r.outcome, r.durationMs]).sort(),
    };
    d.close();
    // The ledger Rust appended to.
    const ledgerCopy = join(scratch, "ledger.jsonl");
    for (const suffix of ["", ".1"]) if (existsSync(join(dir, "ledger-rust", `ledger.jsonl${suffix}`))) copyFileSync(join(dir, "ledger-rust", `ledger.jsonl${suffix}`), ledgerCopy + suffix);
    const s = systemJobs(ledgerCopy, manifest.now + 30_000);
    const history = s.history({});
    out.ledger = { runs: history.map((r: any) => [r.runId, r.job, r.trigger, r.outcome, r.args ?? null]), hasRustRun: history.some((r: any) => r.runId === rust.rustRunId), hasTsRotating: history.some((r: any) => r.runId === manifest.tsRotatingRunId) };
    return out;
  } finally { for (const x of Object.values(c)) x.dispose(); rmSync(scratch, { recursive: true, force: true }); }
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) {
  console.error("usage: k7a-b-driver.ts prepare|verify <dir>");
  process.exit(2);
}
if (command === "prepare") await prepare(dir);
else console.log(JSON.stringify(await verify(dir)));

// P4D-7: the front door writes its own lines to `logs/core.log`, the file the TypeScript core behind it writes too. This
// drives both writers at once, in two languages and two processes, through enough lines to rotate the file, and then
// reads every file of the log: no line torn, none lost, the file rotated, and each side's lines told apart by `src`.
//
// The lines come from `core.adopt` with the current supervisor nonce: the TypeScript core accepts it and logs
// "adopted", then the front door takes the lifeline and logs "adopted" as well (`src: "front-door"`). One accepted
// adoption is exactly one line from each writer, so the counts are exact; the front door never waits for its log, so a
// line it could not queue is in the count of its "front door log lines dropped" line instead.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../../packages/core/src/paths.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { settled } from "./p4-10-parity.ts";
import { rawConnect } from "./raw-client.ts";
import { startProcessTarget } from "./target.ts";

/** The smallest rotation size the configuration accepts. */
export const MAX_BYTES = 1_048_576;
/** More files than a run fills, so nothing is pruned and the counts stay exact. */
const KEEP = 50;

export interface LogInspection {
  /** The files of the role, newest first (`core.log`, `core.log.1`, ...), with their sizes. */
  files: Array<{ name: string; bytes: number }>;
  lines: number;
  /** Lines that are not one complete JSON object (file and line number, with the start of the text). */
  torn: string[];
  /** "adopted" lines by writer. */
  frontDoor: number;
  legacy: number;
  /** Lines of the front door at all (any message). */
  frontDoorLines: number;
  /** Lines the front door reports as dropped (its queue was full). */
  frontDoorDropped: number;
}

/** Reads every file of the `core` role in `dir`. A final line without its newline counts as torn. */
export function inspectLogs(dir: string): LogInspection {
  const names = readdirSync(dir).filter((n) => /^core\.log(\.\d+)?$/.test(n))
    .sort((a, b) => Number(a.split(".")[2] ?? 0) - Number(b.split(".")[2] ?? 0));
  const out: LogInspection = { files: [], lines: 0, torn: [], frontDoor: 0, legacy: 0, frontDoorLines: 0, frontDoorDropped: 0 };
  for (const name of names) {
    const path = join(dir, name);
    out.files.push({ name, bytes: statSync(path).size });
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const last = lines.pop();
    if (last !== "") out.torn.push(`${name}: no newline at the end: ${String(last).slice(0, 80)}`);
    lines.forEach((line, i) => {
      out.lines++;
      let record: any;
      try { record = JSON.parse(line); } catch { /* torn */ }
      if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.level !== "string") {
        out.torn.push(`${name}:${i + 1}: ${line.slice(0, 80)}`);
        return;
      }
      const front = record.src === "front-door";
      if (front) out.frontDoorLines++;
      if (front && record.msg === "front door log lines dropped" && Number.isInteger(record.dropped)) out.frontDoorDropped += record.dropped;
      if (record.msg === "adopted") { if (front) out.frontDoor++; else out.legacy++; }
    });
  }
  return out;
}

export interface LogWritersResult extends LogInspection { adoptions: number; accepted: number; findings: string[]; passed: boolean }

/** What a run of `adoptions` accepted adoptions must have left in the log. */
export function judge(found: LogInspection, adoptions: number, accepted: number, maxBytes = MAX_BYTES): string[] {
  const findings: string[] = [];
  if (accepted !== adoptions) findings.push(`${accepted} of ${adoptions} adoptions were accepted`);
  if (found.torn.length) findings.push(`${found.torn.length} torn lines, the first: ${found.torn[0]}`);
  // Nothing but "adopted" is written in numbers here, so what the front door dropped were such lines.
  if (found.frontDoor > adoptions || found.frontDoor + found.frontDoorDropped < adoptions)
    findings.push(`the front door wrote ${found.frontDoor} "adopted" lines and reports ${found.frontDoorDropped} dropped for ${adoptions} adoptions`);
  if (found.frontDoor * 2 < adoptions) findings.push(`the front door dropped most of its lines (${found.frontDoor} of ${adoptions} written)`);
  if (found.legacy !== adoptions) findings.push(`the TypeScript core wrote ${found.legacy} "adopted" lines for ${adoptions} adoptions`);
  if (found.files.length < 2) findings.push(`the log did not rotate (${found.files.map((f) => `${f.name} ${f.bytes}`).join(", ") || "no file"})`);
  // Either writer rotates before the line that would pass the limit; a batch of the other may land in between.
  const largest = found.files.reduce((m, f) => Math.max(m, f.bytes), 0);
  if (largest > 2 * maxBytes) findings.push(`a file grew to ${largest} bytes with a limit of ${maxBytes}`);
  return findings;
}

/** Runs the front door with the TypeScript core behind it and has `adoptions` adoptions accepted over `connections`
 *  connections at once. */
export async function logWriters(adoptions: number, connections = 4): Promise<LogWritersResult> {
  const home = tempDir("p1b-logw-");
  const target = await startProcessTarget("rust", {
    home,
    stderr: "ignore", // the front door repeats every line there
    config: (cfg) => { cfg.logs = { ...(cfg.logs ?? {}), maxBytes: MAX_BYTES, keep: KEEP }; cfg.core = { ...(cfg.core ?? {}), logLevel: "info" }; },
  });
  let accepted = 0;
  try {
    await settled(target);
    // The nonce an adoption proves is the supervisor's credential file; no supervisor runs here, so this is all of it.
    const nonce = randomBytes(32).toString("hex");
    mkdirSync(dirname(layout(home).supervisorToken), { recursive: true, mode: 0o700 });
    writeFileSync(layout(home).supervisorToken, `${nonce}\n`, { mode: 0o600 });
    const open: Array<{ close(): Promise<void> }> = [];
    const share = Math.ceil(adoptions / connections);
    const runs = Array.from({ length: connections }, async (_, c) => {
      const mine = Math.min(share, adoptions - c * share);
      if (mine <= 0) return 0;
      const conn = await rawConnect(target.address);
      conn.send({ jsonrpc: "2.0", id: 0, method: "core.auth", params: { token: target.token } });
      await conn.waitFor((f) => f.id === 0, "core.auth");
      const BATCH = 100;
      for (let sent = 0; sent < mine; sent += BATCH) {
        const until = Math.min(mine, sent + BATCH);
        for (let i = sent; i < until; i++) conn.send({ jsonrpc: "2.0", id: i + 1, method: "core.adopt", params: { nonce } });
        if (!await conn.waitForCount(1 + until, 60_000)) throw new Error(`connection ${c}: ${conn.received.length - 1} of ${until} adoptions answered`);
      }
      // The connections stay open until the core has stopped: closing an adopted one starts the orphan grace.
      open.push(conn);
      return conn.received.filter((f) => typeof f.id === "number" && f.id > 0 && f.result !== undefined).length;
    });
    try { accepted = (await Promise.all(runs)).reduce((a, b) => a + b, 0); }
    finally { await target.stop(); await Promise.all(open.map((c) => c.close())); }
  } finally { await target.stop(); }
  const found = inspectLogs(layout(home).logs);
  const findings = judge(found, adoptions, accepted);
  return { ...found, adoptions, accepted, findings, passed: findings.length === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const adoptions = Number(value("--adoptions") ?? 8000);
  const r = await logWriters(adoptions);
  console.log(`P4D-7 log writers: ${r.accepted}/${r.adoptions} adoptions, ${r.lines} lines in ${r.files.length} files (${r.files.map((f) => `${f.name} ${f.bytes}`).join(", ")}); "adopted" lines: front door ${r.frontDoor} (${r.frontDoorDropped} reported dropped), TypeScript core ${r.legacy}; front door lines in all: ${r.frontDoorLines}; torn: ${r.torn.length}`);
  for (const f of r.findings) console.log(`       ${f}`);
  const out = value("--json");
  if (out) writeFileSync(out, JSON.stringify({ ...r, torn: r.torn.slice(0, 50) }, null, 2));
  process.exit(r.passed ? 0 : 1);
}

// P4-20 flip A: the front door answers `logs.query` itself, masked with the values of the legacy core's redaction
// registry, which it mirrors over `legacy.redaction.changes` (docs/phase4/bridge.md). This runs one scenario three times
// and compares the answers: on a stock TypeScript core, on the front door (native), and on the front door with
// `PLUR1BUS_P4_IDENTITY=ts` (the same method through the relay).
//
// The scenario plants two log lines that hold values in the clear (written by a process that does not know they are
// secrets), then makes the values secrets while the core runs: one is set, rotated to the other, and deleted. After
// every change the next `logs.query` must show the same masks on every leg. On the native leg the secret is set in one
// process (the TypeScript core, `secret.set` is relayed) and masked in the other, with nothing but the feed between
// them. The rest of the steps are the method's own answers on the same lines: order, level, limit, a time range, and
// the refusals.
//
// Who answered. Every leg records the frames its TypeScript core reads and writes (the parity recorder, a test seam).
// On the native leg no `logs.query` frame may reach the TypeScript core; on the other two every one does. The same
// recording shows the feed: the front door's calls, and that the recorder writes none of their values (it replaces
// what stands under a key named like a secret). No value may be in a recorded frame other than a `logs.query` request
// or answer, or in any log file the processes wrote themselves.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../../packages/core/src/paths.ts";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { settled } from "./p4-10-parity.ts";
import { differences, LEGS, type Leg, type Step } from "./p4-12-native.ts";
import { rawConnect } from "./raw-client.ts";
import { startProcessTarget } from "./target.ts";

export { LEGS, type Leg, type Step };

/** The values of the scenario: plain words, long enough to be masked, in no log line by accident. */
export const FIRST = "the first value of the parity store";
export const SECOND = "the value it was rotated to";
/** Never a secret: it stays readable on every leg. */
export const NEVER = "words that never were a secret";
export const VALUES: readonly string[] = [FIRST, SECOND];
const NAME = "parity.redaction";
/** What the recorder writes in place of a value (`PARITY_SECRET_PLACEHOLDER` of module-api). */
const PLACEHOLDER = "[REDACTED:secret]";

const line = (ts: string, level: string, msg: string): string =>
  `${JSON.stringify({ ts, level, source: { kind: "harness", id: "planted", version: null }, event: "core.test", msg })}\n`;
/** The planted file: two records of the component `planted`. */
export const PLANTED = line("2026-10-07T09:00:00.000Z", "error", `the provider said ${FIRST} and ${SECOND} and ${NEVER}`)
  + line("2026-10-07T09:00:01.000Z", "info", `the second line holds ${SECOND} alone`);

/** An answer without what differs between two runs: the request id, the home's path, and how many bytes were read
 *  (the files of the processes themselves are read too, and the legs do not write the same lines). */
export function normalised(reply: any, homes: readonly string[]): unknown {
  let text = JSON.stringify(reply?.error !== undefined ? { error: reply.error } : { result: reply?.result });
  for (const home of homes) text = text.replaceAll(JSON.stringify(home).slice(1, -1), "<home>");
  const answer = JSON.parse(text);
  if (typeof answer.result?.scanned?.bytes === "number") answer.result.scanned.bytes = "<bytes>";
  return answer;
}

export interface RecordingFacts {
  /** `logs.query` requests the TypeScript core read. */
  queries: number;
  /** `legacy.redaction.changes` requests it read. */
  feedCalls: number;
  /** Their answers that were written with the placeholder in place of the changes (the recorder replaces the member
   *  whatever it holds). */
  feedAnswersMasked: number;
  /** Their answers that were written with the changes themselves. */
  feedAnswersOpen: number;
  /** Frames that hold a value and are no `logs.query` request or answer. (Those may: a query can name any text, and
   *  an answer shows the lines as they are while the value is no secret yet.) */
  framesWithValues: number;
}

/** What a recording (the lines of every file a leg's recorders wrote) says about who answered and what was written. */
export function recordingFacts(lines: readonly string[], values: readonly string[] = VALUES): RecordingFacts {
  const facts: RecordingFacts = { queries: 0, feedCalls: 0, feedAnswersMasked: 0, feedAnswersOpen: 0, framesWithValues: 0 };
  const feed = new Set<string>(), query = new Set<string>();
  for (const text of lines) {
    if (!text.trim()) continue;
    const { file, conn, dir, msg } = JSON.parse(text) as { file?: string; conn: number; dir: string; msg: any };
    const key = `${file ?? ""}:${conn}:${JSON.stringify(msg?.id)}`;
    const ofQuery = dir === "in" ? msg?.method === "logs.query" : msg?.method === undefined && query.delete(key);
    if (dir === "in" && ofQuery) { facts.queries++; query.add(key); }
    if (!ofQuery && values.some((v) => text.includes(v))) facts.framesWithValues++;
    if (dir === "in" && msg?.method === "legacy.redaction.changes") { facts.feedCalls++; feed.add(key); }
    if (dir === "out" && msg?.method === undefined && feed.has(key)) {
      feed.delete(key);
      if (msg?.result?.secrets === PLACEHOLDER) facts.feedAnswersMasked++;
      else if (msg?.result !== undefined) facts.feedAnswersOpen++;
    }
  }
  return facts;
}

/** The names of the texts that hold one of `values`. */
export function holding(texts: ReadonlyArray<readonly [name: string, text: string]>, values: readonly string[] = VALUES): string[] {
  return texts.filter(([, text]) => values.some((v) => text.includes(v))).map(([name]) => name);
}

/** What the recording of a leg must show, as findings. `queries` is how many `logs.query` requests the scenario sent. */
export function recordingFindings(leg: Leg, facts: RecordingFacts, queries: number): string[] {
  const out: string[] = [];
  const native = leg.impl === "rust" && !leg.env;
  if (native && facts.queries !== 0) out.push(`${leg.name}: ${facts.queries} logs.query requests reached the TypeScript core; the front door relayed them`);
  if (!native && facts.queries !== queries) out.push(`${leg.name}: the TypeScript core read ${facts.queries} logs.query requests, expected ${queries}`);
  if (leg.impl === "ts" && facts.feedCalls !== 0) out.push(`${leg.name}: ${facts.feedCalls} calls of the feed without a front door`);
  if (leg.impl === "rust" && (facts.feedCalls < 2 || facts.feedAnswersMasked < 1)) out.push(`${leg.name}: the front door did not follow the feed (${facts.feedCalls} calls, ${facts.feedAnswersMasked} answers)`);
  // The follower's calls are few (it waits in the legacy core); a native query adds one catch-up.
  const allowed = (native ? queries : 0) + 25;
  if (leg.impl === "rust" && facts.feedCalls > allowed) out.push(`${leg.name}: the front door asked the feed ${facts.feedCalls} times (at most ${allowed} expected): a loop`);
  if (facts.feedAnswersOpen !== 0) out.push(`${leg.name}: ${facts.feedAnswersOpen} answers of the feed were recorded without the placeholder`);
  if (facts.framesWithValues !== 0) out.push(`${leg.name}: ${facts.framesWithValues} recorded frames hold a value (a secret.* call, the feed, or another answer)`);
  return out;
}

function recordingLines(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    for (const text of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (text.trim()) out.push(JSON.stringify({ file: name, ...JSON.parse(text) }));
    }
  }
  return out;
}

export async function scenario(leg: Leg, findings: string[], notes: string[] = []): Promise<Step[]> {
  const home = tempDir("p1b-redaction-");
  const recordings = tempDir("p1b-redaction-rec-");
  const env = { ...(leg.env ?? {}), PLUR1BUS_SECRETS_KEYRING: "memory", PLUR1BUS_PARITY_RECORD: join(recordings, "rpc.ndjson") };
  const target = await startProcessTarget(leg.impl, { home, env, stderr: "ignore" });
  const steps: Step[] = [];
  let queries = 0;
  try {
    await settled(target);
    const logs = layout(home).logs;
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(join(logs, "planted.log"), PLANTED, { mode: 0o600 });
    const homes = [...new Set([realpathSync(home), home])];
    const c = await rawConnect(target.address);
    let n = 0;
    const call = async (method: string, params: unknown): Promise<any> => {
      const id = ++n;
      if (method === "logs.query") queries++;
      c.send({ jsonrpc: "2.0", id, method, params });
      return c.waitFor((f) => f.id === id && f.method === undefined, method, 30_000);
    };
    try {
      await call("core.auth", { token: target.token });
      const step = async (label: string, params: Record<string, unknown>): Promise<any> => {
        const reply = await call("logs.query", params);
        steps.push([label, normalised(reply, homes)]);
        return reply;
      };
      const planted = (extra: Record<string, unknown> = {}) => ({ component: "planted", ...extra });
      const change = async (what: string, method: string, params: Record<string, unknown>): Promise<boolean> => {
        const reply = await call(method, params);
        if (reply?.result === undefined) findings.push(`${leg.name}: ${what} failed: ${JSON.stringify(reply?.error)}`);
        return reply?.result !== undefined;
      };
      const shows = (reply: any, value: string): boolean => JSON.stringify(reply?.result ?? null).includes(value);

      const before = await step("before any secret: the lines as written", planted());
      if (!shows(before, FIRST) || !shows(before, SECOND)) findings.push(`${leg.name}: the planted lines are not in the answer as written`);

      if (!await change("secret.set", "secret.set", { name: NAME, value: FIRST })) return steps;
      const set = await step("set: masked in the very next query", planted());
      if (shows(set, FIRST) || !shows(set, SECOND) || !shows(set, NEVER)) findings.push(`${leg.name}: after the set, the answer does not mask exactly the value that was set`);

      if (!await change("secret.set (rotation)", "secret.set", { name: NAME, value: SECOND })) return steps;
      const rotated = await step("rotated: the old value stays masked, the new one is masked", planted());
      if (shows(rotated, FIRST) || shows(rotated, SECOND) || !shows(rotated, NEVER)) findings.push(`${leg.name}: after the rotation, a value is in the answer`);

      if (!await change("secret.delete", "secret.delete", { name: NAME })) return steps;
      const deleted = await step("deleted: both stay masked", planted());
      if (shows(deleted, FIRST) || shows(deleted, SECOND)) findings.push(`${leg.name}: after the deletion, a value is in the answer`);

      await step("oldest first", planted({ order: "asc" }));
      await step("errors only", planted({ minLevel: "error" }));
      await step("one record", planted({ limit: 1 }));
      await step("a text of the record as it is shown", { text: "the second line holds" });
      await step("a text only the unmasked record has", { text: FIRST });
      await step("a time range that holds the second line", planted({ from: "2026-10-07T09:00:00.500Z", to: "2026-10-07T09:00:02Z" }));
      await step("a time range before both", planted({ to: "2026-10-07T08:00:00Z" }));
      await step("no such component", { component: "nobody" });
      await step("refused: a bound that is no time", planted({ from: "yesterday" }));
      await step("refused: an empty range", planted({ from: "2026-10-07T10:00:00Z", to: "2026-10-07T09:00:00Z" }));
      await step("refused: a level for the audit stream", { stream: "audit", minLevel: "info" });
      await step("refused: a parameter the method does not have", { nope: 1 });
      await step("refused: a limit of nothing", planted({ limit: 0 }));
    } finally { await c.close(); }
  } finally { await target.stop(); }

  // Who answered, and what was written down.
  const recorded = recordingLines(recordings);
  const facts = recordingFacts(recorded);
  findings.push(...recordingFindings(leg, facts, queries));
  const logs = layout(home).logs;
  const own = existsSync(logs) ? readdirSync(logs).filter((name) => name !== "planted.log").map((name) => [name, readFileSync(join(logs, name), "utf8")] as const) : [];
  for (const name of holding(own)) findings.push(`${leg.name}: a value is in logs/${name}, which a core process wrote`);
  notes.push(`${leg.name}: ${queries} logs.query requests sent, ${facts.queries} read by the TypeScript core; feed: ${facts.feedCalls} calls, ${facts.feedAnswersMasked} answers; ${own.length} log files read for values`);
  return steps;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const findings: string[] = [], notes: string[] = [];
  const runs: Array<{ leg: string; steps: Step[] }> = [];
  for (const leg of LEGS) runs.push({ leg: leg.name, steps: await scenario(leg, findings, notes) });
  for (const run of runs.slice(1)) findings.push(...differences(runs[0]!.steps, run.steps, run.leg));
  console.log(`P4-20 redaction: ${runs[0]!.steps.length} steps on ${runs.length} legs (${runs.map((r) => r.leg).join("; ")}); ${findings.length} findings`);
  for (const f of findings) console.log(`       ${f}`);
  for (const note of notes) console.log(`  note ${note}`);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  if (out) writeFileSync(out, JSON.stringify({ runs, findings, notes }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

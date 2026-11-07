// P4-10 acceptance, modes T and G1: the front door must add nothing. Each transcript is replayed against the stock
// TypeScript core (`core.impl: "ts"`) and against the front door with that same core behind it (`core.impl: "rust"`),
// both in child processes on the real clock, one after the other in the same home path, each once its engine warm-up has
// answered; the two replays are compared (times, pids and uuids masked; the free text of E_INVALID_PARAMS masked by the
// controller ruling). The comparison against the recording itself is reported too, for information: a recording made
// from a test with its own seams (a fake clock, fake providers, an injected RBAC) differs from a stock core on both legs.
// G1: every contract method fixture (packages/rpc-schema/fixtures/methods) is sent with its params, in one owner session,
// to both legs, and the responses are compared.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/p4-10-parity.ts \
//        [--g1] [--control | --floor] [--json <out>] [transcript.ndjson ...]
// `--control` replays on two stock TypeScript cores instead (the noise floor of the real clock and of random values);
// `--floor` runs that control for every transcript (and G1) that differs and counts only the differences beyond it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rawConnect } from "./raw-client.ts";
import { replayTranscript } from "./replay.ts";
import { parityHome, startProcessTarget, type CoreImpl, type ParityTarget } from "./target.ts";
import { compareTranscripts, parseTranscript, type TranscriptLine } from "./transcript.ts";

export interface PairResult { file: string; frontDoor: string[]; vsRecording: number; error?: string }

/** Waits, on a connection of its own, until the engine's recall warm-up has answered (`core.status` no longer degraded
 *  with `models-warming`). The front door is ready later than a bare core, so without this gate the first `core.status`
 *  of a replay races the warm-up differently on the two legs. */
export async function settled(target: ParityTarget, budgetMs = 30_000): Promise<void> {
  const c = await rawConnect(target.address);
  try {
    c.send({ jsonrpc: "2.0", id: 0, method: "core.auth", params: { token: target.token } });
    await c.waitFor((f) => f.id === 0, "core.auth");
    const deadline = Date.now() + budgetMs;
    for (let n = 1; ; n++) {
      c.send({ jsonrpc: "2.0", id: n, method: "core.status", params: {} });
      const r = await c.waitFor((f) => f.id === n, "core.status");
      if (r?.result?.engine?.degraded?.reason !== "models-warming") return;
      if (Date.now() > deadline) throw new Error(`the engine still reports models-warming after ${budgetMs} ms`);
      await new Promise((res) => setTimeout(res, 50));
    }
  } finally { await c.close(); }
}

/** Both legs in child processes on the real clock, one after the other in the same home path, each settled first. */
async function startLeg(impl: CoreImpl, home: string): Promise<ParityTarget> {
  const target = await startProcessTarget(impl, { home });
  try { await settled(target); } catch (e) { await target.stop(); throw e; }
  return target;
}

/** Replays one transcript on both legs and compares the replays. `legs` = `["ts", "ts"]` (`--control`) measures the
 *  noise floor: what two runs of the same stock core already disagree on. */
export async function replayBoth(file: string, legs: readonly [CoreImpl, CoreImpl] = ["ts", "rust"]): Promise<PairResult> {
  const expected = parseTranscript(readFileSync(file, "utf8"));
  const home = parityHome();
  const run = async (impl: CoreImpl) => {
    const target = await startLeg(impl, home);
    try { return await replayTranscript(expected, { address: target.address, token: target.token, responseTimeoutMs: 15_000, notificationTimeoutMs: 1500 }); }
    finally { await target.stop(); }
  };
  try {
    const ts = await run(legs[0]);
    const rust = await run(legs[1]);
    return { file, frontDoor: compareTranscripts(ts, rust).diffs, vsRecording: compareTranscripts(expected, ts).diffs.length };
  } catch (e) {
    return { file, frontDoor: [], vsRecording: 0, error: (e as Error).message };
  }
}

const FIXTURES = fileURLToPath(new URL("../../packages/rpc-schema/fixtures/methods/", import.meta.url));
/** Methods G1 does not send, with the reason. */
export const G1_EXCLUDED: Readonly<Record<string, string>> = {
  "core.shutdown": "stops the core under test; covered by tests/system (both legs) and crates/plur1bus-core/tests/front_door.rs",
};

/** The fixtures as `[file stem, method, params]`; `jobs.run.system`/`.user` are `jobs.run`. */
export function methodFixtures(): Array<[string, string, unknown]> {
  return readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const stem = f.slice(0, -5);
    const method = stem.startsWith("jobs.run.") ? "jobs.run" : stem;
    return [stem, method, JSON.parse(readFileSync(join(FIXTURES, f), "utf8")).params];
  });
}

/** One owner session that sends every fixture in order; returns a transcript of requests and responses. */
async function fixturesOn(impl: CoreImpl, home: string): Promise<TranscriptLine[]> {
  const target = await startLeg(impl, home);
  const lines: TranscriptLine[] = [];
  let seq = 0;
  try {
    let c = await rawConnect(target.address);
    const auth = async () => {
      c.send({ jsonrpc: "2.0", id: 0, method: "core.auth", params: { token: target.token } });
      await c.waitFor((f) => f.id === 0, "core.auth");
    };
    await auth();
    let id = 0;
    for (const [stem, method, params] of methodFixtures()) {
      if (G1_EXCLUDED[method]) continue;
      const mine = `${stem}#${++id}`;
      const msg = { jsonrpc: "2.0", id: mine, method, params };
      lines.push({ seq: ++seq, conn: 0, dir: "in", msg });
      c.send(msg);
      let reply: unknown;
      try { reply = await c.waitFor((f) => f.id === mine && f.method === undefined, mine, 15_000); }
      catch { reply = { jsonrpc: "2.0", id: mine, result: { "<p4-10>": "no response within 15 s" } }; c = await rawConnect(target.address); await auth(); }
      lines.push({ seq: ++seq, conn: 0, dir: "out", msg: reply });
    }
    await c.close();
  } finally { await target.stop(); }
  return lines;
}

/** Methods whose G1 answer differs by design, with the reason; their differences are reported apart, not as failures. */
export const G1_EXPECTED: Readonly<Record<string, string>> = {
  "bridge.hello": "x-server bridge: only the front door serves it, and only to the legacy core (E_DENIED bridge-principal for an owner); a bare TypeScript core has no such method (docs/phase4/bridge.md)",
};

/** `diffs` without those of a method in `G1_EXPECTED`. */
export function withoutExpected(diffs: readonly string[]): string[] {
  return diffs.filter((d) => !Object.keys(G1_EXPECTED).some((m) => d.includes(` ${m}: $`)));
}

/** Where a difference is (`conn 0, response to #3 memory.recall: $.result.x`), without its values. */
export function diffPath(d: string): string {
  return d.replace(/: (?:expected|missing|unexpected)[\s\S]*$/, "");
}

/** The differences in `frontDoor` at a place where two stock TypeScript cores (`control`) differ too are the noise of the
 *  real clock and of random values (keys, codes, file names); what is left is the front door's. */
export function beyondFloor(frontDoor: readonly string[], control: readonly string[]): string[] {
  const floor = new Set(control.map(diffPath));
  return frontDoor.filter((d) => !floor.has(diffPath(d)));
}

export async function g1(legs: readonly [CoreImpl, CoreImpl] = ["ts", "rust"]): Promise<{ sent: number; excluded: string[]; diffs: string[] }> {
  const home = parityHome();
  const ts = await fixturesOn(legs[0], home);
  const rust = await fixturesOn(legs[1], home);
  return { sent: ts.filter((l) => l.dir === "in").length, excluded: Object.keys(G1_EXCLUDED), diffs: compareTranscripts(ts, rust).diffs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
  type Floored = { control?: string[]; beyondFloor?: string[] };
  const report: { transcripts: Array<PairResult & Floored>; g1?: Awaited<ReturnType<typeof g1>> & Floored & { expected: string[] } } = { transcripts: [] };
  let failed = 0;
  const control = args.includes("--control"), floor = args.includes("--floor");
  const legs: [CoreImpl, CoreImpl] = control ? ["ts", "ts"] : ["ts", "rust"];
  // `--floor`: a transcript (or G1) with differences is replayed on two stock TypeScript cores as well, and only the
  // differences at places where those two agree count (`beyondFloor`).
  for (const file of files) {
    const r: PairResult & Floored = await replayBoth(file, legs);
    if (floor && !control && !r.error && r.frontDoor.length) {
      r.control = (await replayBoth(file, ["ts", "ts"])).frontDoor;
      r.beyondFloor = beyondFloor(r.frontDoor, r.control);
    }
    report.transcripts.push(r);
    const counted = r.beyondFloor ?? r.frontDoor;
    const ok = !r.error && counted.length === 0;
    if (!ok) failed++;
    const noise = r.beyondFloor ? `, ${r.frontDoor.length - r.beyondFloor.length} at the noise floor` : "";
    console.log(`${ok ? "ok  " : "FAIL"} ${basename(file)}${r.error ? ` (${r.error})` : ""} [vs recording: ${r.vsRecording} diffs${noise}]`);
    for (const d of counted.slice(0, 20)) console.log(`       ${d}`);
  }
  if (args.includes("--g1")) {
    const g = await g1(legs);
    const diffs = withoutExpected(g.diffs);
    const result: NonNullable<typeof report.g1> = { ...g, diffs, expected: g.diffs.filter((d) => !diffs.includes(d)) };
    if (floor && !control && diffs.length) { result.control = (await g1(["ts", "ts"])).diffs; result.beyondFloor = beyondFloor(diffs, result.control); }
    report.g1 = result;
    const counted = result.beyondFloor ?? diffs;
    const noise = result.beyondFloor ? `, ${diffs.length - result.beyondFloor.length} at the noise floor` : "";
    console.log(`G1: ${g.sent} method fixtures through both legs, excluded ${g.excluded.join(", ")}; ${counted.length} diffs${noise}; expected (${Object.keys(G1_EXPECTED).join(", ")}): ${result.expected.length}`);
    for (const d of counted) console.log(`       ${d}`);
    if (counted.length) failed++;
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}

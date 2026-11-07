// P4-10 acceptance, modes T and G1: the front door must add nothing. Each transcript is replayed against the TypeScript
// core and against the front door with the legacy core behind it, and the two replays are compared (times, pids and uuids
// masked; the free text of E_INVALID_PARAMS masked by the controller ruling). The comparison against the recording itself
// is reported too, for information: a recording made from a test with its own seams (fake providers, an injected RBAC)
// differs from any stock core in the same way on both legs.
// G1: every contract method fixture (packages/rpc-schema/fixtures/methods) is sent with its params, in one owner session,
// to both legs, and the responses are compared.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/p4-10-parity.ts \
//        [--g1] [--json <out>] [transcript.ndjson ...]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rawConnect } from "./raw-client.ts";
import { replayTranscript } from "./replay.ts";
import { startTarget, type CoreImpl } from "./target.ts";
import { compareTranscripts, parseTranscript, type TranscriptLine } from "./transcript.ts";

export interface PairResult { file: string; frontDoor: string[]; vsRecording: number; error?: string }

/** Replays one transcript on both legs and compares the replays. */
export async function replayBoth(file: string): Promise<PairResult> {
  const expected = parseTranscript(readFileSync(file, "utf8"));
  const run = async (impl: CoreImpl) => {
    const target = await startTarget(impl);
    try { return await replayTranscript(expected, { address: target.address, token: target.token, responseTimeoutMs: 15_000, notificationTimeoutMs: 1500 }); }
    finally { await target.stop(); }
  };
  try {
    const ts = await run("ts");
    const rust = await run("rust");
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
async function fixturesOn(impl: CoreImpl): Promise<TranscriptLine[]> {
  const target = await startTarget(impl);
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

export async function g1(): Promise<{ sent: number; excluded: string[]; diffs: string[] }> {
  const ts = await fixturesOn("ts");
  const rust = await fixturesOn("rust");
  return { sent: ts.filter((l) => l.dir === "in").length, excluded: Object.keys(G1_EXCLUDED), diffs: compareTranscripts(ts, rust).diffs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
  const report: { transcripts: PairResult[]; g1?: Awaited<ReturnType<typeof g1>> } = { transcripts: [] };
  let failed = 0;
  for (const file of files) {
    const r = await replayBoth(file);
    report.transcripts.push(r);
    const ok = !r.error && r.frontDoor.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${basename(file)}${r.error ? ` (${r.error})` : ""} [vs recording: ${r.vsRecording} diffs]`);
    for (const d of r.frontDoor.slice(0, 20)) console.log(`       ${d}`);
  }
  if (args.includes("--g1")) {
    report.g1 = await g1();
    console.log(`G1: ${report.g1.sent} method fixtures through both legs, excluded ${report.g1.excluded.join(", ")}; ${report.g1.diffs.length} diffs`);
    for (const d of report.g1.diffs) console.log(`       ${d}`);
    if (report.g1.diffs.length) failed++;
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}

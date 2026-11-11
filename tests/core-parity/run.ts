// Replays recorded transcripts against a core and prints a readable diff.
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/run.ts \
//        [--impl ts|rust] [--strict-order] [transcript.ndjson ...]      (default: every file in transcripts/)
// PLUR1BUS_CORE_IMPL selects the implementation when --impl is absent. `rust` fails until plur1bus-core exists (P4-03/P4-10).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTranscript } from "./replay.ts";
import { TRANSCRIPT_DIR } from "./record.ts";
import { coreImplFromEnv, startTarget, type CoreImpl } from "./target.ts";
import { compareTranscripts, parseTranscript, type CompareOptions } from "./transcript.ts";

export interface RunResult { file: string; ok: boolean; diffs: string[] }

/** Replays each transcript against a fresh core of `impl`. */
export async function runTranscripts(files: readonly string[], opts: { impl?: CoreImpl } & CompareOptions = {}): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const file of files) {
    const expected = parseTranscript(readFileSync(file, "utf8"));
    const target = await startTarget(opts.impl ?? coreImplFromEnv());
    try {
      const actual = await replayTranscript(expected, { address: target.address, token: target.token });
      results.push({ file, ...compareTranscripts(expected, actual, opts) });
    } finally { await target.stop(); }
  }
  return results;
}

export const recordedTranscripts = (dir = TRANSCRIPT_DIR): string[] => readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort().map((f) => join(dir, f));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const impl = args.includes("--impl") ? args[args.indexOf("--impl") + 1] as CoreImpl : coreImplFromEnv();
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--impl");
  let failed = 0;
  try {
    for (const r of await runTranscripts(files.length ? files : recordedTranscripts(), { impl, strictOrder: args.includes("--strict-order") })) {
      console.log(`${r.ok ? "ok  " : "FAIL"} ${basename(r.file)}`);
      for (const d of r.diffs) console.log(`       ${d}`);
      if (!r.ok) failed++;
    }
  } catch (e) { console.error(`core-parity: ${(e as Error).message}`); process.exit(2); }
  process.exit(failed ? 1 : 0);
}

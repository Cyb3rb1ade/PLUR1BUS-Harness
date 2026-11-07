// Records the flows of flows.ts against the TypeScript core into tests/core-parity/transcripts/<flow>.ndjson.
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/record.ts [flow ...]
// Transcripts are produced by this script and never edited by hand.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOWS, runFlow } from "./flows.ts";
import { startTarget } from "./target.ts";

export const TRANSCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "transcripts");

/** Records one flow into `file` against a fresh `ts` core. */
export async function recordFlow(name: string, file: string): Promise<void> {
  const flow = FLOWS.find((f) => f.name === name);
  if (!flow) throw new Error(`unknown flow ${name}; known: ${FLOWS.map((f) => f.name).join(", ")}`);
  const target = await startTarget("ts", { env: { PLUR1BUS_PARITY_RECORD: file } });
  try { await runFlow(flow, target); } finally { await target.stop(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const names = process.argv.slice(2);
  for (const flow of FLOWS.filter((f) => names.length === 0 || names.includes(f.name))) {
    await recordFlow(flow.name, join(TRANSCRIPT_DIR, `${flow.name}.ndjson`));
    console.log(`recorded ${flow.name}`);
  }
  process.exit(0);
}

// Entry of dist/import.js (docs/import.md §8.1): one importer run, one envelope line on stdout. Spawned by
// `plur1bus import`; never part of the core process.
import { runImport } from "./import/cli.ts";

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
const envelope = await runImport(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(envelope)}\n`, () => process.exit(envelope.exit ?? 0));

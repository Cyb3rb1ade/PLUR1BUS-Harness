/** Runs only the selected pinned-Node recorder; fixtures are never authored by hand. */
const modes = new Map([
  ["--keys", "./record-keys.mjs"],
  ["--queue", "./record-queue.mjs"],
  ["--accept", "./record-accept.mjs"],
  ["--epistemic", "./record-epistemic.mjs"],
]);
const args = process.argv.slice(2);
if (args.length !== 1 || !modes.has(args[0])) {
  throw new Error("Select exactly one recorder: --keys, --queue, --accept, or --epistemic");
}
await import(modes.get(args[0]));

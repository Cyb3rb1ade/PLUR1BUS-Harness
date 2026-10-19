// Test double for packages/core/dist/import.js (crates/plur1bus/tests/import.rs): answers one envelope line that
// echoes its argv, or an error envelope / a crash, per FAKE_IMPORT_MODE.
const argv = process.argv.slice(2);
const mode = process.env.FAKE_IMPORT_MODE ?? "ok";
if (mode === "crash") { process.stderr.write("fake importer crashed\n"); process.exit(7); }
const schema = argv[0] === "backfill" ? "import.backfill/1" : (argv.includes("--detect") ? "import.detect/1" : `import.${argv[0]}/1`);
const env = mode === "error"
  ? { ok: false, error: "E_SOURCE_UNSUPPORTED", message: "fake refusal", reason: "version-undeterminable", exit: 2 }
  : { ok: true, schema, value: { argv }, human: "FAKE HUMAN SUMMARY" };
process.stdout.write(`diagnostic noise\n${JSON.stringify(env)}\n`);
process.exit(env.ok ? 0 : env.exit);

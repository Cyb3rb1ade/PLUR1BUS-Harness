import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const files = globSync("test/**/*.test.ts");
if (files.length === 0) { console.log("no tests"); process.exit(0); }
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);

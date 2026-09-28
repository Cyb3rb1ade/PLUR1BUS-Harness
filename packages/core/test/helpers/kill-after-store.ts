// A core that SIGKILLs its own process the moment the engine reports a stored row ("stored memory ..."): that log call
// runs right after the row's LanceDB commit resolved, before the capture's post-store steps. Started on a home with a
// journal, it dies while replaying the first line, the way a kill soak's SIGKILL can land (core.test.ts).
// Just before the kill it writes <home>/killed-at-store: on Windows there are no signals (process.kill terminates with
// exit code 1), so the marker is how the test tells this kill from any other exit.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLogger } from "../../src/logger.ts";
import { createCore } from "../../src/core.ts";
import { flatTestInternals } from "./flat-embedder.ts";

function killingLogger(): HarnessLogger {
  const log = (m: string) => {
    if (!/stored memory/.test(m)) return;
    writeFileSync(path.join(process.argv[2]!, "killed-at-store"), `${process.pid}\n`);
    process.kill(process.pid, "SIGKILL");
  };
  const l: HarnessLogger = {
    debug: log, info: log, warn: log, error: log,
    child: () => l, setLevel: () => {}, setRotation: () => {}, close: async () => {},
  };
  return l;
}

const core = createCore({ home: process.argv[2]!, testInternals: flatTestInternals(), logger: killingLogger() });
await core.start();
process.stdout.write("ready\n");
setInterval(() => {}, 1000);

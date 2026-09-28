// A core that SIGKILLs its own process the moment the engine reports a stored row ("stored memory ..."): that log call
// runs right after the row's LanceDB commit resolved, before the capture's post-store steps. Started on a home with a
// journal, it dies while replaying the first line, the way a kill soak's SIGKILL can land (core.test.ts).
import type { HarnessLogger } from "../../src/logger.ts";
import { createCore } from "../../src/core.ts";
import { flatTestInternals } from "./flat-embedder.ts";

function killingLogger(): HarnessLogger {
  const log = (m: string) => { if (/stored memory/.test(m)) process.kill(process.pid, "SIGKILL"); };
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

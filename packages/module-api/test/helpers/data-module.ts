// A12's real module entry observes its context and persistent files without changing the public fixture module.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runModule } from "../../src/runtime.ts";

await runModule({
  async start(ctx) {
    const dataDir = "dataDir" in ctx && typeof ctx.dataDir === "string" ? ctx.dataDir : null;
    const marker = dataDir === null ? null : path.join(dataDir, "kept.txt");
    const previous = marker !== null && existsSync(marker) ? readFileSync(marker, "utf8") : null;
    if (marker !== null) writeFileSync(marker, "persistent module data", { mode: 0o600 });
    ctx.setDetail({ dataDir, previous });
    return { async stop() {} };
  },
});

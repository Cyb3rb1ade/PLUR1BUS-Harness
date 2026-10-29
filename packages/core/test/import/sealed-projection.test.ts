/** An uploaded or standalone snapshot cannot smuggle credential values through its claimed metadata fields. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "../../src/import/source.ts";
import { verifySourceSnapshot } from "../../src/import/snapshot-source.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const MARKER = "fixture-forged-snapshot-value-never-in-cli-report";

describe("sealed source metadata projection", () => {
  it("keeps only key names and forms from a forged credential metadata object in verifier and actual CLI source read", async () => {
    const home = temp();
    const root = join(home, "import", "forged", "snapshot");
    mkdirSync(root, { recursive: true });
    const config = Buffer.from('{"meta":{"lastTouchedVersion":"2026.9.5"}}');
    writeFileSync(join(root, "openclaw.json"), config);
    writeFileSync(join(root, "snapshot.json"), JSON.stringify({ version: 1, source: "openclaw", sourceRoot: "/old/source",
      sourceHome: "/old", origin: "native", flavour: "posix", timestamp: new Date().toISOString(),
      files: [{ path: "openclaw.json", size: config.length, sha256: createHash("sha256").update(config).digest("hex") }],
      sqlite: {}, envKeys: {}, omittedConfigKeys: [{ path: "provider.apiKey", form: "inline", value: MARKER }] }));
    const verified = verifySourceSnapshot(root, home);
    assert.deepEqual(verified?.configKeys, [{ path: "provider.apiKey", form: "inline" }]);
    const result = await readSource({ sourceType: "openclaw", source: root, home, env: {}, homedir: home });
    assert.deepEqual(result.report.secrets.configKeys, [{ path: "provider.apiKey", form: "inline" }]);
    assert.equal(JSON.stringify(result.report).includes(MARKER), false);
  });
});

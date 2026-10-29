// A13 full import/rollback behavior with an injected native package-store port.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { importExtensions } from "../../src/import/extensions-import.ts";
import { parseImportedMcpConfig } from "../../src/import/mcp-config.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { treeDigest, treeEntries } from "./tree.ts";

const MARKER = "A13_IMPORT_SECRET_NEVER_PERSISTED";

function fixture(sourceType: "openclaw" | "hermes") {
  const source = tempDir("p1b-a13-full-source-");
  const home = tempDir("p1b-a13-full-home-");
  if (sourceType === "openclaw") writeFileSync(join(source, "openclaw.json"), JSON.stringify({
    meta: { lastTouchedVersion: "2026.9.21" }, mcp: { servers: { search: {
      command: "npx", args: [MARKER], env: { TOKEN: MARKER }, trust: MARKER, package: MARKER,
    } } },
  }));
  else writeFileSync(join(source, "config.yaml"), `_config_version: 45\nmcp_servers:\n  search:\n    command: uvx\n    args: ["${MARKER}"]\n    env:\n      TOKEN: ${MARKER}\n`);
  return { source, home, run: sourceType === "openclaw" ? importOpenclaw : importHermes };
}

describe("full importer extension receipts (A13)", () => {
  for (const sourceType of ["openclaw", "hermes"] as const) {
    it(`${sourceType} plans without writes, persists only bound receipts, resumes and rolls back`, async () => {
      const { source, home, run } = fixture(sourceType);
      const installed = new Map<string, any>();
      let installs = 0;
      let plans = 0;
      const port = {
        async plan() { plans++; return { action: "install" as const }; },
        async install(candidate: any, runId: string) {
          installs++;
          assert.equal(JSON.stringify(candidate).includes(MARKER), false);
          const receipt = { schema: "import.extension-receipt/1" as const, name: candidate.name,
            fingerprint: candidate.fingerprint, installationId: candidate.fingerprint };
          installed.set(runId, receipt);
          return { ...receipt, ignoredSourceMetadata: MARKER };
        },
        async rollback(receipt: any) {
          assert.deepEqual(receipt, [...installed.values()][0]);
          installed.clear();
        },
      };
      const before = treeDigest(home);
      const dry = await run({ source, home, extensionPort: port } as any);
      assert.equal(plans, 1);
      assert.equal(installs, 0);
      assert.equal(treeDigest(home), before);
      assert.equal("extensions" in dry, false);

      const report = await run({ source, home, apply: true, extensionPort: port } as any);
      assert.equal(installs, 1);
      const sidecar = join(home, "imports", report.runId, "extensions.json");
      const text = readFileSync(sidecar, "utf8");
      const metadata = JSON.parse(text);
      assert.equal(metadata.schema, "import.extensions/1");
      assert.equal(metadata.runId, report.runId);
      assert.equal(metadata.entries[0].status, "installed");
      assert.equal(text.includes(MARKER), false);
      for (const file of ["report.json", "ledger.jsonl"]) {
        assert.equal(readFileSync(join(home, "imports", report.runId, file), "utf8").includes(MARKER), false);
      }
      await run({ source, home, apply: true, resume: report.runId, extensionPort: port } as any);
      assert.equal(installs, 1);

      const data = join(home, "data", "ext", metadata.entries[0].name);
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "keep.txt"), "retained data");
      // Acquiring/releasing the existing target lock changes only its parent-directory mtime.
      const targetBefore = treeEntries(home, { mtime: false });
      await assert.rejects(rollbackImport({ home, reportPath: report.reportPath!, sourceType, apply: true }),
        (error: any) => error.reason === "extension-port-required");
      assert.deepEqual(treeEntries(home, { mtime: false }), targetBefore);
      await rollbackImport({ home, reportPath: report.reportPath!, sourceType, apply: false, extensionPort: port } as any);
      assert.equal(installed.size, 1);
      await rollbackImport({ home, reportPath: report.reportPath!, sourceType, apply: true, extensionPort: port } as any);
      assert.equal(installed.size, 0);
      assert.equal(readFileSync(join(data, "keep.txt"), "utf8"), "retained data");
      assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).entries[0].status, "rolled-back");
    });
  }

  it("does not replace or roll back existing/conflicting packages", async () => {
    const { source, home, run } = fixture("openclaw");
    for (const action of ["existing", "conflict"] as const) {
      const port = { async plan() { return { action }; },
        async install() { assert.fail("preexisting package must not be installed"); },
        async rollback() { assert.fail("preexisting package must not be rolled back"); } };
      const report = await run({ source, home, apply: true, extensionPort: port } as any);
      const metadata = JSON.parse(readFileSync(join(home, "imports", report.runId, "extensions.json"), "utf8"));
      assert.equal(metadata.entries[0].status, action);
      await rollbackImport({ home, reportPath: report.reportPath!, sourceType: "openclaw", apply: true, extensionPort: port } as any);
    }
  });

  it("refuses a malformed receipt before persisting arbitrary port metadata", async () => {
    const { source, home, run } = fixture("openclaw");
    const port = { async plan() { return { action: "install" }; },
      async install() { return { schema: "import.extension-receipt/1", name: MARKER, fingerprint: MARKER, installationId: MARKER }; },
      async rollback() {} };
    await assert.rejects(run({ source, home, apply: true, extensionPort: port } as any),
      (error: any) => error.reason === "extension-receipt-invalid" && !String(error).includes(MARKER));
    assert.equal(existsSync(join(home, "extensions.json")), false);
  });

  it("refuses sidecar growth beyond the count limit before calling the native port", async () => {
    const home = tempDir("p1b-a13-full-limit-");
    const runId = "bounded-run";
    const dir = join(home, "imports", runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "extensions.json");
    const metadata = { schema: "import.extensions/1", runId, entries: Array.from({ length: 256 }, (_, i) => ({
      name: `existing-${i}`, fingerprint: "a".repeat(64), status: "existing",
    })) };
    writeFileSync(path, JSON.stringify(metadata));
    const before = readFileSync(path, "utf8");
    const candidates = parseImportedMcpConfig({ source: "hermes", config: { mcp_servers: { extra: {} } } });
    const port = { async plan() { assert.fail("limit must be checked before native work"); },
      async install() { assert.fail(); }, async rollback() { assert.fail(); } };
    await assert.rejects(importExtensions({ home, runId, apply: true, candidates, port }),
      (error: any) => error.reason === "extension-source-limit");
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

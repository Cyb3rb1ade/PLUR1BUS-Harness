/** Shared foreign-format fixture for host snapshot integration tests; names stay at the importer boundary. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceType } from "../../src/import/types.ts";

/** Write the smallest supported source config and return its importer family. The caller owns cleanup. */
export function writeDesktopSourceConfig(root: string): SourceType {
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.21" } }));
  return "openclaw";
}

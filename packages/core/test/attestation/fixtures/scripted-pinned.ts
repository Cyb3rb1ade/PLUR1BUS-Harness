// The scripted helper (`scripted-attest.mjs`) behind a pinnable launcher, the same way `pinned-fake.ts` runs `fake-attest.mjs`: an
// owner-only script in a private (0700) mkdtemp directory. `process.execPath` is never the helper (see pinned-fake.ts).
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperSpec } from "../../../src/attestation/index.ts";

const SCRIPT = fileURLToPath(new URL("./scripted-attest.mjs", import.meta.url));
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A pinnable `HelperSpec` that answers each request with `reply` (see scripted-attest.mjs for the placeholders). */
export function scriptedHelper(reply: Record<string, unknown>, env: Record<string, string> = {}): HelperSpec {
  const merged = { ATTEST_REPLY: JSON.stringify(reply), ...env };
  if (process.platform === "win32") return { path: process.execPath, args: [SCRIPT], env: merged };
  const dir = mkdtempSync(join(tmpdir(), "att-scripted-"));
  const path = join(dir, "plur1bus-attest");
  writeFileSync(path, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(SCRIPT)} "$@"\n`);
  chmodSync(path, 0o700);
  return { path, env: merged };
}

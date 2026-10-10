// The core only runs a helper it can pin (helperPinned): owned by root or by us, not group/world-writable, in a directory that is
// not either. `process.execPath` fails that on CI runners and distro installs (the Node binary belongs to someone else), and a
// helper in the shared temp directory would fail it by design. So the fake helper is run through a launcher of its own in a
// private (0700) directory: an owner-only script that execs Node on fake-attest.mjs. The production pin stays exactly as strict.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperSpec } from "../../../src/attestation/index.ts";

const FAKE = fileURLToPath(new URL("./fake-attest.mjs", import.meta.url));
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A pinnable `HelperSpec` that behaves as `fake-attest.mjs <mode> [arg]` for the `--attest` / `--probe` flags. */
export function fakeHelper(mode: string, arg?: string): HelperSpec {
  const args = [FAKE, mode, ...(arg !== undefined ? [arg] : [])];
  if (process.platform === "win32") return { path: process.execPath, args }; // the pin only checks "regular file" there
  const dir = mkdtempSync(join(tmpdir(), "att-helper-")); // mkdtemp creates it 0700, owned by us
  const path = join(dir, "plur1bus-attest");
  writeFileSync(path, `#!/bin/sh\nexec ${sh(process.execPath)} ${args.map(sh).join(" ")} "$@"\n`);
  chmodSync(path, 0o700);
  return { path };
}

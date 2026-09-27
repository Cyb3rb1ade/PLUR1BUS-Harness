// Temp directories that a test file removes when its tests are done: `tempDir(prefix)` is `mkdtempSync` under the OS
// temp dir, and a file-level `after` hook (registered once, when this module is imported) removes every directory it
// handed out. Removal is best effort — a directory a still-running child holds open on Windows is left behind rather
// than failing the file.
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

after(() => {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
});

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

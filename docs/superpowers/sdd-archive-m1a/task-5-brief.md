### Task 5 (PR-01b): route the eight chmod sites and the `HOME` bug through `lib/platform.js`

Behaviour-neutral on POSIX by construction: `securePath(p, { mode })` with `platform !== "win32"` is exactly `chmodSync(p, mode)`.

**Files** (every line verified at `89148f9`; re-derive with Grep before editing):
- Modify: `lib/providers/scoped-embedding-ipc.js:153` (`chmodSync(tokenPath, 0o600)`), `:279` (`chmodSync(directory, 0o700)`), `:435` (`chmodSync(paths.socketPath, 0o600)`), and the `chmodSync` entry in the `node:fs` import at `:3`
- Modify: `lib/shared-memory-migration.js:216` (`fchmodSync(fd, 0o600)`) and the `fchmodSync` import at `:5`
- Modify: `lib/workspace-policy.js:98` (`chmodSync(statePath, 0o600)`) and the import at `:4`
- Modify: `lib/model-preparation/state-store.js:130` (`chmodSync(path, 0o600)`) and the import at `:2`
- Modify: `lib/reembedding/lance-backend.js:126` (`chmodSync(path, 0o600)`) and the import at `:3`
- Modify: `lib/reembedding/state-store.js:179` (`chmodSync(statePath, 0o600)`) and the import at `:2`
- Modify: `lib/llm-result-cache.js:225` — the injectable default parameter `chmodFile = chmodSync`; and the import at `:7`
- Modify: `lib/providers/openclaw-memory-embedding-adapters.js:56` — `process.env.HOME` → `homedir()` (host-contract §f.2)
- Create: `tests/platform-callsites.test.js`

**Interfaces:**
- Consumes: `securePath` from Task 4.
- Produces: no new exported names. `lib/llm-result-cache.js` keeps its injectable seam, but its default becomes a `securePath` wrapper rather than `chmodSync` directly.

**Exact edits.**

1. **The six plain `chmodSync(path, mode)` sites** — `scoped-embedding-ipc.js:153`, `:279`, `:435`, `workspace-policy.js:98`, `model-preparation/state-store.js:130`, `reembedding/lance-backend.js:126`, `reembedding/state-store.js:179`. In each file add the import (relative depth differs per file: `./platform.js` from `lib/`, `../platform.js` from `lib/providers/`, `lib/reembedding/`, `lib/model-preparation/`):

```js
import { securePath } from "../platform.js";
```

and replace the call, e.g. at `lib/workspace-policy.js:98`:

```js
    securePath(statePath, { mode: 0o600 });
```

at `lib/providers/scoped-embedding-ipc.js:279`:

```js
  securePath(directory, { mode: 0o700 });
```

Then delete `chmodSync` from that file's `node:fs` import list if nothing else in the file uses it (check with `grep -n chmodSync <file>` after the edit; leave the import if another use remains).

2. **The `fchmodSync` site**, `lib/shared-memory-migration.js:216`. `securePath` takes the descriptor for the race-free POSIX path and the path for the Windows ACL:

```js
        securePath(tempPath, { mode: 0o600, fd });
```

Then remove `fchmodSync` from the `node:fs` import at `:5` and add `import { securePath } from "./platform.js";`.

3. **The injectable seam**, `lib/llm-result-cache.js:225`. The parameter name and call shape stay so every existing caller and test keeps working; only the default changes:

```js
  chmodFile = (path, mode) => { securePath(path, { mode }); },
```

Add `import { securePath } from "./platform.js";` and drop `chmodSync` from the `node:fs` import at `:7` if unused afterwards.

4. **The `HOME` bug**, `lib/providers/openclaw-memory-embedding-adapters.js:56`. Before:

```js
function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(process.env.HOME || ".", ".openclaw");
}
```

After (add `homedir` to the existing `node:os` import, or add `import { homedir } from "node:os";` if the file has none):

```js
function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}
```

Leave `lib/providers/env.js:10` alone: it is a *declaration* of the environment contract read by the config tooling, not a path used to write a file, and changing it is PR-11's business.

- [ ] **Step 1: Write the failing call-site test**

Create `tests/platform-callsites.test.js`:

```js
/**
 * tests/platform-callsites.test.js — PR-01b.
 *
 * Two guards that survive later refactors: no module writes a
 * permission with a raw fs chmod any more, and the embedding cache
 * directory no longer falls back to $HOME (host-contract f.2/f.9).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTED = [
  "lib/providers/scoped-embedding-ipc.js",
  "lib/shared-memory-migration.js",
  "lib/workspace-policy.js",
  "lib/model-preparation/state-store.js",
  "lib/reembedding/lance-backend.js",
  "lib/reembedding/state-store.js",
  "lib/llm-result-cache.js",
];

describe("PR-01b platform call sites", () => {
  for (const relative of ROUTED) {
    it(`${relative} secures permissions through lib/platform.js`, () => {
      const source = readFileSync(join(root, relative), "utf8");
      assert.match(source, /from "\.{1,2}\/platform\.js"/, `${relative} must import lib/platform.js`);
      assert.doesNotMatch(source, /\bchmodSync\s*\(/, `${relative} must not call chmodSync directly`);
      assert.doesNotMatch(source, /\bfchmodSync\s*\(/, `${relative} must not call fchmodSync directly`);
    });
  }

  it("the embedding adapter resolves the home directory with os.homedir()", () => {
    const source = readFileSync(join(root, "lib/providers/openclaw-memory-embedding-adapters.js"), "utf8");
    assert.doesNotMatch(source, /process\.env\.HOME/, "HOME is unset on Windows; use homedir()");
    assert.match(source, /homedir\(\)/);
  });

  it("no module outside lib/platform.js calls chmodSync or fchmodSync", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("grep", [
      "-rn", "--include=*.js", "-E", "\\b(f?chmodSync)\\s*\\(", "lib", "index.js",
    ], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean)
      .filter((line) => !line.startsWith("lib/platform.js:"));
    assert.deepEqual(out, [], `unrouted chmod call sites:\n${out.join("\n")}`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform-callsites.test.js 2>&1 | tail -15
```

Expected: 8 failures — the seven routed files plus the `HOME` assertion.

- [ ] **Step 3: Apply the eight edits described above**

Work one file at a time. After each file:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check <the file you just edited>
```

- [ ] **Step 4: Run the call-site test and watch it pass**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform-callsites.test.js 2>&1 | tail -8
```

Expected: `tests 9`, `pass 9`, `fail 0`.

- [ ] **Step 5: Run the tests that own those files**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/platform.test.js \
  tests/scoped-embedding-ipc.test.js \
  tests/workspace-policy*.test.js \
  tests/llm-result-cache*.test.js \
  tests/reembedding*.test.js 2>&1 | tail -10
```

Expected: all pass. (If a glob matches no file, drop it — the suite run in Step 6 is the real gate.)

- [ ] **Step 6: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add lib tests/platform-callsites.test.js
git commit -m "fix(platform): route every chmod site and the HOME fallback through lib/platform.js

PR-01b. Closes host-contract f.9 (chmod is not a permission on Windows) and
f.2 (process.env.HOME is unset on Windows, so the model cache landed in the
CWD). No behaviour change on POSIX: securePath with platform !== win32 is
chmodSync. lib/llm-result-cache.js keeps its injectable chmodFile seam."
```

---


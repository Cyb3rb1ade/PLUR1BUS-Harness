### Task 2: Golden-prefix byte-identity regression test

**Files:**
- Create: `tests/golden-prefix.test.js`

**Interfaces:**
- Consumes: `SCENARIOS` from `tests/fixtures/golden-prefix/scenarios.js`, `runScenario` from `tests/helpers/golden-prefix-driver.js` (Task 1).
- Produces: the check every later task runs — `node --test --test-concurrency=1 tests/golden-prefix.test.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/golden-prefix.test.js`:

```js
/**
 * tests/golden-prefix.test.js
 *
 * The behaviour-neutrality gate for the engine extraction: every scenario's
 * prependContext must stay byte-identical to the oracle captured on main
 * @ 89148f9. If this fails, the refactor changed what the model sees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-prefix", "expected");

describe("golden prefix corpus", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} produces the recorded prependContext byte for byte`, async () => {
      const expected = readFileSync(join(expectedDir, `${scenario.name}.txt`), "utf8");
      const actual = await runScenario(scenario);
      assert.equal(typeof actual, "string", `${scenario.name} returned no prependContext`);
      assert.equal(actual, expected);
    });
  }

  it("is deterministic across two fresh registrations", async () => {
    const scenario = SCENARIOS[0];
    const first = await runScenario(scenario);
    const second = await runScenario(scenario);
    assert.equal(first, second);
  });

  it("covers at least five scenarios", () => {
    assert.ok(SCENARIOS.length >= 5, `expected >= 5 scenarios, found ${SCENARIOS.length}`);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes against the oracle**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
```

Expected: `pass 7`, `fail 0` (5 scenarios + determinism + count).

- [ ] **Step 3: Prove the test can fail**

Temporarily append one character to the oracle and confirm the gate trips:

```bash
cd "$PLUR1BUS" && printf 'X' >> tests/fixtures/golden-prefix/expected/recall-basic.txt
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js; echo "exit=$?"
cd "$PLUR1BUS" && git checkout -- tests/fixtures/golden-prefix/expected/recall-basic.txt
```

Expected: the middle command reports `fail 1` on `recall-basic …` and `exit=1`; the third restores the oracle. Re-run step 2 and confirm it is green again before committing.

- [ ] **Step 4: Full suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: accepted baseline (2 failures).

- [ ] **Step 5: Commit**

```bash
cd "$PLUR1BUS"
git add tests/golden-prefix.test.js
git commit -m "test: assert the golden prefix corpus is byte-identical

Run after every extraction task: node --test --test-concurrency=1 tests/golden-prefix.test.js"
```

---


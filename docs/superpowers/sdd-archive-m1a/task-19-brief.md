### Task 19: `bench/recall-budget-probe.mjs` — answer B6 from data

Owner decision B6 reads *"40/60"*, interpreted as **soft 400 ms / hard 600 ms**, and both `decisions-for-owner.md` and ADR-002 Q2 say the same thing twice: **measure today's pipeline first**. Today's values are soft 35 000 ms (`index.js:4711`) and hard 50 000 ms (`index.js:13351`). This task produces the distribution.

**Files:**
- Create: `bench/recall-budget-probe.mjs`
- Modify: `tests/helpers/golden-prefix-driver.js` — add a `{ freezeClock }` option to `runScenario`

**Interfaces:**
- Consumes: `SCENARIOS` and `runScenario` (Task 1).
- Produces: `node bench/recall-budget-probe.mjs [--iterations N] [--scale M]` printing p50/p95/p99 per scenario and per phase.

**Why the driver needs an option.** `freezeClock()` pins `Date.now()`, which is exactly wrong for a latency measurement — the internal soft-budget check (`phaseTimer.isSoftBudgetExceeded()`, `lib/recall-phase-timer.js:95-97`) would always read 0 ms elapsed. The probe therefore runs with the real clock. Measurement uses `performance.now()`, which `mock`-free `freezeClock` never touched anyway.

**What the numbers mean, and what they do not.** With a stub embedder, no reranker and a two-card fixture store, this is the pipeline's **floor** — orchestration, LanceDB open, context formatting — not the owner's distribution. It is still the right first number, because if the floor already exceeds 400 ms the budget question is answered before any provider is involved. The probe prints that caveat and supports `--scale` to grow the fixture corpus. **The owner must re-run this against their own store before PR-04 fixes the budget.**

- [ ] **Step 1: Add the clock option to the driver**

In `tests/helpers/golden-prefix-driver.js`, change the signature and the first line of `runScenario`:

```js
/**
 * @param {object} scenario
 * @param {{freezeClock?: boolean}} [options] `freezeClock: false` keeps the real
 *   clock, which the latency probe needs; the golden test leaves it on.
 * @returns {Promise<string|null>} the exact prependContext, or null.
 */
export async function runScenario(scenario, { freezeClock: useFrozenClock = true } = {}) {
  const restoreClock = useFrozenClock ? freezeClock() : () => {};
```

Everything else is unchanged; `restoreClock()` in the `finally` still runs.

- [ ] **Step 2: Confirm the golden test is unaffected**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -8
```

Expected: `pass 7`, `fail 0` — the default is still a frozen clock.

- [ ] **Step 3: Write the probe**

Create `bench/recall-budget-probe.mjs`:

```js
/**
 * bench/recall-budget-probe.mjs — measure today's recall latency (owner B6).
 *
 * ADR-002 Q2 and decisions-for-owner B6 both say the 400/600 ms budget must be
 * set from data, not taste. Today's values are soft 35 000 ms (index.js:4711)
 * and hard 50 000 ms (index.js:13351).
 *
 * Runs the golden-prefix scenarios N times each with the REAL clock and a
 * deterministic offline embedder, and prints p50/p95/p99 of the whole
 * before_prompt_build call plus of the two phases this harness can observe:
 * embedding and store access.
 *
 * Usage:
 *   node bench/recall-budget-probe.mjs                 # 30 iterations
 *   node bench/recall-budget-probe.mjs --iterations 100
 *   node bench/recall-budget-probe.mjs --scale 50      # 50x the fixture cards
 */

import { performance } from "node:perf_hooks";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const iterations = flag("iterations", 30);
const scale = flag("scale", 1);

/** Same definition bench/report.mjs:20 uses, so the numbers are comparable. */
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const fmt = (n) => `${n.toFixed(1)} ms`;

/** Grow a scenario's card count without changing what it recalls. */
function scaled(scenario) {
  if (scale <= 1 || scenario.memories.length === 0) return scenario;
  const memories = [];
  for (let copy = 0; copy < scale; copy += 1) {
    for (const [index, memory] of scenario.memories.entries()) {
      memories.push(copy === 0 ? memory : {
        ...memory,
        id: `${copy.toString(16).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`,
        text: `${memory.text} (variant ${copy})`,
        ageDays: (memory.ageDays ?? 1) + copy,
      });
    }
  }
  const topics = { ...scenario.topics };
  for (const memory of memories) topics[memory.text] = topics[memory.text] ?? scenario.topics[memory.text.replace(/ \(variant \d+\)$/, "")];
  return { ...scenario, memories, topics };
}

/** Count time spent inside the embedding provider, across all call sites. */
function instrumentEmbedder() {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originals = { embedQuery: proto.embedQuery, embedPassage: proto.embedPassage };
  const totals = { embedMs: 0, calls: 0 };
  for (const name of ["embedQuery", "embedPassage"]) {
    const original = proto[name];
    proto[name] = async function instrumented(...args) {
      const started = performance.now();
      try {
        return await original.apply(this, args);
      } finally {
        totals.embedMs += performance.now() - started;
        totals.calls += 1;
      }
    };
  }
  return {
    totals,
    restore() { proto.embedQuery = originals.embedQuery; proto.embedPassage = originals.embedPassage; },
  };
}

console.log(`recall-budget-probe: ${iterations} iteration(s) per scenario, fixture scale x${scale}`);
console.log("Stub embedder, no reranker, no network: these are the pipeline FLOOR, not a");
console.log("production distribution. Re-run against a real store before fixing the budget.\n");

const rows = [];
for (const raw of SCENARIOS) {
  const scenario = scaled(raw);
  const totals = [];
  const embedShare = [];
  // One warm-up: the first run pays module init and LanceDB's first open.
  await runScenario(scenario, { freezeClock: false });
  for (let i = 0; i < iterations; i += 1) {
    const probe = instrumentEmbedder();
    const started = performance.now();
    await runScenario(scenario, { freezeClock: false });
    const elapsed = performance.now() - started;
    probe.restore();
    totals.push(elapsed);
    embedShare.push(probe.totals.embedMs);
  }
  rows.push({
    name: scenario.name,
    p50: quantile(totals, 0.5),
    p95: quantile(totals, 0.95),
    p99: quantile(totals, 0.99),
    embedP50: quantile(embedShare, 0.5),
  });
}

const width = Math.max(...rows.map((row) => row.name.length), 8);
console.log(`${"scenario".padEnd(width)}  ${"p50".padStart(10)}  ${"p95".padStart(10)}  ${"p99".padStart(10)}  ${"embed p50".padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${fmt(row.p50).padStart(10)}  ${fmt(row.p95).padStart(10)}  ${fmt(row.p99).padStart(10)}  ${fmt(row.embedP50).padStart(10)}`);
}

const allP95 = Math.max(...rows.map((row) => row.p95));
const allP99 = Math.max(...rows.map((row) => row.p99));
console.log(`\nworst p95 ${fmt(allP95)}, worst p99 ${fmt(allP99)}`);
console.log(`owner B6 proposal: soft 400 ms / hard 600 ms`);
console.log(`today in code:     soft 35000 ms (index.js:4711) / hard 50000 ms (index.js:13351)`);
console.log(allP95 <= 400
  ? "floor fits the 400 ms soft budget; the remaining headroom is the provider's."
  : "floor already exceeds the 400 ms soft budget before any provider is involved — report this.");
```

- [ ] **Step 4: Run it**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node bench/recall-budget-probe.mjs --iterations 30
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node bench/recall-budget-probe.mjs --iterations 20 --scale 50
```

Expected: a table with one row per scenario and non-zero p50/p95/p99, then the two comparison lines. Record both outputs verbatim in the commit message — they are the evidence the owner gate reads.

- [ ] **Step 5: Lint and suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0 (the probe is under `bench/`, which `npm run lint` does not `node --check`; run `/home/claude/.node24/bin/node --check bench/recall-budget-probe.mjs` yourself); suite at the accepted baseline.

- [ ] **Step 6: Commit, with the numbers in the message**

```bash
cd "$PLUR1BUS"
git add bench/recall-budget-probe.mjs tests/helpers/golden-prefix-driver.js
git commit -m "bench: measure today's recall latency for the B6 budget decision

Owner B6 and ADR-002 Q2 both require measuring before fixing 400/600 ms.
Paste the two runs' tables here (scale x1 and x50) so the owner gate can read
them without re-running."
```

---


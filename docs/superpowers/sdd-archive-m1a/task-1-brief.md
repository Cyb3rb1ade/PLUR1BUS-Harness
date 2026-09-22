### Task 1: Golden-prefix corpus — driver, scenarios, and the write-once oracle

**This task must run first, on an otherwise unmodified branch.** It only adds files under `tests/` and `tools/` and one line of `package.json:scripts.lint`; it changes no product code, so the strings it captures are the behaviour of `main` @ `89148f9`.

**Files:**
- Create: `tests/helpers/golden-prefix-driver.js`
- Create: `tests/fixtures/golden-prefix/scenarios.js`
- Create: `tools/capture-golden-prefix.mjs`
- Create (generated, write-once): `tests/fixtures/golden-prefix/expected/{recall-basic,recall-empty-store,recall-knowledge-canonical,recall-over-budget,recall-maintenance-only}.txt`
- Modify: `package.json` — `scripts.lint` only

**Interfaces:**
- Produces: `runScenario(scenario) -> Promise<string|null>`; `SCENARIOS: Scenario[]` where `Scenario = { name, agentId, workspaceKey, knowledge?: string, topics: Record<string,string>, memories: Array<{id,text,summary,category,ageDays}>, config: object, event: object, ctx: object }`; `FROZEN_NOW`, `VECTOR_DIM`, `freezeClock(now?)`, `topicVector(topic)`.
- Consumed by: Task 2 (`tests/golden-prefix.test.js`) and Task 18 (`bench/recall-budget-probe.mjs`).

**Design notes you need before writing code (all verified at `89148f9`):**
- `plugin.register(api, { importRouting })` registers `before_prompt_build` via `api.on`; the recall handler is the **last** one registered (`index.js:12285`), after the reply-outcome one (`:12216`), so `handlers.get("before_prompt_build").at(-1)` is the recall hook.
- `formatTimeContext` prints the wall clock into the non-droppable `time` block — hence `freezeClock`.
- The default embedding model is `intfloat/multilingual-e5-small` with a **fixed 384 dimensions**; `lib/providers/config-normalize.js:27` throws if you configure anything else. `VECTOR_DIM` is therefore 384.
- `recall.minScore` is **not** a valid config key (`lib/setup/config-contract.js` rejects it). Control ranking through the stub embedder instead: each fixture text is mapped to a *topic*, and a topic becomes a unit vector on one axis, so a query and its intended matches have distance 0.
- In legacy-flat namespace mode (`lib/namespace-config.js:123-133`, the mode you get when `namespaces` is absent from the config) an agent's table lives at `join(baseDbPath, agentId)`.
- `markNeoRecallInjection` (`index.js:5575-5592`) is a *dedupe* keyed on `runId|sessionKey|agentId|prompt` and returns `null` the second time within one `register()`. That is why each run gets a fresh `plugin.register()`.

- [ ] **Step 1: Write the driver**

Create `tests/helpers/golden-prefix-driver.js`:

```js
/**
 * tests/helpers/golden-prefix-driver.js
 *
 * Runs one golden-prefix scenario through the real `before_prompt_build`
 * handler with a stub OpenClaw `api`, a frozen clock and a deterministic
 * embedding provider. No network, no model download, no write outside
 * os.tmpdir(). The string it returns is the exact `prependContext` the model
 * would have seen.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../../index.js";
import { LocalTransformersEmbeddingProvider } from "../../lib/providers/embedding-local-transformers.js";

/** 2026-01-15T12:00:00Z — every scenario is evaluated at this instant. */
export const FROZEN_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** intfloat/multilingual-e5-small is fixed at 384 dims; the config contract
 *  rejects any other value (lib/providers/config-normalize.js:27). */
export const VECTOR_DIM = 384;

/**
 * Replace globalThis.Date with a frozen subclass. `Date.now()` and `new Date()`
 * return `now`; every other static (UTC, parse) is inherited.
 * @param {number} [now]
 * @returns {() => void} restore function
 */
export function freezeClock(now = FROZEN_NOW) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/**
 * One topic -> one unit vector on one axis. Two texts with the same topic get
 * distance 0; two texts with different topics get distance sqrt(2).
 * @param {string} topic
 * @returns {number[]}
 */
export function topicVector(topic) {
  const digest = createHash("sha256").update(String(topic)).digest();
  const axis = ((digest[0] << 8) | digest[1]) % VECTOR_DIM;
  const out = new Array(VECTOR_DIM).fill(0);
  out[axis] = 1;
  return out;
}

function stubEmbedder(topicOf) {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originalQuery = proto.embedQuery;
  const originalPassage = proto.embedPassage;
  proto.embedQuery = async (text) => topicVector(topicOf(text));
  proto.embedPassage = async (text) => topicVector(topicOf(text));
  return () => { proto.embedQuery = originalQuery; proto.embedPassage = originalPassage; };
}

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function makeApi(pluginConfig) {
  const handlers = new Map();
  const noop = () => {};
  return {
    pluginConfig,
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool(factory) { this.toolFactory = factory; },
    registerService: noop,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return { dispose: noop };
    },
    handlers,
  };
}

/**
 * Every feature that would reach the network, a model file or a background
 * scheduler is off. Scenario `config` is merged on top.
 * @param {string} baseDbPath
 * @param {object} [overrides]
 */
export function baseConfig(baseDbPath, overrides = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
    autoCapture: false,
    autoRecall: true,
    merging: { enabled: false },
    duplicateThreshold: 0.9999,
    obsidianBridge: { enabled: false },
    neo: { enabled: false },
    gc: { enabled: false },
    continuityEngine: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    replyOutcomeTracking: { enabled: false },
    temporalContext: { enabled: false },
    personaVoice: { enabled: false },
    emotion: { t3: { enabled: false } },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    recall: {
      dedup: false,
      canonicalFirst: true,
      canonicalMaxItems: 1,
      maxPromptMemories: 5,
      decisionTrace: { enabled: false, includeInPrompt: false },
      globalInjectMaxChars: 17_000,
    },
    ...overrides,
  };
}

/**
 * @param {object} scenario
 * @returns {Promise<string|null>} the exact prependContext, or null when the
 *   handler returned undefined.
 */
export async function runScenario(scenario) {
  const restoreClock = freezeClock();
  const topics = new Map(Object.entries(scenario.topics || {}));
  const topicOf = (text) => topics.get(String(text)) ?? String(text);
  const restoreEmbedder = stubEmbedder(topicOf);
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-golden-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-ws-"));
  const stateDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-state-"));
  const previousHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = stateDir;
  try {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    if (scenario.knowledge) {
      writeFileSync(join(workspaceDir, "memory", "KNOWLEDGE.md"), scenario.knowledge);
    }
    const db = new MemoryDB(join(baseDbPath, scenario.agentId), VECTOR_DIM);
    for (const memory of scenario.memories) {
      await db.store({
        id: memory.id,
        text: memory.text,
        summary: memory.summary,
        vector: topicVector(topicOf(memory.text)),
        category: memory.category,
        createdAt: FROZEN_NOW - (memory.ageDays ?? 1) * 86_400_000,
        storedBy: scenario.agentId,
        workspaceKey: scenario.workspaceKey,
      });
    }
    const api = makeApi(baseConfig(baseDbPath, scenario.config));
    plugin.register(api, { importRouting: async () => routingCapability });
    const hooks = api.handlers.get("before_prompt_build");
    const hook = hooks?.at(-1);
    if (typeof hook !== "function") throw new Error(`${scenario.name}: before_prompt_build not registered`);
    const result = await hook(scenario.event, { ...scenario.ctx, workspaceDir });
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
    return result?.prependContext ?? null;
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    restoreEmbedder();
    restoreClock();
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the five scenarios**

Create `tests/fixtures/golden-prefix/scenarios.js`. All text is invented; no real user data.

```js
/**
 * tests/fixtures/golden-prefix/scenarios.js
 *
 * Five synthetic recall scenarios. `topics` maps a fixture string to the axis
 * the stub embedder puts it on, so recall order is a property of the fixture
 * and not of a downloaded model.
 */

const AGENT = "golden-agent";
const WORKSPACE = "golden-workspace";

function ctxFor(session, run) {
  return {
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
    chatId: "golden-chat",
  };
}

function eventFor(prompt, session, run) {
  return {
    prompt,
    messages: [{ role: "user", content: prompt }],
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
  };
}

/** A block of filler large enough to push the join past the 17 000-char cap. */
const FILLER = "Deployment note. ".repeat(700); // ~11 900 chars

export const SCENARIOS = [
  {
    name: "recall-basic",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what dashboard theme do I like": "dashboard",
      "The user prefers a navy dashboard theme.": "dashboard",
      "navy dashboard": "dashboard",
      "The release decision was made on 2026-01-02.": "release",
      "release decision": "release",
    },
    memories: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "The user prefers a navy dashboard theme.",
        summary: "navy dashboard",
        category: "preference",
        ageDays: 3,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "The release decision was made on 2026-01-02.",
        summary: "release decision",
        category: "fact",
        ageDays: 10,
      },
    ],
    config: {},
    event: eventFor("what dashboard theme do I like", "golden-session-1", "golden-run-1"),
    ctx: ctxFor("golden-session-1", "golden-run-1"),
  },
  {
    name: "recall-empty-store",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "is there anything you remember": "nothing" },
    memories: [],
    config: {},
    event: eventFor("is there anything you remember", "golden-session-2", "golden-run-2"),
    ctx: ctxFor("golden-session-2", "golden-run-2"),
  },
  {
    name: "recall-knowledge-canonical",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    knowledge: "# Knowledge\n\nThe project ships on Fridays and never on a public holiday.\n",
    topics: {
      "when does the project ship": "shipping",
      "The team agreed to ship on Fridays.": "shipping",
      "ship on fridays": "shipping",
    },
    memories: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "The team agreed to ship on Fridays.",
        summary: "ship on fridays",
        category: "fact",
        ageDays: 5,
      },
    ],
    config: {},
    event: eventFor("when does the project ship", "golden-session-3", "golden-run-3"),
    ctx: ctxFor("golden-session-3", "golden-run-3"),
  },
  {
    name: "recall-over-budget",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what do you know about the deployment": "deployment",
      [`Deployment runbook A. ${FILLER}`]: "deployment",
      [`Deployment runbook B. ${FILLER}`]: "deployment",
      "runbook A": "deployment",
      "runbook B": "deployment",
    },
    memories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: `Deployment runbook A. ${FILLER}`,
        summary: "runbook A",
        category: "fact",
        ageDays: 2,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        text: `Deployment runbook B. ${FILLER}`,
        summary: "runbook B",
        category: "fact",
        ageDays: 4,
      },
    ],
    config: { recall: { dedup: false, canonicalFirst: true, canonicalMaxItems: 1, maxPromptMemories: 5, decisionTrace: { enabled: false, includeInPrompt: false }, globalInjectMaxChars: 17_000 } },
    event: eventFor("what do you know about the deployment", "golden-session-4", "golden-run-4"),
    ctx: ctxFor("golden-session-4", "golden-run-4"),
  },
  {
    name: "recall-maintenance-only",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "hello again": "greeting" },
    memories: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: "The user greeted the agent yesterday.",
        summary: "greeting",
        category: "fact",
        ageDays: 1,
      },
    ],
    // autoRecall off drives the third before_prompt_build registration
    // (index.js:13354-13443), the maintenance-only fallback branch.
    config: { autoRecall: false, gc: { enabled: true } },
    event: eventFor("hello again", "golden-session-5", "golden-run-5"),
    ctx: ctxFor("golden-session-5", "golden-run-5"),
  },
];
```

- [ ] **Step 3: Write the capture tool**

Create `tools/capture-golden-prefix.mjs`:

```js
/**
 * tools/capture-golden-prefix.mjs — write the golden-prefix oracle.
 *
 * Runs every scenario twice, each with a fresh plugin.register(), and refuses
 * to write anything unless both runs are byte-identical. Run once, on
 * unmodified main. Never re-run to "fix" a failing golden test.
 *
 * Usage: node tools/capture-golden-prefix.mjs [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "fixtures", "golden-prefix", "expected");
const force = process.argv.includes("--force");

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const scenario of SCENARIOS) {
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  if (first !== second) {
    console.error(`NON-DETERMINISTIC: ${scenario.name}`);
    console.error(`  run 1: ${JSON.stringify(first)}`);
    console.error(`  run 2: ${JSON.stringify(second)}`);
    failures += 1;
    continue;
  }
  if (first === null) {
    console.error(`EMPTY: ${scenario.name} produced no prependContext; fix the scenario`);
    failures += 1;
    continue;
  }
  const target = join(outDir, `${scenario.name}.txt`);
  if (existsSync(target) && !force) {
    console.error(`REFUSING to overwrite existing oracle ${target} (pass --force only if you know why)`);
    failures += 1;
    continue;
  }
  writeFileSync(target, first, "utf8");
  console.log(`wrote ${target} (${first.length} chars)`);
}

if (failures > 0) {
  console.error(`${failures} scenario(s) failed; no partial oracle is trustworthy`);
  process.exit(1);
}
console.log(`captured ${SCENARIOS.length} scenarios`);
```

- [ ] **Step 4: Teach `npm run lint` about `tools/`**

In `package.json`, change the `lint` script's last `find` from `find scripts -name '*.mjs'` to `find scripts tools -name '*.mjs'`. The full value becomes:

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} +",
```

- [ ] **Step 5: Run the capture and read the output**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node tools/capture-golden-prefix.mjs
```

Expected: five `wrote …/expected/<name>.txt (<n> chars)` lines then `captured 5 scenarios`, exit 0. A `NON-DETERMINISTIC` line means a source of entropy is still live — do **not** delete the scenario; find the entropy (diff the two printed strings) and make the fixture pin it. A `recall-empty-store` result that is non-null but tiny (mood directive + time block only) is expected and correct.

- [ ] **Step 6: Verify the oracle is real and re-running is refused**

```bash
cd "$PLUR1BUS" && head -c 400 tests/fixtures/golden-prefix/expected/recall-basic.txt; echo
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node tools/capture-golden-prefix.mjs; echo "exit=$?"
```

Expected: the first command prints a `<relevant-memories untrusted="true" …>` block containing `11111111-1111-4111-8111-111111111111`; the second prints five `REFUSING to overwrite` lines and `exit=1`.

- [ ] **Step 7: Lint and full suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint exits 0; the suite shows `pass 5071`, `fail 2` with only the two accepted baseline failures.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add tests/helpers/golden-prefix-driver.js tests/fixtures/golden-prefix tools/capture-golden-prefix.mjs package.json
git commit -m "test: capture the golden-prefix oracle on unmodified main

Five synthetic before_prompt_build scenarios, a frozen clock, a topic-axis
stub embedder and a capture tool that refuses to write unless two fresh
register() runs agree byte for byte. This is the behaviour-neutrality
instrument for PR-01..PR-03."
```

---


import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, restartPlan } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "fixtures");
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "defaults.json"), `${JSON.stringify(defaults(), null, 2)}\n`);
console.log("config-schema: fixtures/defaults.json written");

function withAgent(cfg, id, value) {
  const c = structuredClone(cfg);
  if (value === undefined) delete c.agents[id];
  else c.agents[id] = value;
  return c;
}

const base = defaults();

const cases = [
  {
    name: "live leaf change (core.recall.softBudgetMs)",
    before: base,
    after: (() => {
      const c = structuredClone(base);
      c.core.recall.softBudgetMs = 250;
      return c;
    })(),
  },
  {
    name: "core-class change (engine.recallMinScore)",
    before: base,
    after: (() => {
      const c = structuredClone(base);
      c.engine.recallMinScore = 0.5;
      return c;
    })(),
  },
  {
    name: "add agents.bernd",
    before: base,
    after: withAgent(base, "bernd", { createdAt: "2026-09-24T00:00:00Z" }),
  },
  {
    name: "remove agents.bernd",
    before: withAgent(base, "bernd", { createdAt: "2026-09-24T00:00:00Z" }),
    after: base,
  },
  {
    name: "rename bernd->karl",
    before: withAgent(base, "bernd", { createdAt: "2026-09-24T00:00:00Z" }),
    after: withAgent(withAgent(base, "bernd", undefined), "karl", { createdAt: "2026-09-24T00:00:00Z" }),
  },
  {
    name: "add providers.nvidia to an empty map",
    before: base,
    after: (() => {
      const c = structuredClone(base);
      c.providers.nvidia = { apiKey: "x" };
      return c;
    })(),
  },
  {
    name: "two changes of different classes at once",
    before: base,
    after: (() => {
      const c = structuredClone(base);
      c.core.logLevel = "debug";
      c.embedding.useClass = "research";
      return c;
    })(),
  },
];

const out = cases.map(({ name, before, after }) => ({ name, before, after, expected: restartPlan(before, after) }));
writeFileSync(join(outDir, "restart-plan-cases.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("config-schema: fixtures/restart-plan-cases.json written");

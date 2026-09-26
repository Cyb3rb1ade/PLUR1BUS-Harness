import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA, defaults, filterConfigByTier, filterSchemaByTier, restartPlan, tierOf, validate } from "./index.ts";

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

// `format` parity: the Rust validator (crates/plur1bus-config) must accept exactly the date-time values the
// core's ajv-formats accepts, or the CLI writes a config the core refuses. `valid` is what ajv says.
const dateTimes = [
  "2026-09-24T00:00:00Z", "2026-09-24T00:00:00.123+02:00", "2026-09-24t10:20:30z", "2026-09-24 10:20:30Z",
  "2026-09-24T10:20:30+0200", "2026-09-24T10:20:30+02", "2026-09-24T10:20:30.123456789012345-05:30",
  "yesterday", "", "2026-09-24", "2026-09-24T10:20:30", "2026-09-24T10:20Z", "2026-9-24T10:20:30Z",
  "2024-02-29T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z",
  "2026-09-24T24:00:00Z", "2026-09-24T10:60:00Z", "2026-09-24T10:20:30+24:00", "2026-09-24T10:20:30+02:60",
  "2026-09-24T10:20:30.Z", "2026-09-24T10:20:30Zjunk", "2026-09-24TT10:20:30Z",
  "2026-12-31T23:59:60Z", "2026-12-31T12:59:60Z", "2026-12-31T23:59:60+01:00", "2027-01-01T00:59:60+01:00", "2026-12-31T23:59:61Z",
];
const formatCases = [];
for (const value of dateTimes) {
  const c = withAgent(base, "bernd", { createdAt: value });
  formatCases.push({ name: `agents.bernd.createdAt = ${JSON.stringify(value)}`, config: c, valid: validate(c).ok });
}
for (const value of ["2026-09-24T00:00:00Z", "yesterday"]) {
  const c = structuredClone(base); c.embedding.acceptedNcLicenceAt = value;
  formatCases.push({ name: `embedding.acceptedNcLicenceAt = ${JSON.stringify(value)}`, config: c, valid: validate(c).ok });
}
writeFileSync(join(outDir, "format-cases.json"), `${JSON.stringify(formatCases, null, 2)}\n`);
console.log("config-schema: fixtures/format-cases.json written");

const tierKeys = [
  "$schema", "schemaVersion", "core.logLevel", "core.recall.capChars", "supervisor.graceMs",
  "logs.keep", "agents", "agents.bernd", "agents.bernd.displayName", "embedding.useClass",
  "embedding.acceptedNcLicence", "engine", "engine.chatModels", "engine.recall.softBudgetMs",
  "providers.x", "oauth", "decision", "modelRoles.chat", "nope.nothing",
];
const tierOut = {
  cases: tierKeys.map((key) => ({ key, tier: tierOf(key) })),
  filtered: { basic: filterSchemaByTier(CONFIG_SCHEMA, "basic"), advanced: filterSchemaByTier(CONFIG_SCHEMA, "advanced") },
};
writeFileSync(join(outDir, "tier-cases.json"), `${JSON.stringify(tierOut, null, 2)}\n`);
console.log("config-schema: fixtures/tier-cases.json written");

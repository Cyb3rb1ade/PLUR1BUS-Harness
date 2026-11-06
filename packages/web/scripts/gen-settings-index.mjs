// Generates packages/web/src/palette/settings-index.ts from packages/config-schema/schema/config.schema.json.
// Run with --check to verify without writing (exit 1 on drift).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { policyForNode, policySchema, valuePolicy } from "@plur1bus/config-schema/policy";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../config-schema/schema/config.schema.json");
const targetPath = resolve(here, "../src/palette/settings-index.ts");

const args = process.argv.slice(2);
let check = false;
let outFile = targetPath;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") {
    check = true;
  } else if (args[i] === "--out" && args[i + 1] && !args[i + 1].startsWith("--")) {
    outFile = resolve(args[++i]);
  } else {
    throw new Error("usage: gen-settings-index.mjs [--check] [--out file]");
  }
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

export function fromSchema(schemaObj) {
  const rows = [];
  const walk = (props, prefix, inherited, parentPolicy) => {
    for (const [k, v] of Object.entries(props)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (key === "$schema" || key === "schemaVersion") continue;
      const help = v.description ?? inherited;
      const policy = policyForNode(v, parentPolicy);
      const { sensitive, urlCredentials } = valuePolicy(v, parentPolicy);
      if (!v.properties || v["x-tier"]) {
        rows.push({
          key,
          type: Array.isArray(v.type) ? v.type.join("|") : (v.type ?? (v.enum ? "enum" : "")),
          tier: v["x-tier"] ?? "advanced",
          ...(sensitive ? { sensitive: true } : {}),
          ...(urlCredentials ? { urlCredentials: true } : {}),
          ...(help ? { help } : {}),
        });
      }
      if (v.properties) walk(v.properties, key, help, policy);
    }
  };
  walk(schemaObj.properties, "", undefined, policyForNode(schemaObj));
  return rows;
}

const HEADER = `// The settings catalogue behind the palette's "Settings" group: a static subset of \`packages/config-schema/schema/config.schema.json\`
// (the schema of config.json, \`config.get\` / \`config.set\` in docs/rpc.md; docs/config.md for the tiers). Runtime consumers import only
// the browser-safe config-schema/policy entry point. test/palette-index.test.ts reads the schema and rejects catalogue drift.
//
// What is real: key, type, tier, sensitivity, URL-credential policy and help text, all copied from the schema. A key is listed when it is a leaf or carries an
// \`x-tier\` (objects such as \`agents\` or \`modules\` are edited as a whole). \`help\` is the node's own \`description\`, else its nearest
// ancestor's (so \`metrics.port\` carries the description of \`metrics\`). \`$schema\` and \`schemaVersion\` are not settings.
// Sensitivity and URL-credential flags inherit from their container; sensitive string-array items also protect the collection widget.
// What is NOT available: localised labels. The schema has no titles, so the label is derived from the last key segment
// (\`softBudgetMs\` -> "Soft budget ms") and help stays in the schema's English. A localised catalogue needs schema titles or an
// owner-approved UI catalogue (follow-up).
import type { ConfigSchemaNode } from "@plur1bus/config-schema/policy";

export type SettingSpec = { readonly key: string; readonly type: string; readonly tier: "basic" | "advanced"; readonly sensitive?: boolean; readonly urlCredentials?: boolean; readonly help?: string };

export const SETTINGS: readonly SettingSpec[] = [
`;

export function generateFileContent(schemaObj) {
  const rows = fromSchema(schemaObj);
  const lines = rows.map((r) => {
    const parts = [
      `key: ${JSON.stringify(r.key)}`,
      `type: ${JSON.stringify(r.type)}`,
      `tier: ${JSON.stringify(r.tier)}`,
    ];
    if (r.sensitive) parts.push("sensitive: true");
    if (r.urlCredentials) parts.push("urlCredentials: true");
    if (r.help !== undefined) {
      parts.push(`help: ${JSON.stringify(r.help)}`);
    }
    return `  { ${parts.join(", ")} },`;
  });
  const policy = JSON.stringify(policySchema(schemaObj), null, 2);
  return `${HEADER}${lines.join("\n")}\n];\n\n// Structural policy uses the shared schema format, retaining public members, unknown-member rules and reference definitions.\n// It describes values without adding editable widgets or palette targets.\nexport const CONFIG_POLICY_SCHEMA: ConfigSchemaNode = ${policy};\n`;
}

const content = generateFileContent(schema);

if (check) {
  let current;
  try {
    current = readFileSync(outFile, "utf8");
  } catch {
    // Missing is drift
  }
  // A Windows checkout with core.autocrlf carries CRLF; the generated text is LF (the other generators compare the same way).
  if (current?.replace(/\r\n/g, "\n") !== content) {
    console.error(`settings-index: drift in ${outFile}; run pnpm gen`);
    process.exit(1);
  }
} else {
  writeFileSync(outFile, content);
}

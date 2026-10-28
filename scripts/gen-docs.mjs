// Generates docs/rpc.md (from packages/rpc-schema/schema/rpc.schema.json), docs/cli.md (from the clap
// definitions via the hidden `plur1bus __markdown` subcommand), docs/config.md (from
// packages/config-schema/schema/config.schema.json's x-tier annotations) and docs/log-schema.md (from the
// packages/log-schema/schema/*.json files: record schema, level map, event catalogue, redaction data; D111), plus
// docs/engine-contract.md (from crates/plur1bus-engine/schema/engine-contract.schema.json). `--check` compares instead of
// writing and exits 1 when any file is stale; CI runs it as `pnpm docs:check`.
//
// The binary is $PLUR1BUS_BIN, default target/debug/plur1bus(.exe) under the repo root; `pnpm docs:gen` and
// `pnpm docs:check` build it first. The comparison ignores CRLF vs LF so a Windows checkout with
// core.autocrlf does not read as stale.
import { docDiff } from "./doc-diff.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const schema = JSON.parse(readFileSync(new URL("packages/rpc-schema/schema/rpc.schema.json", root), "utf8"));
const fence = (v) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
const stabilityLine = (def) => {
  let line = `**Stability:** ${def["x-stability"]} · since ${def["x-since"]}`;
  if (def["x-deprecated"]) {
    const { since, removeAfter, replacement } = def["x-deprecated"];
    line += ` · **deprecated** since ${since}, removal not before ${removeAfter}; use ${replacement}`;
  }
  return line;
};
// One method namespace, four serving roles; the legacy Core engine.event retains its own shape.
const servedByLine = (def) => `**Served by:** ${def["x-server"]}${def["x-engine-notification"] ? " (legacy); engine (transport projection since 1.7.0)" : ""}`;

let rpc = `# RPC reference (rpc ${schema["x-rpc-version"]})

Generated from \`packages/rpc-schema/schema/rpc.schema.json\` by \`scripts/gen-docs.mjs\` — do not edit by hand; run \`pnpm docs:gen\`.
JSON-RPC 2.0, one JSON value per line (NDJSON, max 4 MiB per line), on \`run/core.sock\` (POSIX) or the per-home named pipe
(Windows). The first call on a connection is \`core.auth\`; its result carries \`contract\` (engine contract version) and \`rpc\`
(this schema's version). Methods served by the supervisor (**Served by:** supervisor) are called on the supervisor's own
endpoint, whose first call is \`supervisor.auth\`. Methods served by a module (**Served by:** module) are called on that
module's own endpoint (\`run/module-<name>.sock\`, or the per-home \`-module-<name>\` pipe), whose first call is
\`module.auth\`. Engine methods use the engine endpoint (\`run/engine.sock\` or the per-home \`-engine\` pipe),
whose first call is \`engine.auth\`. The Core serves \`host.*\` only to an engine-delegated connection; omission from ordinary
capabilities is a convenience, while every handler enforces the principal at dispatch. Engine delegation is revalidated on every call. \`host.llm.complete\` additionally requires an outer \`agentId\` belonging to a registered, active agent opened by this Core or carrying its in-flight engine work; the optional schema field preserves compatibility, while production rejects absent or unrelated attribution before provider access. The engine transport also emits
\`engine.event\` with its \`x-engine-notification\` schema; the deprecated Core emitter keeps its existing payload and opt-in rule.
Design and rationale: \`docs/adr/ADR-012-process-model-and-languages.md\`.
${schema.description ? `\n${schema.description}\n` : ""}
## Local endpoint trust

The trust boundary is the current OS user. On POSIX that rests on \`run/\` (a \`0700\` directory of the user) holding the sockets, tokens and pid files. Before a client reads a token or connects, it checks \`run/\`: it must be a real directory (not a symlink), owned by the current uid, and not writable by group or others; the socket must be a socket of the current uid. The Rust and Python clients additionally refuse a server whose peer uid (\`SO_PEERCRED\` on Linux; \`getpeereid\` in Rust and the equivalent \`LOCAL_PEERCRED\` in Python on macOS) is not the current uid, after connecting and before the token is sent; where the OS gives no answer the directory and socket checks are all there is. All three clients (Rust, TypeScript, Python) answer a refusal with \`E_UNAUTHORIZED\`, send nothing and read no token: reason \`run-dir-untrusted\` or \`socket-untrusted\` in all three, and \`peer-uid-mismatch\` in Rust and Python. **Limitation:** Node cannot ask the kernel for the peer uid of a unix socket, so the TypeScript client has the directory and socket checks only. The Python refusal also carries \`data.legacy_code = \"E_SERVER_IDENTITY\"\`, the code releases before this one raised for a bad \`run/\` (with the reasons \`run-dir-owner\`, \`run-dir-writable-by-others\`, \`run-dir-not-a-directory\`), so a host that classified the old code can still recognise it; \`E_SERVER_IDENTITY\` itself remains the code of the Python pid checks.

Setups that are refused for this reason:

- \`sudo plur1bus …\` against another user's home: the directory belongs to a different uid.
- A Docker bind mount of the home whose files belong to a different uid than the process in the container (for example a container running as root over a home owned by the host user).
- A home on WSL under \`/mnt/c\` (DrvFs), where every entry shows as world-writable.
- A group- or world-writable home or \`run/\` (for example a sloppy umask or a shared \`PLUR1BUS_HOME\`), and a \`run/\` that is a symlink.

On Windows, \`run/\` is protected by a DACL and the client compares the pipe server's process id with \`run/core.pid\` (or \`run/supervisor.pid\`) before it sends the token; a missing pid file is a refusal (\`server-pid-unknown\`), not a skipped check. The Rust and Python clients ask the OS (\`GetNamedPipeServerProcessId\`; the Python pid refusals stay \`E_SERVER_IDENTITY\`). **Limitation:** the TypeScript client (\`@plur1bus/module-api\`) has no native lookup, so it can only compare \`hello.pid\` with the recorded pid after \`core.auth\` was sent: a process that squats the pipe name receives the token and can claim any pid. A host that supplies a native lookup (\`serverPidOf\`) gets the refusal before the token is sent. Closing this for good needs the server to prove it holds the token (an HMAC over a client nonce) before the client sends it; that is not implemented.

## Error codes

A closed enum; the core puts the code into every error response as \`error.data.error\`, with optional \`reason\`, \`detail\` and \`ids\` (a map of non-secret ids a caller needs to recover, e.g. after a half-finished shared-copy refresh).

${schema.$defs.ErrorCode.enum.map((e) => `- \`${e}\``).join("\n")}

## Stability

${Object.entries(schema.$defs.methods).filter(([, d]) => d["x-stability"] === "stable").map(([n]) => `- \`${n}\``).join("\n")}
${Object.entries(schema.$defs.notifications).filter(([, d]) => d["x-stability"] === "stable").map(([n]) => `- \`${n}\` (notification)`).join("\n")}

Everything else is experimental and may change in any minor release (ADR-016 §4).

${["core", "supervisor", "module", "engine"].map(server => `### ${server} server\n\n${Object.entries(schema.$defs.methods).filter(([, d]) => d["x-server"] === server).map(([n, d]) => `- \`${n}\`: ${d["x-stability"]}, since ${d["x-since"]}${d["x-feature"] ? ` (feature ${d["x-feature"]})` : ""}`).join("\n")}`).join("\n\n")}

## Methods
`;
for (const [name, def] of Object.entries(schema.$defs.methods)) {
  const desc = def.description ?? def.params?.description ?? "";
  rpc += `\n### \`${name}\`\n\n${stabilityLine(def)}\n\n${servedByLine(def)}\n\n${desc ? `${desc}\n\n` : ""}**params**\n\n${fence(def.params)}\n\n**result**\n\n${fence(def.result)}\n`;
}
rpc += `\n## Notifications\n\nCore notifications are delivered on the same connection to clients that called \`events.subscribe\`. Engine transport notifications are delivered on authenticated engine connections.\n`;
for (const [name, def] of Object.entries(schema.$defs.notifications)) {
  rpc += `\n### \`${name}\`\n\n${stabilityLine(def)}\n\n${servedByLine(def)}\n\n${def.description ? `${def.description}\n\n` : ""}${fence(def)}\n`;
}
rpc += `\n## Definitions\n\nShared \`$defs\` referenced above as \`#/$defs/<Name>\`.\n`;
for (const [name, def] of Object.entries(schema.$defs)) {
  if (name === "methods" || name === "notifications") continue;
  rpc += `\n### \`${name}\`\n\n${fence(def)}\n`;
}

const defaultBin = fileURLToPath(new URL(`target/debug/plur1bus${process.platform === "win32" ? ".exe" : ""}`, root));
const bin = process.env.PLUR1BUS_BIN ?? defaultBin;
const cli = `# CLI reference

Generated by \`scripts/gen-docs.mjs\` from the clap definitions (\`plur1bus __markdown\`) — do not edit by hand; run \`pnpm docs:gen\`.
Every command accepts \`--json\` (machine-readable output: the raw RPC result or a stable object, on stdout), \`--home <path>\` and \`--color <auto|always|never>\` (default: \`auto\`; respects non-empty \`NO_COLOR\` unless \`always\`).
Every \`--json\` document carries \`schema: "<command>/<major>"\` (failures: \`error/1\`). Commands marked \`[experimental]\` may
change in any minor release; \`memory add\`, \`memory recall\`, \`config get\` and \`config set\` are stable (ADR-016). Commands
marked M2, M3, M4, M1b-3 or M8 are stubs that name the milestone delivering them and exit 2.

` + execFileSync(bin, ["__markdown"], { encoding: "utf8" });

// docs/config.md: walk config.schema.json in schema (property definition) order. A node carrying
// its own `x-tier` is one row (its own tier) and is not recursed into further — mirrors the
// keep-whole-or-recurse semantics of filter_schema_by_tier/filterSchemaByTier (Task 10), so the
// rows shown here match exactly what `config schema --tier <t>` returns. An unannotated container
// (no `x-tier` of its own) is recursed through its `properties`.
const configSchema = JSON.parse(readFileSync(new URL("packages/config-schema/schema/config.schema.json", root), "utf8"));
const configType = (s) => Array.isArray(s.type) ? s.type.join("|") : (s.type ?? (s.enum ? "enum" : (s.const !== undefined ? "const" : "any")));
const configDefault = (s) => s.default !== undefined ? `\`${JSON.stringify(s.default)}\`` : "";
// The engine key count is read from the pinned engine's own schema (the same source
// scripts/gen-engine-keys.mjs asserts against), so this text cannot go stale when the pin moves.
const engineKeyCount = Object.keys(
  createRequire(new URL("../packages/core/package.json", import.meta.url))(
    "@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json",
  ).properties,
).length;
const configDescription = (path, s) =>
  path === "engine"
    ? `Pass-through to the engine's EngineConfig — [${engineKeyCount} engine keys, all advanced and core](config-engine-keys.md).`
    : (s.description ?? "");
const basicRows = [];
const advancedRows = [];
const walkConfigNode = (path, node) => {
  const tier = node["x-tier"];
  if (tier === "basic" || tier === "advanced") {
    const row = `| \`${path}\` | ${configType(node)} | ${configDefault(node)} | ${node["x-restart"] ?? ""} | ${configDescription(path, node)} |`;
    (tier === "basic" ? basicRows : advancedRows).push(row);
    // EngineConfig is documented separately; the Harness-owned implementation switch must stay visible here.
    if (path === "engine" && node.properties?.implementation) walkConfigNode("engine.implementation", node.properties.implementation);
    return;
  }
  if (node.properties) {
    for (const [k, child] of Object.entries(node.properties)) {
      walkConfigNode(path ? `${path}.${k}` : k, child);
    }
  }
};
for (const [k, node] of Object.entries(configSchema.properties)) {
  walkConfigNode(k, node);
}
const configMd = `# Configuration reference (schemaVersion 1)

Generated by \`scripts/gen-docs.mjs\` from \`packages/config-schema/schema/config.schema.json\`'s \`x-tier\`
annotations — do not edit by hand; run \`pnpm docs:gen\`. \`config schema --tier basic\` and
\`config get --tier basic\` (and \`advanced\`) filter to the settings in the matching section below (D29).

## Basic settings

| Key | Type | Default | Restart | Description |
|---|---|---|---|---|
${basicRows.join("\n")}

## Advanced settings

| Key | Type | Default | Restart | Description |
|---|---|---|---|---|
${advancedRows.join("\n")}
`;

// docs/log-schema.md (D111): the record format, the level map, the event catalogue and the redaction data, straight from
// the four JSON files both writers load. Nothing here is hand-kept.
const logDir = "packages/log-schema/schema/";
const readLog = (f) => JSON.parse(readFileSync(new URL(logDir + f, root), "utf8"));
const logRecord = readLog("record.schema.json");
const logAudit = readLog("audit.schema.json");
const logCatalogue = readLog("catalogue.json");
const logLevels = readLog("levels.json");
const logRedaction = readLog("redaction.json");
const cell = (v) => String(v).replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (v) => `\`${cell(v)}\``;
const typeOf = (p) => p.const !== undefined ? `\`${JSON.stringify(p.const)}\`` : p.enum ? p.enum.map((e) => `\`${e}\``).join(" \\| ") : p.$ref ? (logRecord.$defs[p.$ref.split("/").pop()]?.enum ? typeOf(logRecord.$defs[p.$ref.split("/").pop()]) : `\`${p.$ref.split("/").pop()}\``) : code(Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "any"));
const groupRows = (props) => Object.entries(props).map(([k, p]) => `| ${code(k)} | ${typeOf(p)} | ${cell(p.description ?? "")} |`).join("\n");
const catalogueRows = (events) => events.map((e) => `| ${code(e.event)} | ${e.kinds.length === logRecord.$defs.SourceKind.enum.length ? "any" : e.kinds.join(", ")} | ${!e.levels ? "—" : e.levels.length === 1 ? e.level : e.levels.map((l) => (l === e.level ? `**${l}**` : l)).join(" / ")} | ${e.attrs} | ${e.requiredAttrs.map((a) => `\`${a}\``).join(", ")} | ${[e.activity ? "activity" : "", e.stability === "experimental" ? "experimental" : "", e.streamed ? "wrapped output" : "", e.deprecated ? `**deprecated** since ${e.deprecated.since}, removal not before ${e.deprecated.removeAfter}; use \`${e.deprecated.replacement}\`` : ""].filter(Boolean).join(", ")} | ${cell([e.levelRule, e.note].filter(Boolean).join("; "))} |`).join("\n");
const byStream = (s) => logCatalogue.events.filter((e) => e.stream === s);
const redactionRules = logRedaction.rules.map((r) => {
  const items = (r.patterns ?? r.steps ?? []).map((p) => `  - \`${p.id}\`: \`${p.pattern}\`${p.flags ? ` (flags \`${p.flags}\`)` : ""}${p.leftBoundary ? ", left boundary" : ""}${p.valueGroup ? `, replaces group ${p.valueGroup}` : ""}${p.exemptWhenWholeMatchIs ? `, exempt when the whole match is \`${p.exemptWhenWholeMatchIs}\`` : ""} — ${p.description}`);
  if (r.kind === "key-name") items.push(`  - names (flags \`${r.flags}\`): \`${r.pattern}\``, `  - camelCase names (case-sensitive): \`${r.camelPattern}\``);
  if (r.kind === "registry") items.push(`  - minimum length ${r.minLength}, encodings: ${r.encodings.join(", ")}`);
  if (r.kind === "url") items.unshift(`  - finds URLs with \`${r.find}\`, then applies, in order:`);
  if (r.kind === "deny-paths") for (const c of r.classes) items.push(`  - \`${c.id}\`: ${[...(c.segments ?? []).map((s) => "`" + s.join("/") + "`"), ...(c.files ?? []).map((f) => "`" + f + "`")].join(", ")}`);
  return `- **\`${r.id}\`** (${r.kind}, ${r.section}): ${r.description}${r.enabledBy ? ` Enabled by \`${r.enabledBy}\` (default ${r.enabledByDefault}).` : ""}\n${items.join("\n")}`;
}).join("\n");
const logMd = `# Log schema reference (log-schema ${logCatalogue.version})

Generated by \`scripts/gen-docs.mjs\` from \`packages/log-schema/schema/{record.schema,audit.schema,catalogue,levels,redaction}.json\` —
do not edit by hand; run \`pnpm docs:gen\`. Design: \`docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md\` (D111).
The TypeScript package \`@plur1bus/log-schema\` and the Rust crate \`plur1bus-log-schema\` both read these files;
\`packages/log-schema/fixtures/vectors.json\` and \`crates/plur1bus-log-schema/tests/parity.rs\` keep them in agreement.
This package holds the schema, catalogue, level map and redaction patterns as data and one validator. It contains no
logger, writer, redactor or sink.

## Record

One JSON object per line, UTF-8. Keys are written in this order (grep-stable); absent optional keys are omitted:
${logRecord["x-key-order"].map((k) => `\`${k}\``).join(", ")}.

| Field | Type | Rule |
|---|---|---|
${Object.entries(logRecord.properties).map(([k, p]) => { const d = p.$ref ? logRecord.$defs[p.$ref.split("/").pop()] : p; return `| ${code(k)} | ${typeOf(p)} | ${cell(p.description ?? d.description ?? "")}${logRecord.required.includes(k) ? " **Required.**" : ""} |`; }).join("\n")}

\`source\` is \`{ kind, id, version }\`, all three required (\`version\` may be \`null\`). \`source.kind\`: ${logRecord.$defs.SourceKind.enum.map((k) => `\`${k}\``).join(", ")}.
A source key (for \`logs.levels\` and filters) is \`<kind>\` or \`<kind>:<id>\`, matching \`${logRecord.$defs.SourceKey.pattern}\`.
\`err\` is \`{ code, reason?, retryable?, hint? }\` with \`code\` one of ${logRecord.$defs.ErrCode.enum.map((c) => `\`${c}\``).join(", ")}.

Limits: \`msg\` ≤ ${logRecord["x-limits"].msgBytes} bytes, \`attrs\` ≤ ${logRecord["x-limits"].attrsBytes} bytes (compact JSON), a wrapped output line ≤ ${logRecord["x-limits"].lineBytes} bytes, dedup window ${logRecord["x-limits"].dedupWindowMs} ms,
child output rate ${logRecord["x-limits"].rateSustainedPerSecond} lines/s sustained with a burst of ${logRecord["x-limits"].rateBurst}.

### Validation

JSON Schema cannot express key order, byte limits or the catalogue, so \`validateRecord\`/\`validateLine\` (TypeScript) and
\`validate_line\` (Rust) check those on top of the schema, in this order; the first failure names the code:

1. \`not_object\` — not a JSON object (a repeated top-level key is \`key_order\`)
2. \`invalid_level\` — \`level\` is not one of the six
3. \`unknown_event\` — \`event\` is not in the catalogue; \`wrong_stream\` — it is an audit action (use the audit record)
4. \`msg_too_long\` — \`msg\` over its byte limit
5. \`attrs_too_large\` — \`attrs\` over its byte limit
6. \`schema\` — the record schema, plus a real calendar date and time in \`ts\`
7. \`key_order\` — keys out of the order above
8. \`level_not_allowed\` — the level is not one the event allows
9. \`source_kind_not_allowed\` — the event may not be emitted by this source kind
10. \`stream_mismatch\` — \`stream\` present iff the event is wrapped child output
11. \`attrs_invalid\` — \`attrs\` do not match the event's attrs group (closed, with the event's required attrs)

## Audit record

Audit is its own record type (spec R1): the v1 fields of \`logs/audit.log\` are kept unchanged and D111 only adds optional fields to new lines. It has no \`ts\`, \`level\` or \`msg\`.
Keys are written in this order: ${logAudit["x-key-order"].map((k) => `\`${k}\``).join(", ")}. A reader aliases \`at\` to \`ts\`, \`action\` to \`event\` and \`actor\` to \`principal\`.

| Field | Type | Rule |
|---|---|---|
${Object.entries(logAudit.properties).map(([k, p]) => `| ${code(k)} | ${p.$ref ? `\`${p.$ref.split("/").pop()}\`` : p.const !== undefined ? `\`${p.const}\`` : p.type === "object" && p.properties ? "`object` (`user`, `host`)" : code(p.type)} | ${cell(p.description ?? "")}${logAudit.required.includes(k) ? " **Required.**" : ""} |`).join("\n")}

\`validateAuditRecord\`/\`validateAuditLine\` (TypeScript) and \`validate_audit_line\` (Rust) check: object → \`action\` is an audit-stream catalogue entry → \`detail\` bytes → schema → key order → source kind (when \`source\` is present) → \`detail\` against the entry's attribute group. An audit action written as a diagnostic record is refused with \`wrong_stream\`.

## Levels

| Level | Rank | OTel SeverityNumber | OTel SeverityText | syslog (RFC 5424) | Meaning |
|---|---|---|---|---|---|
${logLevels.levels.map((l) => `| \`${l.name}\` | ${l.rank} | ${l.otel.severityNumber} | ${l.otel.severityText} | ${l.syslog.severity} (${l.syslog.name}) | ${cell(l.meaning)} |`).join("\n")}

## Event catalogue

Events are stable API (R10): a rename is a new event plus a deprecation. A name matches \`${logCatalogue.nameRule}\`; \`repair.*\`
is a family (any \`repair.<step>\`). In the Level column the default level is **bold**. "Experimental" marks events whose
emitters land in later parts of D111; the names are already reserved.

### Diagnostic stream

| Event | Kinds | Level | Attrs group | Required attrs | Flags | Notes |
|---|---|---|---|---|---|---|
${catalogueRows(byStream("diagnostic"))}

### Audit stream

An audit entry's attribute group describes the line's \`detail\`. Groups marked *open* (the pre-D111 HB12 actions) tolerate further keys; every other group is closed. Audit entries have no level or message.

| Action | Kinds | Level | Attrs group | Required attrs | Flags | Notes |
|---|---|---|---|---|---|---|
${catalogueRows(byStream("audit"))}

### Payload stream

| Event | Kinds | Level | Attrs group | Required attrs | Flags | Notes |
|---|---|---|---|---|---|---|
${catalogueRows(byStream("payload")) || ""}

### Attribute groups

Every event's \`attrs\` are closed: the common attributes below plus the event's group, and nothing else.

#### Common attributes

| Attribute | Type | Meaning |
|---|---|---|
${groupRows(logCatalogue.commonAttrs)}

${Object.entries(logCatalogue.attrGroups).map(([name, g]) => `#### \`${name}\`${g.open ? " (open)" : ""}\n\n${g.description}\n\n| Attribute | Type | Meaning |\n|---|---|---|\n${groupRows(g.properties)}\n`).join("\n")}
## Redaction data

The writer applies these rules in order (${logRedaction.order.map((o) => `\`${o}\``).join(", ")}) to \`msg\`, \`attrs\`, \`err\`, wrapped text and audit detail; a match is
replaced by \`${logRedaction.replacementTemplate}\`. Patterns use the subset common to ECMAScript and the Rust \`regex\` crate.

${redactionRules}

Never logged at all (not redacted — not written): ${logRedaction.neverLogged.map((n) => n.description).join("; ")}.
`;

// docs/engine-contract.md: schema order is the contract's declaration order. Runtime interfaces
// remain visible alongside data types; their x-methods metadata records parameters and results.
const engineContract = JSON.parse(readFileSync(new URL("crates/plur1bus-engine/schema/engine-contract.schema.json", root), "utf8"));
const engineType = (node) => {
  if (node === false) return "never";
  if (node === true) return "unknown";
  if (node.$ref) return node.$ref.startsWith("#/$defs/") ? node.$ref.slice("#/$defs/".length) : node.$ref;
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (node.anyOf || node.oneOf) return (node.anyOf ?? node.oneOf).map(engineType).join(" | ");
  if (node.allOf) return node.allOf.map(engineType).join(" & ");
  if (Array.isArray(node.type)) return node.type.map((type) => engineType({ ...node, type })).join(" | ");
  if (node.type === "array") return `Array<${engineType(node.items ?? {})}>`;
  if (node.type === "object" || node.properties || node.additionalProperties !== undefined) {
    const required = new Set(node.required ?? []);
    const fields = Object.entries(node.properties ?? {}).map(([name, property]) => `${name}${required.has(name) ? "" : "?"}: ${engineType(property)}`);
    if (node.additionalProperties !== false) fields.push(`[key: string]: ${engineType(node.additionalProperties ?? {})}`);
    return fields.length ? `{ ${fields.join("; ")} }` : "{}";
  }
  return node.type ?? (node["x-runtime"] ? "runtime" : "unknown");
};
const engineSignature = (name, method) => `${name}(${(method.parameters ?? []).map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${engineType(parameter.schema)}`).join(", ")}): ${engineType(method.returns ?? {})}`;
let engineMd = `# Engine contract reference (contract ${engineContract["x-contract"]})

Generated from \`crates/plur1bus-engine/schema/engine-contract.schema.json\` by \`scripts/gen-docs.mjs\` — do not edit by hand; run \`pnpm docs:gen\`.

${engineContract.description}

Source engine commit: \`${engineContract["x-source-commit"]}\`. Additive A1 commit: \`${engineContract["x-a1-commit"]}\`.
\`a1-pending\` marks additive members whose final contract version the engine owner has not assigned.
Type summaries describe the schema. Method signatures preserve its \`x-methods\` parameters and resolved result shapes;
the Rust traits, cancellation parameters and runtime ports live under \`crates/plur1bus-engine/src/contract/\`.
The schema block in each section retains every constraint, annotation and runtime-member definition.
`;
for (const [name, definition] of Object.entries(engineContract.$defs)) {
  engineMd += `\n## \`${name}\`\n\n**Since:** ${definition["x-since"]}\n\n${definition.description ?? ""}\n\n**Type:** ${code(engineType(definition))}\n`;
  if (definition["x-runtime"]) engineMd += "\n**Runtime interface:** methods and ports are supplied by the Rust contract.\n";
  if (Object.keys(definition.properties ?? {}).length) {
    const required = new Set(definition.required ?? []);
    engineMd += `\n| Property | Type | Required | Since | Description |\n|---|---|---|---|---|\n${Object.entries(definition.properties).map(([property, value]) => `| ${code(property)} | ${code(engineType(value))} | ${required.has(property) ? "yes" : "no"} | ${value["x-since"] ?? definition["x-since"]} | ${cell(value.description ?? "")} |`).join("\n")}\n`;
  }
  if (definition["x-enum-since"]) {
    engineMd += `\n| Enum member | Since |\n|---|---|\n${Object.entries(definition["x-enum-since"]).map(([value, since]) => `| ${code(value)} | ${since} |`).join("\n")}\n`;
  }
  if (definition["x-runtime-properties"]) {
    engineMd += `\n| Runtime property | Since | Rust behavior |\n|---|---|---|\n${Object.entries(definition["x-runtime-properties"]).map(([property, value]) => `| ${code(property)} | ${value["x-since"] ?? definition["x-since"]} | ${cell(value.description ?? "")} |`).join("\n")}\n`;
  }
  if (Object.keys(definition["x-methods"] ?? {}).length) {
    engineMd += `\n| Method signature | Since | Description |\n|---|---|---|\n${Object.entries(definition["x-methods"]).map(([method, value]) => `| ${code(engineSignature(method, value))} | ${value["x-since"] ?? definition["x-since"]} | ${cell(value.description ?? "")} |`).join("\n")}\n`;
  }
  engineMd += `\n**Schema**\n\n${fence(definition)}\n`;
}

const lf = (s) => s.replace(/\r\n/g, "\n");
let stale = 0;
for (const [path, content] of [["docs/rpc.md", rpc], ["docs/cli.md", cli], ["docs/config.md", configMd], ["docs/log-schema.md", logMd], ["docs/engine-contract.md", engineMd]]) {
  const url = new URL(path, root);
  if (check) {
    let cur = "";
    try { cur = readFileSync(url, "utf8"); } catch { /* missing counts as stale */ }
    if (lf(cur) !== lf(content)) { console.error(`stale: ${path} (run pnpm docs:gen)`); console.error(docDiff(path, cur, content)); stale += 1; }
  } else writeFileSync(url, lf(content));
}
if (stale) process.exit(1);
console.log(check ? "docs up to date" : "docs written");

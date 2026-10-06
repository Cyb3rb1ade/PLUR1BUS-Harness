// Generates docs/rpc.md (from packages/rpc-schema/schema/rpc.schema.json), docs/cli.md (from the clap
// definitions via the hidden `plur1bus __markdown` subcommand) and docs/config.md (from
// packages/config-schema/schema/config.schema.json's x-tier annotations). `--check` compares instead of
// writing and exits 1 when any file is stale; CI runs it as `pnpm docs:check`.
//
// The binary is $PLUR1BUS_BIN, default target/debug/plur1bus(.exe) under the repo root; `pnpm docs:gen` and
// `pnpm docs:check` build it first. The comparison ignores CRLF vs LF so a Windows checkout with
// core.autocrlf does not read as stale.
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
// Ruling S2: one method namespace, two servers; x-server names the process that answers.
const servedByLine = (def) => `**Served by:** ${def["x-server"]}`;

let rpc = `# RPC reference (rpc ${schema["x-rpc-version"]})

Generated from \`packages/rpc-schema/schema/rpc.schema.json\` by \`scripts/gen-docs.mjs\` — do not edit by hand; run \`pnpm docs:gen\`.
JSON-RPC 2.0, one JSON value per line (NDJSON, max 4 MiB per line), on \`run/core.sock\` (POSIX) or the per-home named pipe
(Windows). The first call on a connection is \`core.auth\`; its result carries \`contract\` (engine contract version) and \`rpc\`
(this schema's version). Methods served by the supervisor (**Served by:** supervisor) are called on the supervisor's own
endpoint, whose first call is \`supervisor.auth\`. Methods served by a module (**Served by:** module) are called on that
module's own endpoint (\`run/module-<name>.sock\`, or the per-home \`-module-<name>\` pipe), whose first call is
\`module.auth\`. Design and rationale: \`docs/adr/ADR-012-process-model-and-languages.md\`.
${schema.description ? `\n${schema.description}\n` : ""}
## Local endpoint trust

The trust boundary is the current OS user. On POSIX that rests on \`run/\` (a \`0700\` directory of the user) holding the sockets, tokens and pid files. Before a client reads a token or connects, it checks \`run/\`: it must be a real directory (not a symlink), owned by the current uid, and not writable by group or others; the socket must be a socket of the current uid. The Rust CLI and clients additionally refuse a server whose peer uid (\`SO_PEERCRED\` on Linux, \`getpeereid\` on macOS) is not the current uid. A client that refuses answers \`E_UNAUTHORIZED\` with reason \`run-dir-untrusted\`, \`socket-untrusted\` or \`peer-uid-mismatch\`, and sends nothing. The Python and TypeScript clients apply the directory and socket checks; Node has no peer-uid lookup.

Setups that are refused for this reason:

- \`sudo plur1bus …\` against another user's home: the directory belongs to a different uid.
- A Docker bind mount of the home whose files belong to a different uid than the process in the container (for example a container running as root over a home owned by the host user).
- A home on WSL under \`/mnt/c\` (DrvFs), where every entry shows as world-writable.
- A group- or world-writable home or \`run/\` (for example a sloppy umask or a shared \`PLUR1BUS_HOME\`), and a \`run/\` that is a symlink.

On Windows, \`run/\` is protected by a DACL and the client compares the pipe server's process id with \`run/core.pid\` (or \`run/supervisor.pid\`) before it sends the token; a missing pid file is a refusal (\`server-pid-unknown\`), not a skipped check. The Rust and Python clients ask the OS (\`GetNamedPipeServerProcessId\`). **Limitation:** the TypeScript client (\`@plur1bus/module-api\`) has no native lookup, so it can only compare \`hello.pid\` with the recorded pid after \`core.auth\` was sent: a process that squats the pipe name receives the token and can claim any pid. A host that supplies a native lookup (\`serverPidOf\`) gets the refusal before the token is sent. Closing this for good needs the server to prove it holds the token (an HMAC over a client nonce) before the client sends it; that is not implemented.

## Error codes

A closed enum; the core puts the code into every error response as \`error.data.error\`, with optional \`reason\`, \`detail\` and \`ids\` (a map of non-secret ids a caller needs to recover, e.g. after a half-finished shared-copy refresh).

${schema.$defs.ErrorCode.enum.map((e) => `- \`${e}\``).join("\n")}

## Stability

${Object.entries(schema.$defs.methods).filter(([, d]) => d["x-stability"] === "stable").map(([n]) => `- \`${n}\``).join("\n")}
${Object.entries(schema.$defs.notifications).filter(([, d]) => d["x-stability"] === "stable").map(([n]) => `- \`${n}\` (notification)`).join("\n")}

Everything else is experimental and may change in any minor release (ADR-016 §4).

## Methods
`;
for (const [name, def] of Object.entries(schema.$defs.methods)) {
  const desc = def.description ?? def.params?.description ?? "";
  rpc += `\n### \`${name}\`\n\n${stabilityLine(def)}\n\n${servedByLine(def)}\n\n${desc ? `${desc}\n\n` : ""}**params**\n\n${fence(def.params)}\n\n**result**\n\n${fence(def.result)}\n`;
}
rpc += `\n## Notifications\n\nDelivered on the same connection to clients that called \`events.subscribe\`.\n`;
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
Every command accepts \`--json\` (machine-readable output: the raw RPC result or a stable object, on stdout) and \`--home <path>\`.
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

const lf = (s) => s.replace(/\r\n/g, "\n");
let stale = 0;
for (const [path, content] of [["docs/rpc.md", rpc], ["docs/cli.md", cli], ["docs/config.md", configMd]]) {
  const url = new URL(path, root);
  if (check) {
    let cur = "";
    try { cur = readFileSync(url, "utf8"); } catch { /* missing counts as stale */ }
    if (lf(cur) !== lf(content)) { console.error(`stale: ${path} (run pnpm docs:gen)`); stale += 1; }
  } else writeFileSync(url, lf(content));
}
if (stale) process.exit(1);
console.log(check ? "docs up to date" : "docs written");

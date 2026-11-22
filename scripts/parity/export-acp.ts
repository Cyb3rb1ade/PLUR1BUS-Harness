// Parity vectors for the ACP server (P4-K K8, plan P4-71 without external agents): `packages/core/src/acp/`.
//
// MODE W OVER STDIO. Each scenario drives the real TypeScript `AcpServer` through its own input and output streams and records
// ONE transcript: every frame it writes (`OUT <line>`, the bytes as UTF-8), every log line (`LOG {"e":event,...fields}`), every
// call that reaches the backend (`BACKEND ...`) or the Core (`RPC <method> <params>`), and a marker `EVENT <i>` before each
// input event. After every event the runner lets the event loop run until it is quiet. The Rust replay
// (`crates/plur1bus-core/src/acp/vectors.rs`) runs the same scenario against its own server and must write the same transcript,
// line for line.
//
// Two families. `server` scenarios use a scripted backend (an `AcpBackend` that does what a script says: updates, permission
// requests, gates, cancel); `core` scenarios use the real `CoreSessionBackend` over a scripted Core (`RpcCaller`): the answer of
// each call per method, with optional gates that hold an answer back until the scenario opens them. Payloads whose member order
// or number form matters are JSON *text* in the scenario (the fixture writer sorts object keys). The permission request ids are
// `acp-permission-<uuid>` with the scripted uuids of `k3b-support.ts`, listed in `ids`. Time is `mock.timers` (only the permission
// timeout uses a timer); the Rust side moves a test clock.
//
// Events: `in` (text), `hex` (bytes), `repeat` and `nest` (long lines without long fixtures), `release` (open a gate),
// `advance` (milliseconds), `end`, `close` (destroy the input), `error` (an error on the input), `outputClosed`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-acp.ts [--check]
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { record, type Scenario } from "./export-acp-support.ts";
import { buildFraming } from "./export-acp-framing.ts";
import { buildLimits, buildProtocol } from "./export-acp-protocol.ts";
import { buildPermissions } from "./export-acp-permissions.ts";
import { buildCore } from "./export-acp-core.ts";
import { buildFiles, buildFilesLarge } from "./export-acp-files.ts";

/** Several fixture files, so that none passes 1 MiB: the big scenarios are named here. */
async function coreAndFiles() {
  const groups: Record<string, string[]> = {
    corelimit: ["session-limit-after-1024-sessions"],
    filesmore: ["at-most-1024-call-ids-are-remembered", "long-patches-are-clipped-in-english"],
    filesclip: ["long-patches-are-clipped-at-a-character-boundary-in-german", "oversized-calls-say-so"],
    fileslarge: ["diff-content-limit-is-128-kib"],
  };
  const all = [...buildCore(), ...buildFiles(), ...buildFilesLarge()];
  const taken = new Set(Object.values(groups).flat());
  const rest = (own: Scenario[]) => own.filter((s) => !taken.has(s.name));
  const out: Record<string, { scenarios: Scenario[] }> = {
    core: { scenarios: await record(rest(buildCore())) },
    files: { scenarios: await record(rest([...buildFiles(), ...buildFilesLarge()])) },
  };
  for (const [name, names] of Object.entries(groups)) out[name] = { scenarios: await record(all.filter((s) => names.includes(s.name))) };
  return out;
}

export async function buildAcpVectors() {
  return {
    framing: { scenarios: await record(buildFraming()) },
    protocol: { scenarios: await record(buildProtocol()) },
    limits: { scenarios: await record(buildLimits()) },
    permissions: { scenarios: await record(buildPermissions()) },
    ...(await coreAndFiles()),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "acp", build: buildAcpVectors });
}

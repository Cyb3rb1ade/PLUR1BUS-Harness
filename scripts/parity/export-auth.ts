// Parity vectors (mode V) for the credential checks the Rust front door ports from module-api (P4-10 task review L9):
// `verifyApiDelegation` (with `validApiPrincipal`, `validBinding`, `isIdentifier`), `verifyEngineDelegation` plus the
// handshake's `params.token === params.engine.token`, and `checkAdoptionNonce`. `crates/plur1bus-core/src/auth.rs` replays
// every case. Recorded, never edited by hand.
//
// No credential is recorded: an input names its credentials by marker (`@api@`, `@engine@`, `@sup@`, `@other@`; upper case
// for the upper-cased value), and the exporter, like the Rust replay, puts a fresh random 64-hex value in their place. A
// verdict cannot depend on which random value that is.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-auth.ts [--check]
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAdoptionNonce } from "../../packages/module-api/src/adoption.ts";
import { verifyApiDelegation } from "../../packages/module-api/src/api-principal.ts";
import { verifyEngineDelegation } from "../../packages/module-api/src/engine-principal.ts";
import { RpcError } from "../../packages/module-api/src/rpc-error.ts";
import { exporterMain } from "./lib.mjs";

/** Fresh values for the markers, and the substitution both sides apply to an input's JSON text. */
export function credentials(): Record<string, string> {
  const fresh = () => randomBytes(32).toString("hex");
  const api = fresh(), engine = fresh(), sup = fresh(), other = fresh();
  return { "@api@": api, "@API@": api.toUpperCase(), "@engine@": engine, "@ENGINE@": engine.toUpperCase(), "@sup@": sup, "@SUP@": sup.toUpperCase(), "@other@": other };
}
export function substitute(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((t, [marker, value]) => t.split(marker).join(value), text);
}

/** The divergence the Rust port keeps on purpose (fail closed). */
const P4D_8 = "P4D-8: module-api coerces role and kind with String(), so a one-element array passes; the Rust port refuses it";

const principal = { userId: "alice", kind: "person", role: "member" };
const binding = { audience: "mcp", agentId: "bernd" };
const withPrincipal = (p: unknown) => ({ clientId: "harness-api", token: "@api@", principal: p });
const withBinding = (b: unknown) => withPrincipal({ ...principal, binding: b });

const apiCases: Array<{ name: string; input: unknown; apiToken?: "none"; note?: string }> = [
  { name: "minimal", input: { clientId: "harness-api", token: "@api@" } },
  { name: "transport-loopback", input: { clientId: "harness-api", token: "@api@", transport: "loopback" } },
  { name: "transport-remote", input: { clientId: "harness-api", token: "@api@", transport: "remote" } },
  { name: "transport-other", input: { clientId: "harness-api", token: "@api@", transport: "lan" } },
  { name: "transport-null", input: { clientId: "harness-api", token: "@api@", transport: null } },
  { name: "no-api-token-configured", input: { clientId: "harness-api", token: "@api@" }, apiToken: "none" },
  { name: "other-token", input: { clientId: "harness-api", token: "@other@" } },
  { name: "upper-cased-token", input: { clientId: "harness-api", token: "@API@" } },
  { name: "token-missing", input: { clientId: "harness-api" } },
  { name: "token-number", input: { clientId: "harness-api", token: 5 } },
  { name: "client-id-other", input: { clientId: "harness-cli", token: "@api@" } },
  { name: "client-id-missing", input: { token: "@api@" } },
  { name: "extra-member", input: { clientId: "harness-api", token: "@api@", scope: "all" } },
  { name: "array", input: [{ clientId: "harness-api", token: "@api@" }] },
  { name: "null", input: null },
  { name: "string", input: "harness-api" },
  { name: "principal-member", input: withPrincipal(principal) },
  { name: "principal-null", input: withPrincipal(null) },
  { name: "principal-array", input: withPrincipal([principal]) },
  { name: "principal-agent-owner", input: withPrincipal({ userId: "bot-1", kind: "agent", role: "owner" }) },
  { name: "principal-kind-other", input: withPrincipal({ ...principal, kind: "robot" }) },
  { name: "principal-role-other", input: withPrincipal({ ...principal, role: "root" }) },
  { name: "principal-role-missing", input: withPrincipal({ userId: "alice", kind: "person" }) },
  { name: "principal-role-in-an-array", input: withPrincipal({ ...principal, role: ["owner"] }), note: P4D_8 },
  { name: "principal-kind-in-an-array", input: withPrincipal({ ...principal, kind: ["person"] }), note: P4D_8 },
  { name: "principal-role-in-nested-arrays", input: withPrincipal({ ...principal, role: [["admin"]] }), note: P4D_8 },
  { name: "principal-role-two-element-array", input: withPrincipal({ ...principal, role: ["owner", "admin"] }) },
  { name: "principal-extra-member", input: withPrincipal({ ...principal, isAdmin: true }) },
  { name: "user-id-leading-dash", input: withPrincipal({ ...principal, userId: "-alice" }) },
  { name: "user-id-256", input: withPrincipal({ ...principal, userId: "a".repeat(256) }) },
  { name: "user-id-257", input: withPrincipal({ ...principal, userId: "a".repeat(257) }) },
  { name: "user-id-non-ascii", input: withPrincipal({ ...principal, userId: "älice" }) },
  { name: "user-id-trailing-newline", input: withPrincipal({ ...principal, userId: "alice\n" }) },
  { name: "user-id-number", input: withPrincipal({ ...principal, userId: 7 }) },
  { name: "agent-rights", input: withPrincipal({ ...principal, agentRights: { bernd: "use", "ops-2": "manage" } }) },
  { name: "agent-rights-value-other", input: withPrincipal({ ...principal, agentRights: { bernd: "own" } }) },
  { name: "agent-rights-key-bad", input: withPrincipal({ ...principal, agentRights: { "_bernd": "use" } }) },
  { name: "agent-rights-array", input: withPrincipal({ ...principal, agentRights: [] }) },
  { name: "project-rights", input: withPrincipal({ ...principal, projectRights: { p1: "lead", p2: "member" } }) },
  { name: "project-rights-value-other", input: withPrincipal({ ...principal, projectRights: { p1: "owner" } }) },
  { name: "token-id-128", input: withPrincipal({ ...principal, tokenId: "t".repeat(128) }) },
  { name: "token-id-129", input: withPrincipal({ ...principal, tokenId: "t".repeat(129) }) },
  { name: "token-id-bad", input: withPrincipal({ ...principal, tokenId: "t.1" }) },
  { name: "token-scopes", input: withPrincipal({ ...principal, tokenScopes: ["memory:read", ""] }) },
  { name: "token-scopes-256-units", input: withPrincipal({ ...principal, tokenScopes: ["😀".repeat(128)] }) },
  { name: "token-scopes-258-units", input: withPrincipal({ ...principal, tokenScopes: ["😀".repeat(129)] }) },
  { name: "token-scopes-not-strings", input: withPrincipal({ ...principal, tokenScopes: [1] }) },
  { name: "token-scopes-not-an-array", input: withPrincipal({ ...principal, tokenScopes: "memory:read" }) },
  { name: "binding-mcp", input: withBinding(binding) },
  { name: "binding-a2a-full", input: withBinding({ audience: "a2a", agentId: "bernd", projectId: "p1", system: "sys", groups: ["g1", "g2"], memory: { recall: { workspace: true, user: false, agentPrivate: true, project: false }, filter: ["health", "credential"], disclose: "never", capture: false } }) },
  { name: "binding-audience-other", input: withBinding({ ...binding, audience: "web" }) },
  { name: "binding-agent-id-padded", input: withBinding({ ...binding, agentId: " bernd " }) },
  { name: "binding-agent-id-blank", input: withBinding({ ...binding, agentId: "   " }) },
  { name: "binding-agent-id-nbsp-padded", input: withBinding({ ...binding, agentId: " bernd　" }) },
  { name: "binding-agent-id-control", input: withBinding({ ...binding, agentId: "ber\u0007nd" }) },
  { name: "binding-agent-id-delete", input: withBinding({ ...binding, agentId: "bernd\u007f" }) },
  { name: "binding-agent-id-128", input: withBinding({ ...binding, agentId: "b".repeat(128) }) },
  { name: "binding-agent-id-129", input: withBinding({ ...binding, agentId: "b".repeat(129) }) },
  { name: "binding-agent-id-129-padded-to-128", input: withBinding({ ...binding, agentId: ` ${"b".repeat(128)} ` }) },
  { name: "binding-agent-id-astral-64", input: withBinding({ ...binding, agentId: "😀".repeat(64) }) },
  { name: "binding-agent-id-astral-65", input: withBinding({ ...binding, agentId: "😀".repeat(65) }) },
  { name: "binding-agent-id-missing", input: withBinding({ audience: "mcp" }) },
  { name: "binding-project-id-blank", input: withBinding({ ...binding, projectId: "" }) },
  { name: "binding-system-number", input: withBinding({ ...binding, system: 3 }) },
  { name: "binding-group-65", input: withBinding({ ...binding, groups: ["g".repeat(65)] }) },
  { name: "binding-groups-not-an-array", input: withBinding({ ...binding, groups: "g1" }) },
  { name: "binding-extra-member", input: withBinding({ ...binding, scope: "x" }) },
  { name: "binding-array", input: withBinding([binding]) },
  { name: "binding-memory-recall-not-boolean", input: withBinding({ ...binding, memory: { recall: { user: "yes" } } }) },
  { name: "binding-memory-recall-unknown", input: withBinding({ ...binding, memory: { recall: { everything: true } } }) },
  { name: "binding-memory-filter-unknown", input: withBinding({ ...binding, memory: { filter: ["secrets"] } }) },
  { name: "binding-memory-filter-not-strings", input: withBinding({ ...binding, memory: { filter: [1] } }) },
  { name: "binding-memory-disclose-other", input: withBinding({ ...binding, memory: { disclose: "always" } }) },
  { name: "binding-memory-capture-not-boolean", input: withBinding({ ...binding, memory: { capture: 1 } }) },
  { name: "binding-memory-unknown", input: withBinding({ ...binding, memory: { retain: true } }) },
  { name: "binding-memory-array", input: withBinding({ ...binding, memory: [] }) },
];

const engineCases: Array<{ name: string; params: unknown; engineFile: "fresh" | "upper" | "missing" | "malformed" }> = [
  { name: "both-tokens", params: { token: "@engine@", engine: { clientId: "plur1bus-engine", token: "@engine@" } }, engineFile: "fresh" },
  { name: "upper-cased-file-and-tokens", params: { token: "@ENGINE@", engine: { clientId: "plur1bus-engine", token: "@ENGINE@" } }, engineFile: "upper" },
  { name: "upper-cased-tokens-lower-file", params: { token: "@ENGINE@", engine: { clientId: "plur1bus-engine", token: "@ENGINE@" } }, engineFile: "fresh" },
  { name: "params-token-differs", params: { token: "@other@", engine: { clientId: "plur1bus-engine", token: "@engine@" } }, engineFile: "fresh" },
  { name: "engine-token-other", params: { token: "@other@", engine: { clientId: "plur1bus-engine", token: "@other@" } }, engineFile: "fresh" },
  { name: "client-id-other", params: { token: "@engine@", engine: { clientId: "harness-api", token: "@engine@" } }, engineFile: "fresh" },
  { name: "extra-member", params: { token: "@engine@", engine: { clientId: "plur1bus-engine", token: "@engine@", role: "owner" } }, engineFile: "fresh" },
  { name: "engine-not-an-object", params: { token: "@engine@", engine: "@engine@" }, engineFile: "fresh" },
  { name: "engine-token-number", params: { token: "@engine@", engine: { clientId: "plur1bus-engine", token: 1 } }, engineFile: "fresh" },
  { name: "file-missing", params: { token: "@engine@", engine: { clientId: "plur1bus-engine", token: "@engine@" } }, engineFile: "missing" },
  { name: "file-malformed", params: { token: "short", engine: { clientId: "plur1bus-engine", token: "short" } }, engineFile: "malformed" },
];

const nonceCases: Array<{ name: string; file: string | null; nonce: string }> = [
  { name: "exact", file: "@sup@", nonce: "@sup@" },
  { name: "upper-cased-nonce", file: "@sup@", nonce: "@SUP@" },
  { name: "upper-cased-file", file: "@SUP@", nonce: "@sup@" },
  { name: "file-with-newline", file: "@sup@\n", nonce: "@sup@" },
  { name: "file-with-spaces", file: "  @sup@  \n", nonce: "@sup@" },
  { name: "nonce-with-newline", file: "@sup@", nonce: "@sup@\n" },
  { name: "other-nonce", file: "@sup@", nonce: "@other@" },
  { name: "short-nonce", file: "@sup@", nonce: "abc" },
  { name: "empty-nonce", file: "@sup@", nonce: "" },
  { name: "non-ascii-nonce", file: "@sup@", nonce: "İ@sup@" },
  { name: "file-missing", file: null, nonce: "@sup@" },
  { name: "file-malformed", file: "short", nonce: "short" },
  { name: "file-empty", file: "", nonce: "" },
];

function verdict(run: () => unknown): { valid: boolean; error?: string; reason?: string } {
  try { run(); return { valid: true }; }
  catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return { valid: false, error: e.error, ...(e.reason ? { reason: e.reason } : {}) };
  }
}

/** `module-api.json`: every case with module-api's verdict. */
export async function buildAuthVectors(): Promise<Record<string, unknown>> {
  const values = credentials();
  const api = apiCases.map((c) => {
    const inputJson = JSON.stringify(c.input);
    const input = JSON.parse(substitute(inputJson, values));
    const token = c.apiToken === "none" ? undefined : values["@api@"];
    return { name: c.name, inputJson, ...(c.apiToken ? { apiToken: c.apiToken } : {}), ...(c.note ? { note: c.note } : {}), ...verdict(() => verifyApiDelegation(input, token)) };
  });
  const engine = engineCases.map((c) => {
    const paramsJson = JSON.stringify(c.params);
    const params = JSON.parse(substitute(paramsJson, values));
    const file = { fresh: values["@engine@"], upper: values["@ENGINE@"], missing: undefined, malformed: "short" }[c.engineFile];
    // module-api's handshake: the delegation, then the core token must be the engine token (rpc-server.ts).
    const outcome = verdict(() => {
      verifyEngineDelegation(params.engine, file);
      if (params.token !== params.engine.token) throw new RpcError("E_UNAUTHORIZED", "engine credential mismatch", { reason: "engine-delegation" });
    });
    return { name: c.name, paramsJson, engineFile: c.engineFile, ...outcome };
  });
  const dir = mkdtempSync(join(tmpdir(), "p1b-auth-vectors-"));
  try {
    const nonce = nonceCases.map((c, i) => {
      const path = join(dir, `supervisor-${i}.token`);
      if (c.file !== null) writeFileSync(path, substitute(c.file, values));
      return { name: c.name, file: c.file, nonce: c.nonce, valid: checkAdoptionNonce(path, substitute(c.nonce, values)).ok };
    });
    return { "module-api": { "api-delegation": api, "engine-delegation": engine, "adoption-nonce": nonce } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "auth", build: buildAuthVectors }));
}

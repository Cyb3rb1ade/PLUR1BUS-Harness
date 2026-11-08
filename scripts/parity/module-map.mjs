#!/usr/bin/env node
// Generates docs/superpowers/plans/phase4/MODULE-MAP.md (P4-02): every `src` file of every non-UI TypeScript package
// (`packages/*` except `web`) -> the Phase 4 plan package that ports it and a disposition, and every test file -> a parity
// mode (V, T, S, W, B) or a recorded reason. Pattern: docs/superpowers/plans/rust-engine/MODULE-MAP.md.
//
//   node scripts/parity/module-map.mjs            write the file
//   node scripts/parity/module-map.mjs --check    exit 1 when the committed file is not what the rules produce
//
// THE MAPPING RULES ARE THE TABLES BELOW (SRC_RULES, TEST_RULES, TOOLING_RULES, SYSTEM_SUITES). They are ordered, the first
// match wins, and they are the only place a file gets its package. A file no rule matches is listed as `unassigned`:
// never guess, add a rule (with the plan section or the evidence in the note) or leave it visible.
// Sources: docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md §1.1, §1.2, §2.2 and the package scopes of §3.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const OUTPUT = "docs/superpowers/plans/phase4/MODULE-MAP.md";
export const UI_PACKAGES = ["web"];

export const DISPOSITIONS = {
  port: "behaviour the Rust core must reproduce; the package's parity gates apply",
  fold: "becomes a Rust idiom or an existing Rust crate; the note names the target",
  drop: "not ported: deleted by the cut (P4-90) or by an owner decision; the note says why",
  engine: "belongs to the memory engine (RE programme), not to plur1bus-core",
  "stays-TS": "stays TypeScript: the API and import for 0.1 (Q1), the module SDK, build-time and browser code, tooling",
  unassigned: "no rule matches; visible on purpose, a rule (or an owner answer) is needed",
};
export const MODES = {
  V: "vectors: an exporter records pure-function results, Rust reads them (scripts/parity/)",
  T: "transcripts: RPC traffic recorded from the TS core, replayed against the Rust core (tests/core-parity/)",
  S: "system: tests/system on PLUR1BUS_CORE_IMPL=ts and rust",
  W: "wire: HTTP/WebSocket exchanges recorded into fixtures, served by a Rust fake server (P4-03)",
  B: "stores: the same SQLite file written by TS, read and written by Rust, read by TS again",
};

/** Plan packages (plan §3) and the few non-P4 owners the plan names. */
export const OWNERS = {
  "P4-02": "Parity harness (this package)",
  "P4-10": "Front door, relay, legacy demotion",
  "P4-11": "Configuration, logs, doctor, metrics",
  "P4-12": "Identity, RBAC, principals, memory exposure",
  "P4-20": "Secrets and the redactor",
  "P4-21": "D109 policy, egress, audit append, attestation",
  "P4-22": "Approvals, grants, inbox, delivery, channel hand-off",
  "P4-23": "Auth ladder, credential pool, OAuth clients",
  "P4-24": "Budgets and usage",
  "P4-30": "exec, fs and web tools",
  "P4-31": "Host tools and hostctl",
  "P4-40": "Session store and maintenance",
  "P4-41": "Providers and wire formats",
  "P4-42": "Prompt builder, tool-call runtime, decision service, triage",
  "P4-43": "Dispatcher, registry, turn loop, provider loop, composition",
  "P4-44": "Model discovery and the extension catalogue",
  "P4-50": "Collaboration, the coding surface and the team shell",
  "P4-51": "Jobs and the memory-facing forwards",
  "P4-52": "Voice",
  "P4-53": "Media jobs and documents",
  "P4-60": "Telegram", "P4-61": "Discord", "P4-62": "Slack", "P4-63": "Signal", "P4-64": "E-mail", "P4-65": "Matrix", "P4-66": "Buzz",
  "P4-67": "Switchboard flip",
  "P4-70": "MCP client and server",
  "P4-71": "ACP server, ACP client and external agents",
  "P4-72": "A2A client and server",
  "P4-80a": "API server core", "P4-80b": "API accounts and OAuth", "P4-80c": "API desktop and remote access", "P4-80d": "API uploads and protocol endpoints",
  "P4-85": "Import",
  "P4-90": "Legacy removal",
  "P4-91": "Eval tooling relocation",
  "P4-93": "Local ML on ONNX Runtime (after 0.1)",
  "RE-11": "Node engine retired (RE programme)",
  D123: "Containment and sandbox (D123, not a Phase 4 package)",
  "—": "no package: stays as it is",
};

const rx = (s) => new RegExp(s);
const C = "^packages/core/src/";
/** [path pattern, owner, disposition, note]. Ordered; first match wins. */
export const SRC_RULES = [
  // ---- packages/core/src, specific files before their directories -------------------------------------------------------
  [rx(`${C}rpc/(?:methods|server|errors|surface-errors)\\.ts$`), "P4-10", "port", "RPC server plumbing and the method table (plan §1.2, front door)"],
  [rx(`${C}rpc/(?:api-admission|api-identity|hermes-client-auth|memory-caller-access)\\.ts$`), "P4-12", "port", "assigned by content: API principal admission, forwarded identity, personal-token store, caller binding"],
  [rx(`${C}rpc/(?:breakglass-memory|breakglass-notices|identity-surface)\\.ts$`), "P4-12", "port", "identity and break-glass surfaces"],
  [rx(`${C}rpc/(?:a2a-peers)\\.ts$`), "P4-72", "port", "plan P4-72 source"],
  [rx(`${C}rpc/(?:agent-create-surface)\\.ts$`), "P4-43", "port", "agent lifecycle admission"],
  [rx(`${C}rpc/(?:auth-surface)\\.ts$`), "P4-23", "port", "auth.* surface"],
  [rx(`${C}rpc/(?:channel-surface)\\.ts$`), "P4-67", "port", "plan P4-67 source"],
  [rx(`${C}rpc/(?:chat-surface|session-access|session-overview)\\.ts$`), "P4-40", "port", "session.* and chat.* surfaces"],
  [rx(`${C}rpc/(?:code-surface|collab-surface|project-board-surface|team-surface)\\.ts$`), "P4-50", "port", "code.session.*, collab.*, project.*, team.* (the TK team shell of PR #900, plan P4-50)"],
  [rx(`${C}rpc/(?:device-surface|remote-device-service-surface)\\.ts$`), "P4-80c", "stays-TS", "assigned by import: both serve the DeviceStore of packages/remote-access; the plan does not name them"],
  [rx(`${C}rpc/(?:inbox-surface)\\.ts$`), "P4-22", "port", "inbox.*"],
  [rx(`${C}rpc/(?:licence-surface|session-usage|telemetry-surface)\\.ts$`), "P4-24", "port", "licences, usage (plan P4-24 source), telemetry.cache.summary reads the budget ledger"],
  [rx(`${C}rpc/(?:media-search-surface|memory-models-surface)\\.ts$`), "P4-51", "port", "media-search; memory models and admin.embedding.check use embedding-migrate/"],
  [rx(`${C}rpc/(?:media-surface)\\.ts$`), "P4-53", "port", "plan P4-53 source"],
  [rx(`${C}rpc/(?:voice-session-surface)\\.ts$`), "P4-52", "port", "voice sessions"],
  [rx(`${C}(?:capabilities)\\.ts$`), "P4-10", "fold", "crates/plur1bus-rpc/src/capabilities.rs builds the feature list"],
  [rx(`${C}(?:lock)\\.ts$`), "P4-10", "fold", "the core lock is the SQLite byte-range lock of crates/plur1bus-audit/src/chain.rs"],
  [rx(`${C}(?:core|bin|warmup|platform|logger|paths|events-map|engine-host-ports|activity|activity-rpc|host|join|principal)\\.ts$`), "P4-10", "port", "plan §1.2 process and RPC front door"],
  [rx(`${C}engine/`), "P4-10", "port", "EngineClient, select.ts, host methods; the node branch of select.ts goes with RE-11"],
  [rx(`${C}engine(?:-shim)?\\.(?:d\\.)?ts$`), "RE-11", "engine", "in-process loader and contract assertion of the Node engine; retired with engine.implementation=node"],
  [rx(`${C}index\\.ts$`), "P4-90", "drop", "package entry of the TS core runtime"],
  [rx(`${C}(?:config-load|config-source|config-warnings|config-disclosure|engine-config|doctor-report)\\.ts$`), "P4-11", "port", "plan §1.2"],
  [rx(`${C}(?:logs|metrics)/`), "P4-11", "port", "plan §1.2"],
  [rx(`${C}(?:identity|rbac|memory-exposure|memory-sensitivity|privacy)/`), "P4-12", "port", "plan §1.2"],
  [rx(`${C}(?:secrets|extensions)/`), "P4-20", "port", "plan §1.2"],
  [rx(`${C}secrets-isolated-bin\\.ts$`), "P4-20", "port", "replaced by plur1bus-core secrets-helper"],
  [rx(`${C}(?:policy|audit|attestation|egress)/`), "P4-21", "port", "plan §1.2"],
  [rx(`${C}(?:approvals|grants|inbox|delivery|channel-handoff)/`), "P4-22", "port", "plan §1.2"],
  [rx(`${C}(?:auth|openai-auth)/`), "P4-23", "port", "plan §1.2"],
  [rx(`${C}(?:budget|licences)/`), "P4-24", "port", "plan §1.2"],
  [rx(`${C}tools/sandbox/`), "D123", "port", "D123 SB-3 ports seatbeltProfile() and backendArgv(); referenced by the plan, not duplicated"],
  [rx(`${C}tools/(?:exec|fs|web)/`), "P4-30", "port", "plan §1.2 executors"],
  [rx(`${C}sidecars/`), "P4-30", "port", "plan P4-30 source"],
  [rx(`${C}host-tools/`), "P4-31", "port", "plan §1.2"],
  [rx(`${C}tools/mcp-bridge\\.ts$`), "P4-70", "port", "plan P4-70 source"],
  [rx(`${C}tools/a2a-transport\\.ts$`), "P4-72", "port", "plan P4-72 source"],
  [rx(`${C}tools/`), "P4-43", "port", "dispatcher, registry, repair, approval, memory, collaboration (plan §1.2 turn engine)"],
  [rx(`${C}session/turn-loop\\.ts$`), "P4-43", "port", "the turn loop (plan §1.2)"],
  [rx(`${C}session/`), "P4-40", "port", "plan §1.2"],
  [rx(`${C}(?:composition/(?:cache-emit|apple-fm)|apple-fm/socket)\\.ts$`), "P4-41", "port", "plan P4-41 source (cache emitter, AF2 composition and socket guard)"],
  [rx(`${C}composition/extensions\\.ts$`), "P4-70", "port", "plan P4-70 source"],
  [rx(`${C}composition/channel-uploads\\.ts$`), "P4-67", "port", "plan P4-67 source"],
  [rx(`${C}composition/`), "P4-43", "port", "composition wiring (plan §1.2)"],
  [rx(`${C}(?:agents|tools-service)/`), "P4-43", "port", "plan §1.2"],
  [rx(`${C}agents\\.ts$`), "P4-43", "port", "plan §1.2"],
  [rx(`${C}toolcall/(?:coding-bench|turn-eval)`), "P4-91", "stays-TS", "eval tooling; moves to scripts/eval/ and drives the Rust core over RPC"],
  [rx(`${C}toolcall/`), "P4-42", "port", "tool-call runtime (plan P4-42)"],
  [rx(`${C}(?:prompt|decision|triage)/`), "P4-42", "port", "plan §1.2"],
  [rx(`${C}(?:discovery|catalog)/`), "P4-44", "port", "plan §1.2"],
  [rx(`${C}(?:collab|coding|external-turn|federation)/`), "P4-50", "port", "plan §1.2"],
  [rx(`${C}(?:dreams|media-search|embedding-migrate|system-jobs|user-jobs|knowledge|skill-mining)/`), "P4-51", "port", "core side of the jobs; the engine side is RE-10, the forward is written in Rust (plan P4-51 ordering rule)"],
  [rx(`${C}(?:journal|memory-ops|backup-ops|restore-reapply|admin-ops|replay|memory-curation|shared-memory|media-output-store)\\.ts$`), "P4-51", "port", "thin forwards that RE-10 creates (plan P4-51 source list)"],
  [rx(`${C}voice/`), "P4-52", "port", "plan §1.2"],
  [rx(`${C}channels/`), "P4-67", "port", "router, switchboard, bindings"],
  [rx(`${C}(?:mcp/|mcp-bin\\.ts$)`), "P4-70", "port", "plan §1.2"],
  [rx(`${C}(?:acp/|acp-bin\\.ts$|external-agents/)`), "P4-71", "port", "containment and the launcher are D123's"],
  [rx(`${C}a2a/`), "P4-72", "port", "plan §1.2"],
  [rx(`${C}(?:import/|import-bin\\.ts$|extension-source-(?:fetch|bin)\\.ts$)`), "P4-85", "stays-TS", "import may stay TypeScript for 0.1 (plan Q1); port only if Q1 says so"],
  [rx(`${C}api-bin\\.ts$`), "P4-80a", "stays-TS", "node entry of the API slot; the API may stay TypeScript for 0.1 (plan Q1)"],

  // ---- the other non-UI packages ---------------------------------------------------------------------------------------
  [rx("^packages/providers/src/cache-profile-vectors\\.ts$"), "P4-41", "stays-TS", "exporter of the cache-profile vectors the Rust engine already reads"],
  [rx("^packages/providers/src/"), "P4-41", "port", "plan §1.1"],
  [rx("^packages/channels-telegram/src/"), "P4-60", "port", "plan track G"],
  [rx("^packages/channels-discord/src/"), "P4-61", "port", "plan track G"],
  [rx("^packages/channels-slack/src/"), "P4-62", "port", "plan track G"],
  [rx("^packages/channels-signal/src/"), "P4-63", "port", "plan track G"],
  [rx("^packages/channels-email/src/"), "P4-64", "port", "plan track G"],
  [rx("^packages/channels-matrix/src/"), "P4-65", "port", "plan track G; crypto through matrix-sdk-crypto"],
  [rx("^packages/channels-buzz/src/"), "P4-66", "port", "plan track G"],
  [rx("^packages/voice-providers/src/local/"), "P4-93", "port", "local sherpa-onnx voice is not in 0.1 (plan §2.2, Q5); ported after 0.1"],
  [rx("^packages/voice-providers/src/"), "P4-52", "port", "cloud STT/TTS/realtime (plan P4-52)"],
  [rx("^packages/media/src/"), "P4-53", "port", "plan P4-53"],
  [rx("^packages/documents/src/"), "P4-53", "port", "plan P4-53; pagedjs stays an injected browser asset"],
  [rx("^packages/hostctl/src/"), "P4-31", "port", "plan P4-31"],
  [rx("^packages/remote-access/src/"), "P4-80c", "stays-TS", "the API stack may stay TypeScript for 0.1 (plan Q1)"],
  [rx("^packages/remote-fs/src/"), "P4-85", "stays-TS", "import discovery; crates/plur1bus-remote-fs is the Rust worker; follows import (plan Q1)"],
  [rx("^packages/embedding-adapters/src/"), "P4-90", "drop", "not connected to the core or the engine; deleted by P4-90 (plan Q8)"],
  [rx("^packages/config-schema/src/"), "P4-11", "stays-TS", "schema, build-time and web helpers; Rust reuses crates/plur1bus-config (plan §2.2)"],
  [rx("^packages/log-schema/src/"), "P4-11", "fold", "crates/plur1bus-log-schema mirrors it (plan §1.3)"],
  [rx("^packages/rpc-schema/src/"), "—", "stays-TS", "schema generator; JSON Schema stays the single source (plan §2.2)"],
  [rx("^packages/webmcp/src/"), "—", "stays-TS", "browser-side mapping for the web GUI (plan §2.2)"],
  [rx("^packages/module-fixture/src/"), "—", "stays-TS", "test fixture module"],
  [rx("^packages/module-api/src/parity-recorder\\.ts$"), "P4-02", "stays-TS", "the transcript recorder seam of this package"],
  [rx("^packages/module-api/src/(?:rpc-server|framing|trust|control-server|orphan-watch|adoption)\\.ts$"), "P4-10", "stays-TS", "published SDK (ADR-016 §1); its behaviour is the reference P4-10 reproduces in crates/plur1bus-rpc"],
  [rx("^packages/module-api/src/"), "—", "stays-TS", "published module SDK (ADR-016 §1, plan §2.2, Q7)"],

  // ---- packages/api: grouped as plan track I groups them ----------------------------------------------------------------
  [rx("^packages/api/src/(?:server|routes|headers|rate-limit|static|rpc-route|events-route|chat-stream|ws[^/]*|core-link|core-rpc|delegated-link|request-core|errors|openapi)\\.ts$"), "P4-80a", "stays-TS", "plan track I; the API may stay TypeScript for 0.1 (Q1)"],
  [rx("^packages/api/src/(?:login|password|totp|webauthn[^/]*|challenge|session|account-[^/]*|bootstrap|tokens|owner-token|audit[^/]*)\\.ts$"), "P4-80b", "stays-TS", "plan track I"],
  [rx("^packages/api/src/oauth/"), "P4-80b", "stays-TS", "plan track I"],
  [rx("^packages/api/src/(?:desktop-[^/]*|remote-[^/]*|transport-routes|net-bridge)\\.ts$"), "P4-80c", "stays-TS", "plan track I"],
  [rx("^packages/api/src/(?:import-[^/]*|extension-[^/]*|chat-routes|channel-handoff-routes|protocol-routes)\\.ts$"), "P4-80d", "stays-TS", "plan track I"],
  [rx("^packages/api/src/(?:mcp|a2a)/"), "P4-80d", "stays-TS", "plan track I"],
  [rx("^packages/api/src/(?:bin|index)\\.ts$"), "P4-80a", "stays-TS", "assigned by content: process entry and package exports of the API server; the plan names neither"],  // assigned by content after the P4-02 review (the plan names none of these files)
  [rx("^packages/api/src/(?:clock|redact)\\.ts$"), "P4-80a", "stays-TS", "assigned by content: clock port and logger secret-key net of the API server; redact.ts could fold into P4-11/P4-20 if the API ever goes Rust"],
  [rx("^packages/api/src/(?:ports|principal|memory-stores)\\.ts$"), "P4-80b", "stays-TS", "assigned by content: the API's own account ports (UserRecord, TokenStore, TotpStore), the session-principal mapping and the in-memory test stores"],
  [rx("^packages/api/src/notices\\.ts$"), "P4-80b", "stays-TS", "PROVISIONAL: local pull list of break-glass notices for hosts that embed the API; the real list is the core's breakglass.notices (P4-12); a candidate for drop if no embedder exists, owner to say", true],
  [rx("^packages/api/src/rbac-bridge\\.ts$"), "P4-80a", "stays-TS", "assigned by content: relative re-export of packages/core/src/rbac and audit/chain.ts; breaks when P4-12 and P4-21 port those modules, so P4-80a depends on them (or on a Rust-served authorize call)"],
  [rx("^packages/core/src/rpc/admin-surface\\.ts$"), "P4-12", "port", "assigned by content: the admin.* surface (people, invites, break-glass, pairing links, sessions of an agent); the identity side decides, it also touches P4-40 and P4-43"],
  [rx("^packages/core/src/rpc/engine-test-surface\\.ts$"), "P4-51", "port", "PROVISIONAL: test calls for embedder, reranker and captioner (engine.* test RPCs); its neighbours memory-models-surface and admin.embedding.check are P4-51, but P4-44 or P4-10 is possible", true],
  [rx("^packages/core/src/setup/model\\.ts$"), "P4-52", "port", "PROVISIONAL: SETUP_STEPS and the voice-language step; its only importer is voice/v3.ts (P4-52); P4-10/P4-11 if the wizard model is shared with the web UI", true],
];

/** [path pattern, owner, modes, reason]. `modes` is a string of mode letters or "" with a reason. First match wins. */
const T = "^packages/core/test/";
export const TEST_RULES = [
  // ---- support files (not tests) ------------------------------------------------------------------------------------------
  [rx(`${T}fixtures/openai/server\\.ts$`), "P4-41", "W", "the TypeScript fake OpenAI HTTP server; P4-03 builds the Rust equivalent (mode W)"],
  [rx(`${T}(?:helpers|fixtures)/`), "—", "", "test support, moves with the suites that use it"],
  [rx(`${T}integration/wire-fixture\\.ts$`), "P4-43", "", "test support (recorded provider wire fixture)"],
  [rx(`${T}composition/(?:helpers|native-card-fixture)\\.ts$`), "P4-43", "", "test support"],
  // ---- packages/core/test, top level --------------------------------------------------------------------------------------
  [rx(`${T}(?:core|core-drain|core-run-acl|core-supervised|bin|bin-entry|rpc-server|lock|paths|platform|platform-windows|principal|join|events-map|events-map-audit|event-audience-sse|activity|activity-audit|activity-history|activity-rpc|warmup|host|capabilities-features|engine-host-ports|logger)\\.test\\.ts$`), "P4-10", "T", "plan P4-10 parity list"],
  [rx(`${T}acp-bin-entry\\.test\\.ts$`), "P4-71", "T", "plan P4-71 (acp-bin-entry)"],
  [rx(`${T}(?:config-load|config-load-hardening|config-source|config-disclosure-policy|config-disclosure-source|engine-config|engine-config-hardening|engine-config-parity|doctor-report)\\.test\\.ts$`), "P4-11", "V,T", "plan P4-11: config fixtures (V), doctor methods (T)"],
  [rx(`${T}budget-rpc\\.test\\.ts$`), "P4-24", "T", "plan P4-24 (budget-rpc)"],
  [rx(`${T}models-rpc\\.test\\.ts$`), "P4-44", "T", "plan P4-44 (models-rpc)"],
  [rx(`${T}b9-no-syscalls\\.test\\.ts$`), "P4-21", "", "plan P4-21 lists it; it counts socket and spawn calls of Node entry points during recall, which has no Rust equivalent (the Rust core is checked by forbid(unsafe_code) and the engine's own gates)"],
  [rx(`${T}agents(?:-audit)?\\.test\\.ts$`), "P4-43", "T", "plan P4-43 (agents*.test.ts)"],
  [rx(`${T}engine-inline-post-turn\\.test\\.ts$`), "P4-43", "T", "plan P4-43"],
  [rx(`${T}apple-fm-(?:guard|runtime)\\.test\\.ts$`), "P4-41", "V,W", "AF2 socket guard and the fake fm serve (plan P4-41)"],
  [rx(`${T}(?:dreams-[a-z-]+|admin-ops|backup-ops|backup-wal|journal|journal-hardening|replay|restore-reapply|restore-reapply-core|memory-ops|memory-ops-map|memory-curation|shared-memory|system-jobs)\\.test\\.ts$`), "P4-51", "T", "plan P4-51 parity list"],
  [rx(`${T}(?:engine-contract|engine-media-compat|engine-port-71820|engine-role-live|engine-role-test)\\.test\\.ts$`), "RE-11", "", "tests the in-process Node engine contract; retired with engine.implementation=node (RE-11)"],
  [rx(`${T}import-hygiene\\.test\\.ts$`), "P4-90", "", "scans what the Node core process loads; has no meaning once the Node core is gone (P4-90)"],
  // ---- packages/core/test, by directory -----------------------------------------------------------------------------------
  [rx(`${T}rpc/`), "P4-10", "T", "plan P4-10 parity list (rpc/ 22 files); the surfaces move with their subsystem"],
  [rx(`${T}engine/`), "P4-10", "T", "EngineClient and host methods"],
  [rx(`${T}(?:logs|metrics)/`), "P4-11", "V,T", "plan P4-11"],
  [rx(`${T}rbac/`), "P4-12", "V,T", "decision table (V), guarded methods (T)"],
  [rx(`${T}identity/`), "P4-12", "T,B", "identity.*, user.* (T); identity store (B)"],
  [rx(`${T}(?:privacy|memory-exposure|memory-sensitivity)/`), "P4-12", "V", "plan P4-12"],
  [rx(`${T}hermes/`), "P4-12", "T", "assigned by content: scoped personal-token client (rpc/hermes-client-auth.ts)"],
  [rx(`${T}secrets/`), "P4-20", "V,T", "redaction and secret-form vectors, secret.*"],
  [rx(`${T}extensions/`), "P4-20", "T", "plan P4-20"],
  [rx(`${T}(?:policy|egress)/`), "P4-21", "V", "decision vectors per OS, egress classification"],
  [rx(`${T}(?:audit|attestation)/`), "P4-21", "T", "audit.*, egress.*, attestation"],
  [rx(`${T}(?:approvals|grants|inbox|channel-handoff)/`), "P4-22", "T,B", "stores (B) and methods (T)"],
  [rx(`${T}delivery/`), "P4-22", "T", "delivery.*"],
  [rx(`${T}auth/`), "P4-23", "V,W", "ladder decisions (V), token and refresh exchanges (W)"],
  [rx(`${T}openai-auth/`), "P4-23", "W,T", "token exchanges (W), auth.* (T)"],
  [rx(`${T}budget/`), "P4-24", "T,B", "budget store (B), budget.* (T)"],
  [rx(`${T}licences/`), "P4-24", "T", "plan P4-24"],
  [rx(`${T}tools/sandbox/`), "D123", "", "D123's kernel sandbox probes; ported by D123 SB-3, not by Phase 4"],
  [rx(`${T}tools/(?:exec|fs)/`), "P4-30", "V", "argv and env filtering, fs vectors"],
  [rx(`${T}tools/web/`), "P4-30", "V,W", "ip classification, robots, extraction (V); fetch and search exchanges (W)"],
  [rx(`${T}tools/mcp-bridge[^/]*\\.test\\.ts$`), "P4-70", "W", "plan P4-70"],
  [rx(`${T}tools/`), "P4-43", "T", "dispatcher, registry, repair, approval (plan P4-43)"],
  [rx(`${T}architecture/`), "P4-43", "", "the D120 T1-a single-gate test becomes a Rust compile_fail doctest plus a runtime audit-record test (plan P4-43)"],
  [rx(`${T}sidecars/`), "P4-30", "W", "plan P4-30"],
  [rx(`${T}(?:agents|tools-service)/`), "P4-43", "T", "agent lifecycle and the tools-service client (plan P4-43)"],
  [rx(`${T}host-tools/`), "P4-31", "V", "classification and deny-list vectors"],
  [rx(`${T}session/`), "P4-40", "B,T", "sample databases v1..v9 (B), session.* and chat.* (T)"],
  [rx(`${T}prompt/`), "P4-42", "V", "zone and prefix hashes, rendered prompts"],
  [rx(`${T}toolcall/(?:coding-bench|turn-eval)`), "P4-91", "", "eval tooling tests; they move with the tooling to scripts/eval/"],
  [rx(`${T}toolcall/`), "P4-42", "V", "tool-call runtime"],
  [rx(`${T}(?:decision)/`), "P4-42", "V,T", "decision service"],
  [rx(`${T}triage/`), "P4-42", "V", "plan P4-42"],
  [rx(`${T}composition/(?:cache-emit)\\.test\\.ts$`), "P4-41", "V", "the cache emitter (byte-identical request bodies)"],
  [rx(`${T}composition/(?:media|documents)\\.test\\.ts$`), "P4-53", "T", "media and documents wiring"],
  [rx(`${T}composition/web-fetch\\.test\\.ts$`), "P4-30", "W", "web fetch wiring"],
  [rx(`${T}composition/(?:mcp-visibility|protocols-d109)\\.test\\.ts$`), "P4-70", "W", "protocol exposure"],
  [rx(`${T}composition/`), "P4-43", "T", "composition wiring (plan P4-43)"],
  [rx(`${T}(?:integration)/`), "P4-43", "T", "plan P4-43 (integration/ 3)"],
  [rx(`${T}model-routing/`), "P4-41", "W", "plan P4-41 (model-routing/ 3)"],
  [rx(`${T}(?:discovery|catalog)/`), "P4-44", "V,W,T", "scanner exchanges (W), reconcile (V), models.* (T)"],
  [rx(`${T}(?:collab|coding)/`), "P4-50", "T,B", "collab store (B), collab.* and code.session.* (T)"],
  [rx(`${T}(?:external-turn|federation)/`), "P4-50", "T", "plan P4-50"],
  [rx(`${T}(?:dreams|media-search|embedding-migrate|system-jobs|user-jobs|knowledge|skill-mining)/`), "P4-51", "T", "plan P4-51 parity list"],
  [rx(`${T}voice/`), "P4-52", "W,T", "plan P4-52"],
  [rx(`${T}channels/`), "P4-67", "T", "channel.* (plan P4-67)"],
  [rx(`${T}mcp/`), "P4-70", "W", "stdio and HTTP MCP sessions"],
  [rx(`${T}acp/`), "P4-71", "T", "ACP sessions over stdio"],
  [rx(`${T}external-agents/`), "P4-71", "T", "D123's four gate files stay byte-identical (plan P4-71)"],
  [rx(`${T}a2a/`), "P4-72", "W", "peer exchanges against the fixture peer"],
  [rx(`${T}import/`), "P4-85", "V", "mapper and plan outputs over the committed fixtures; the import may stay TypeScript for 0.1 (Q1)"],
  [rx(`${T}live/`), "—", "", "live tests that need a real service (nightly); not a parity input"],
  // admin/*, protocols/* and setup/* were assigned after the P4-02 review; admin/* and setup/* are provisional
  [rx(`${T}admin/(?:admin-bounds|admin-scope|rights|single-owner|admission|invites|person-status|notices|transcript)\\.test\\.ts$`), "P4-12", "T", "PROVISIONAL: admin.* people, rights, invites, break-glass limits and notices (identity and RBAC are P4-12); admission also calls session.submit and memory.capture, transcript could be P4-51", true],
  [rx(`${T}admin/(?:agent-create-core|agent-create-import|backend|core)\\.test\\.ts$`), "P4-43", "T", "PROVISIONAL: agent creation and lifecycle (agent-create-surface and agents/ are P4-43); agent-create-import also touches P4-85 and runs against a real engine", true],
  [rx(`${T}admin/usage\\.test\\.ts$`), "P4-24", "T", "PROVISIONAL: usage and budgets (session-usage surface is P4-24)", true],
  [rx(`${T}admin/(?:agent-config|export-config-canaries)\\.test\\.ts$`), "P4-11", "T", "PROVISIONAL: config.set compare-and-set and exported-file redaction by known config values; the canaries could be P4-20", true],
  [rx(`${T}protocols/`), "P4-12", "T", "exposure matrix across MCP, ACP and A2A is a memory-exposure property (memory-exposure/ is P4-12); P4-70..72 reuse it as a gate"],
  [rx(`${T}setup/memory-models\\.test\\.ts$`), "P4-51", "T", "PROVISIONAL: first-run wizard step that writes memory models; follows setup/model.ts", true],
  [rx(`${T}setup/voice\\.test\\.ts$`), "P4-52", "T", "PROVISIONAL: first-run wizard voice-language step; follows setup/model.ts", true],

  // ---- the other non-UI packages ------------------------------------------------------------------------------------------
  [rx("^packages/module-api/test/parity-recorder\\.test\\.ts$"), "P4-02", "", "self-test of the transcript recorder (the harness itself)"],
  [rx("^packages/module-api/test/(?:helpers)/"), "—", "", "test support"],
  [rx("^packages/module-api/test/(?:paths-vectors|framing-fuzz|framing)\\.test\\.ts$"), "P4-10", "V", "framing and path vectors of the SDK that P4-10 reproduces"],
  [rx("^packages/module-api/test/(?:agent-audience|api-delegation|api-principal|audience|notify-eligibility|trust|control-server|orphan-watch)\\.test\\.ts$"), "P4-10", "T", "server half of the SDK (plan P4-10 source)"],
  [rx("^packages/module-api/test/"), "—", "", "published module SDK, stays TypeScript (ADR-016 §1, Q7)"],
  [rx("^packages/providers/test/"), "P4-41", "V,W", "recorded exchanges per wire format, cache-profile vectors"],
  [rx("^packages/channels-(telegram|discord|slack|signal|email|matrix|buzz)/test/"), "P4-6x", "W", "recorded adapter exchanges; the digit follows the adapter (table owner)"],
  [rx("^packages/voice-providers/test/local"), "P4-93", "", "local voice is not in 0.1"],
  [rx("^packages/voice-providers/test/"), "P4-52", "W", "plan P4-52"],
  [rx("^packages/media/test/"), "P4-53", "W,T", "plan P4-53"],
  [rx("^packages/documents/test/"), "P4-53", "", "rendering is covered by the documents-golden CI job (PDF goldens) until the Rust driver renders them"],
  [rx("^packages/hostctl/test/"), "P4-31", "V", "plan P4-31"],
  [rx("^packages/remote-access/test/"), "P4-80c", "T", "applies if P4-80 ports the API (Q1); stays TypeScript for 0.1"],
  [rx("^packages/remote-fs/test/"), "P4-85", "", "follows import, which may stay TypeScript for 0.1"],
  [rx("^packages/api/test/"), "P4-80a", "T", "HTTP request/response pairs against a fake core, applies if P4-80 ports the API (Q1); stays TypeScript for 0.1"],
  [rx("^packages/embedding-adapters/test/"), "P4-90", "", "package deleted by P4-90 (Q8)"],
  [rx("^packages/config-schema/test/"), "P4-11", "V", "config fixtures"],
  [rx("^packages/log-schema/test/"), "P4-11", "V", "log schema vectors (Rust mirror)"],
  [rx("^packages/rpc-schema/test/"), "P4-10", "V", "508 contract fixtures, gate G1"],
  [rx("^packages/webmcp/test/"), "—", "", "browser code, stays TypeScript"],
  [rx("^packages/module-fixture/test/"), "—", "", "test fixture module"],
];

/** Files of a non-UI package that are neither src nor tests (kept visible, not mapped to a package). */
export const TOOLING_RULES = [
  [rx("^packages/core/bench/"), "benchmark script, not harness runtime"],
  [rx("^packages/documents/scripts/"), "golden-render script of the documents-golden CI job"],
  [rx("^packages/module-fixture/"), "fixture module entry point"],
];

/** tests/system suites (mode S). [file name, owner, note]. */
export const SYSTEM_SUITES = [
  ["a2a.test.ts", "P4-72", ""], ["admin.test.ts", "P4-22", "plan P4-22 names `admin`"], ["backup.test.ts", "P4-51", ""],
  ["config-restart.test.ts", "P4-10", "named in the P4-10 PR"], ["desktop-attach.test.ts", "P4-80c", ""], ["dreams.test.ts", "P4-51", ""],
  ["extensions.test.ts", "P4-70", ""], ["help-isolation.test.ts", "P4-10", "named in the P4-10 PR"], ["identity.test.ts", "P4-12", ""],
  ["import.test.ts", "P4-85", ""], ["kill-soak.test.ts", "P4-10", "named in the P4-10 PR"], ["mcp-server.test.ts", "P4-70", ""],
  ["memory-ops.test.ts", "P4-51", ""], ["model-discovery.test.ts", "P4-44", ""], ["model-switch.test.ts", "P4-43", ""],
  ["modules.test.ts", "P4-10", "named in the P4-10 PR"], ["oauth.test.ts", "P4-80b", ""], ["portable-backup.test.ts", "P4-51", ""],
  ["reconnect.test.ts", "P4-10", "named in the P4-10 PR"], ["redaction-everywhere.test.ts", "P4-20", "named in the P4-10 PR"], ["reembed.test.ts", "P4-51", ""],
  ["secrets.test.ts", "P4-20", ""], ["install-scripts.test.ts", "—", "installer scripts; starts no core"], ["setup.test.ts", "—", "CLI setup; runs against whichever core `core run` starts"], ["sessions.test.ts", "P4-40", ""], ["turn-pipeline.test.ts", "P4-43", ""], ["two-session-recall.test.ts", "P4-40", ""],
];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|generated)\//;

export function classifyKind(path) {
  if (TEST_PATH.test(path)) return "test";
  if (/^packages\/[^/]+\/src\//.test(path)) return "src";
  return "other";
}

/** Non-UI TypeScript/JavaScript files under packages/, from `git ls-files`, sorted. */
export function listFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((p) => p && SOURCE_EXT.test(p) && !SKIP.test(p) && !UI_PACKAGES.includes(p.split("/")[1])).sort();
}

const ownerOf = (owner, path) => owner === "P4-6x" ? ({ telegram: "P4-60", discord: "P4-61", slack: "P4-62", signal: "P4-63", email: "P4-64", matrix: "P4-65", buzz: "P4-66" })[/^packages\/channels-([a-z]+)\//.exec(path)[1]] : owner;

export function classifySrc(path) {
  const i = SRC_RULES.findIndex(([re]) => re.test(path));
  if (i < 0) return { owner: "unassigned", disp: "unassigned", note: "no rule matches", rule: -1 };
  const [, owner, disp, note, provisional] = SRC_RULES[i];
  return { owner, disp, note, provisional: provisional === true, rule: i };
}

export function classifyTest(path) {
  const i = TEST_RULES.findIndex(([re]) => re.test(path));
  if (i < 0) return { owner: "unassigned", modes: "", reason: "no rule matches", rule: -1 };
  const [, owner, modes, reason, provisional] = TEST_RULES[i];
  return { owner: ownerOf(owner, path), modes, reason, provisional: provisional === true, rule: i };
}

const count = (text) => { let n = 0; for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++; return n; };
const fmt = (n) => n.toLocaleString("en-US");
const pad = (rows) => rows.map((r) => `| ${r.join(" | ")} |`);
const ownerRank = (o) => (o === "unassigned" ? "~" : o);
const byOwner = (a, b) => (ownerRank(a) < ownerRank(b) ? -1 : ownerRank(a) > ownerRank(b) ? 1 : 0);
const pkgOf = (p) => p.split("/")[1];

export function build(root = ROOT, files = listFiles(root)) {
  const src = [], tests = [], other = [];
  for (const path of files) {
    const kind = classifyKind(path);
    if (kind === "src") src.push({ path, ...classifySrc(path) });
    else if (kind === "test") tests.push({ path, ...classifyTest(path) });
    else other.push({ path, reason: TOOLING_RULES.find(([re]) => re.test(path))?.[1] });
  }
  return { src, tests, other };
}

export function render({ src, tests, other }, systemFiles = []) {
  const L = [];
  const owners = [...new Set([...src.map((r) => r.owner), ...tests.map((r) => r.owner)])].sort(byOwner);
  L.push("# Module map of the TypeScript core (Phase 4) → Rust packages", "");
  L.push("Generated by `scripts/parity/module-map.mjs`; do not edit. Regenerate with `node scripts/parity/module-map.mjs`; `--check` (run by the advisory `core-parity` job only, not by `pnpm docs:check`) fails when this file is not what the rules produce, so a new, moved or removed file without a rule change is caught.", "");
  L.push("Scope: every `src` file of every non-UI TypeScript package (`packages/*` except `web`, which stays TypeScript, D129) and every test file of those packages, listed from `git ls-files`. Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` (PR #902; named, not linked, because it is not on `main` yet) §1 and §3 (package scopes). The file carries assignments only, no line counts, so it changes only when a file is added, removed or renamed or a rule changes; `node scripts/parity/module-map.mjs --stats` prints line counts on demand. **The mapping rules are the tables at the top of `scripts/parity/module-map.mjs`** (ordered, first match wins, each with the plan section or the evidence); a file no rule matches is `unassigned`, never guessed.", "");
  L.push("## Dispositions and modes", "", "| Disposition | Meaning |", "|---|---|", ...pad(Object.entries(DISPOSITIONS).map(([k, v]) => [`\`${k}\``, v])), "");
  L.push("| Mode | Meaning |", "|---|---|", ...pad(Object.entries(MODES).map(([k, v]) => [`\`${k}\``, v])), "");
  L.push("A test file with no mode carries a reason instead (test support, a package that stays TypeScript, a test of a retired mechanism). `V,T` means both modes apply.", "");

  // totals
  const disps = Object.keys(DISPOSITIONS);
  L.push("## Source files by owner and disposition", "", `| Owner | Files | ${disps.map((d) => `\`${d}\``).join(" | ")} |`, `|---|---:|${disps.map(() => "---:").join("|")}|`);
  const tot = Object.fromEntries(disps.map((d) => [d, 0]));
  let totFiles = 0;
  for (const o of owners) {
    const rows = src.filter((r) => r.owner === o);
    if (!rows.length) continue;
    const per = Object.fromEntries(disps.map((d) => [d, rows.filter((r) => r.disp === d).length]));
    for (const d of disps) tot[d] += per[d];
    totFiles += rows.length;
    L.push(`| ${o}${OWNERS[o] ? ` ${OWNERS[o]}` : ""} | ${rows.length} | ${disps.map((d) => per[d] || 0).join(" | ")} |`);
  }
  L.push(`| **all** | **${totFiles}** | ${disps.map((d) => `**${tot[d]}**`).join(" | ")} |`, "");

  const pkgs = [...new Set([...src, ...tests, ...other].map((r) => pkgOf(r.path)))].sort();
  L.push("## Files by TypeScript package", "", `| Package | src files | test files | other files | ${disps.map((d) => `src \`${d}\``).join(" | ")} |`, `|---|---:|---:|---:|${disps.map(() => "---:").join("|")}|`);
  for (const p of pkgs) {
    const s = src.filter((r) => pkgOf(r.path) === p);
    L.push(`| \`packages/${p}\` | ${s.length} | ${tests.filter((r) => pkgOf(r.path) === p).length} | ${other.filter((r) => pkgOf(r.path) === p).length} | ${disps.map((d) => s.filter((r) => r.disp === d).length).join(" | ")} |`);
  }
  L.push("");

  const modeKeys = Object.keys(MODES);
  L.push("## Test files by parity mode", "", "| Mode | Test files |", "|---|---:|");
  for (const m of modeKeys) L.push(`| \`${m}\` | ${tests.filter((r) => r.modes.split(",").includes(m)).length} |`);
  L.push(`| no mode, with a reason | ${tests.filter((r) => !r.modes && r.owner !== "unassigned").length} |`, `| unassigned owner | ${tests.filter((r) => r.owner === "unassigned").length} |`, `| **all** | **${tests.length}** |`, "");
  L.push(`Test files for mode S are the suites of \`tests/system/\` (${systemFiles.length}, table at the end): they run on both legs of \`PLUR1BUS_CORE_IMPL\`.`, "");

  // unassigned
  const un = src.filter((r) => r.disp === "unassigned"), ut = tests.filter((r) => r.owner === "unassigned"), uo = other.filter((r) => !r.reason);
  L.push("## Unassigned", "", `${un.length} source files, ${ut.length} test files (owner unknown; mode known where listed) and ${uo.length} other files have no rule. They are visible on purpose; the first PR that touches the subsystem, or an owner answer, adds the rule.`, "");
  if (un.length) L.push("| Source file |", "|---|", ...pad(un.map((r) => [`\`${r.path}\``])), "");
  if (ut.length) L.push("| Test file | Mode | Why |", "|---|---|---|", ...pad(ut.map((r) => [`\`${r.path}\``, r.modes || "—", r.reason])), "");
  if (uo.length) L.push("| Other file |", "|---|", ...pad(uo.map((r) => [`\`${r.path}\``])), "");

  // provisional
  const pv = [...src.filter((r) => r.provisional).map((r) => [`\`${r.path}\``, "source", r.owner]), ...tests.filter((r) => r.provisional).map((r) => [`\`${r.path}\``, "test", r.owner])];
  L.push("## Provisional assignments", "", `${pv.length} files are assigned with low confidence (the evidence is in their note or reason) and wait for an owner answer.`, "");
  if (pv.length) L.push("| File | Kind | Proposed owner |", "|---|---|---|", ...pad(pv), "");

  // rows
  L.push("## Source rows", "", "Columns: file · disposition · note. A note starting with `PROVISIONAL` is a low-confidence assignment that needs the owner's confirmation.", "");
  for (const o of owners) {
    const rows = src.filter((r) => r.owner === o);
    if (!rows.length) continue;
    L.push(`### ${o}${OWNERS[o] ? ` — ${OWNERS[o]}` : ""}`, "", "| File | Disposition | Note |", "|---|---|---|", ...pad(rows.map((r) => [`\`${r.path}\``, r.disp, r.note])), "");
  }
  L.push("## Test rows", "", "Columns: file · mode · reason (the reason names why a test has no mode, or what the mode covers). A reason starting with `PROVISIONAL` is a low-confidence assignment that needs the owner's confirmation.", "");
  for (const o of owners) {
    const rows = tests.filter((r) => r.owner === o);
    if (!rows.length) continue;
    L.push(`### ${o}${OWNERS[o] ? ` — ${OWNERS[o]}` : ""}`, "", "| File | Mode | Reason |", "|---|---|---|", ...pad(rows.map((r) => [`\`${r.path}\``, r.modes || "—", r.reason])), "");
  }
  L.push("## Other files of the packages", "", "Neither `src` nor tests; kept visible so nothing hides.", "", "| File | What |", "|---|---|", ...pad(other.map((r) => [`\`${r.path}\``, r.reason ?? "unassigned"])), "");
  L.push("## System suites (mode S)", "", "| Suite | Owner | Note |", "|---|---|---|", ...pad(systemFiles.map((r) => [`\`tests/system/${r.name}\``, r.owner, r.note])), "");
  return `${L.join("\n")}\n`;
}

export function systemSuites(root = ROOT) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "tests/system"], { cwd: root, encoding: "utf8" }).split("\0").filter((p) => /^tests\/system\/[^/]+\.test\.ts$/.test(p)).map((p) => p.slice("tests/system/".length)).sort();
  return files.map((name) => { const hit = SYSTEM_SUITES.find(([n]) => n === name); return hit ? { name, owner: hit[1], note: hit[2] } : name === "helpers.test.ts" ? { name, owner: "P4-02", note: "tests of the harness helpers" } : { name, owner: "unassigned", note: "no entry in SYSTEM_SUITES" }; });
}

/** Line counts (raw lines, comments and blank lines included) per owner and in total, printed on demand and never written. */
export function stats(root = ROOT) {
  const { src } = build(root);
  const per = new Map();
  for (const r of src) { const e = per.get(r.owner) ?? { files: 0, lines: 0 }; e.files++; e.lines += count(readFileSync(`${root}${r.path}`, "utf8")); per.set(r.owner, e); }
  const rows = [...per.entries()].sort(([a], [b]) => byOwner(a, b));
  const total = rows.reduce((t, [, e]) => ({ files: t.files + e.files, lines: t.lines + e.lines }), { files: 0, lines: 0 });
  return { rows, total };
}

export function generate(root = ROOT) { return render(build(root), systemSuites(root)); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = generate();
  const path = `${ROOT}${OUTPUT}`;
  if (process.argv.includes("--stats")) {
    const { rows, total } = stats();
    for (const [o, e] of rows) console.log(`${o.padEnd(12)} ${String(e.files).padStart(5)} files ${fmt(e.lines).padStart(9)} lines`);
    console.log(`${"all".padEnd(12)} ${String(total.files).padStart(5)} files ${fmt(total.lines).padStart(9)} lines`);
  } else if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch { /* missing */ }
    if (current !== text) { console.error(`${OUTPUT} is out of date; run: node scripts/parity/module-map.mjs`); process.exit(1); }
    console.log(`${OUTPUT} is up to date`);
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${OUTPUT}`);
  }
}

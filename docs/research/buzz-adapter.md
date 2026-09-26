# Buzz x PLUR1BUS — adapter research, gap analysis, draft

Status: research note + local draft, 2026-09-26. Nothing pushed, no fork, no GitHub writes.

> Archived 2026-09-26 from a working session: paths under `/home/claude/...` refer to that session's container. The draft adapter commit is preserved as `docs/research/buzz-adapter/0001-feat-desktop-add-PLUR1BUS-agent-preset.patch` (apply to block/buzz `main` @ `781d39510` with `git am`; add your DCO sign-off before any push).
Buzz clone: `/home/claude/work/buzz` (block/buzz `main` @ `781d39510`, 2727 commits).
Draft branch: `feat/plur1bus-adapter`, one local commit `fc16f2149` (author Cyb3rb1ade noreply, **no DCO sign-off yet**, see §2).
Our side read from: `/home/claude/PLUR1BUS-Harness/.claude/worktrees/m1b-2a-h1` (docs) and `.../m1b-2a-h2` (current CLI, `docs/cli.md`).

---

## 0. Answer first

- A Buzz "adapter" is **data, not code**: one `PresetHarness` entry (id, label, command, args, install URL/hint) in
  `desktop/src-tauri/src/managed_agents/discovery/presets.rs`, plus a bundled logo, a one-line catalog description and a
  README list update. Buzz then spawns `<command> <args>` as an **ACP agent over stdio** (via its `buzz-acp` bridge) and
  speaks standard ACP JSON-RPC to it. There is no per-agent Rust/TS logic for tier-2 presets.
- So the whole difficulty is on **our** side: Buzz needs `plur1bus acp` — an ACP *agent server* on stdio that can run a
  real LLM turn **and** execute shell commands (the agent replies to Buzz only by running `buzz messages send`). None of
  that exists today: the harness has a memory CLI (`plur1bus memory add/recall …`) and a JSON-RPC core, no turn loop, no
  LLM providers, no tool execution, no ACP. Inbound ACP is D25 → **M2** (not 2b; 2b is MCP transport, D1/D17), and it
  needs 2c (session store + turn loop) and M2 providers first.
- The drafted adapter (7 files, +77/−1) targets the planned interface `plur1bus acp`. It is ready as a PR shape but must
  **not** go upstream until `plur1bus acp` works end to end against a local relay (§6).
- Usable **now** without any upstream change: Buzz's tier-3 custom harness JSON (same spawn path as a preset, §5.1), and
  PLUR1BUS memory for existing Buzz agents via their own shell/skills (§5.2).

---

## 1. How Buzz adapters work (with paths)

### 1.1 Process chain

Desktop (Tauri) never speaks ACP. Per managed agent it spawns one `buzz-acp` process
(`desktop/src-tauri/src/managed_agents/runtime.rs`, env injection at ~L611–747: `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`,
`BUZZ_AUTH_TAG`, plus `BUZZ_ACP_AGENT_COMMAND` / `BUZZ_ACP_AGENT_ARGS`, `BUZZ_ACP_AGENTS` parallelism).
`buzz-acp` (`crates/buzz-acp`) connects to the Nostr relay, subscribes to @mentions, and spawns the runtime command as an
ACP agent subprocess, one NDJSON JSON-RPC 2.0 stream on stdin/stdout (`crates/buzz-acp/src/acp.rs`, `AcpClient`).

### 1.2 Three tiers (`crates/buzz-acp/README.md` §"Bring Your Own Harness")

| Tier | Where | What it can carry |
|---|---|---|
| 1 compiled-in | `desktop/src-tauri/src/managed_agents/discovery/catalog.rs` (`KNOWN_ACP_RUNTIMES`, struct in `discovery/runtime_metadata.rs`) — goose, claude, codex, buzz-agent | install commands, auth probe (`auth_probe_args`), model/provider/effort env keys, `skill_dir`, `config_file_path`, `mcp_command`, onboarding |
| 2 preset | `desktop/src-tauri/src/managed_agents/discovery/presets.rs` (`PRESET_HARNESSES`) — pi, devin, cursor, omp, grok, opencode, kimi, amp, hermes, openclaw (+ our plur1bus) | `id, label, command, args, install_instructions_url, install_hint, underlying_cli(+hint/url)` only. No install scripts, no auth probe (`AuthStatus::NotApplicable`), no env, no MCP, `can_auto_install=false`, PATH-probed. Ids auto-reserved (`preset_harness_ids()` → `custom_harnesses.rs`). |
| 3 custom | `<app-data>/custom_harnesses/*.json`, loader `desktop/src-tauri/src/managed_agents/custom_harnesses.rs`, also creatable from Settings UI | `{id,label,command,args,env,installInstructionsUrl,installHint}`; env is a floor, `BUZZ_*` identity keys stripped |

Capability detection = PATH probe of `command` (and `underlying_cli` for adapter-wrapping presets) →
`AcpAvailabilityStatus::{Available, NotInstalled, AdapterMissing, CliMissing}` (`preset_catalog_entry` in
`presets.rs`, `classify_runtime` in `discovery.rs`). Nothing checks that a daemon behind the command is running
(OpenClaw README note: "Available" even when the Gateway is down — accepted tier-2 semantics).

Per-command special cases live outside the preset table and are keyed on the normalized command identity:
`crates/buzz-acp/src/config.rs` `default_agent_args` (goose→`acp`, zero-arg adapters) and `default_agent_env`
(Hermes: `HERMES_ACP_SKIP_CONFIGURED_MCP=1`); `desktop/src-tauri/src/managed_agents/parallelism.rs`
`harness_max_parallelism` (openclaw capped at 5). PLUR1BUS needs none of these for a first cut.

### 1.3 The ACP conversation Buzz runs (what `plur1bus acp` must implement)

From `crates/buzz-acp/src/acp.rs` and `pool.rs`:

1. `initialize` — Buzz sends `protocolVersion: 2` (deliberate non-standard pin "ahead of the ACP RFD", L656),
   `clientCapabilities: { auth: { terminal: true }, _meta: { goose: {customNotifications:true}, "terminal-auth": true } }`,
   `clientInfo {name:"buzz-acp"}`. Reads back `protocolVersion`, `agentCapabilities`, `_meta.steering.supported`,
   `authMethods`. An agent answering `protocolVersion: 1` is accepted (all Buzz test fixtures do).
2. `authenticate {methodId}` — only if the agent advertises auth methods. We should advertise none.
3. `session/new { cwd, mcpServers: [McpServerStdio…], systemPrompt?, _meta.sessionTitle? }` → must return `sessionId`
   (optionally models / configOptions). System prompt transport (`pool.rs` `session_new_system_prompt`): agent name
   `buzz-pi-acp` → `_meta.systemPrompt` string; `@agentclientprotocol/claude-agent-acp` → `_meta.systemPrompt:{append}`;
   any other agent with protocolVersion ≥ 2 → bare `systemPrompt` field; protocolVersion 1 → no field, Buzz prepends the
   standing context (base prompt, persona, team instructions, core engram) into the first `session/prompt` text instead
   (`prepend_standing_for_legacy`). **For presets `mcpServers` is empty** (`mcp_command: None`; `build_mcp_servers` in
   `crates/buzz-acp/src/lib.rs` only ever injects one global `buzz-dev-mcp`).
4. `session/prompt { sessionId, prompt: [text blocks] }` — slash commands arrive as first block `"/cmd …"`. Streams
   `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
   `usage_update`, `session_info_update`) and must answer `{ stopReason: end_turn|cancelled|max_tokens|max_turn_requests|refusal, usage? }`.
   Idle timeout default **1500 s** resetting on any stdout line (`config.rs` `DEFAULT_IDLE_TIMEOUT_SECS`), plus a hard cap;
   lines bounded to 10 MB (`MAX_LINE_SIZE`).
5. `session/cancel` (notification) → Buzz drains until `stopReason:"cancelled"` within a grace deadline, else kills.
6. `session/request_permission` from the agent → Buzz **auto-selects the `allow_once` option** (else `reject_once`).
   Optional: `session/set_model`, `session/set_config_option`, steering extension (`_meta.steering.supported`).
7. **Reply path:** Buzz does *not* post the ACP message stream to the channel. The base prompt
   (`crates/buzz-acp/src/base_prompt.md`) tells the model: "If your turn produced anything worth knowing, you MUST publish
   it. Use `buzz messages send`." The agent must run the `buzz` CLI in a shell with `BUZZ_RELAY_URL`,
   `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG` (injected into the harness process env). An agent without shell execution is
   mute in Buzz.

### 1.4 Tests and docs for presets

- Rust unit tests in `presets.rs` `mod tests` (per-preset invocation test, catalog entry via injectable resolver);
  run with `cargo test --manifest-path desktop/src-tauri/Cargo.toml preset` (desktop crate is outside the root workspace).
- `desktop/src/features/onboarding/ui/presetLogos.test.mjs` parses `PRESET_HARNESSES` from the Rust source and asserts
  every preset id has a `PRESET_LOGOS` entry (`RuntimeIcon.tsx`) whose file exists in `desktop/public/harness-logos/`.
- Curated description in `desktop/src/features/settings/ui/harnessCatalogCopy.ts` (policy: one neutral, vendor-sourced
  sentence with inline source comment) — a missing entry was the **blocking review finding** on the Pi PR (#7208).
- Logo provenance row in `desktop/public/harness-logos/CREDITS.md` (only redistributable marks).
- README tier-2 list + contributor guide in `crates/buzz-acp/README.md` §"Adding a preset (contributor guide)".
- Onboarding visibility lists (`onboardingRuntimeSelection.ts`, `harnessConnectionOptions.ts`) are optional; Pi and
  Devin shipped without them.

### 1.5 Previous "add adapter" PRs

| PR | Title | Files / size | Review |
|---|---|---|---|
| #3225 (2026-07-27→30) | Add Devin as a preset ACP harness | 7 files, +351/−310 (includes moving presets into `discovery/presets.rs`) | 1 maintainer approval (tlongwell-block), "no blocking findings"; 25 checks; external contributor; PR body cited the vendor docs for the ACP entrypoint, linked the BYOH issue #2773, listed test counts and `just ci` |
| #7208 (2026-09-01, ~1 h 20 min) | feat(desktop): add Pi agent preset | 7 files, +91/−5 (presets.rs, logo + CREDITS, RuntimeIcon, catalog copy + test, README) | wpfleger96 requested changes (missing catalog description), then approved; 44 checks |
| #3516 | fix(desktop): point Oh My Pi preset at omp.sh | 1 file, +1/−1 | metadata-only; body shows HTTP 200 checks + focused test + `just ci` |

Related merged: #2773 BYOH seam (the tier system), #3420 per-runtime env defaults (Hermes), #4019 OpenClaw
parallelism cap, #7552 Pi adapter fork integration. The GitHub PR search UI is robots-blocked for WebFetch and the
search API is not reachable from this session; the list above comes from `git log` (squash commits carry the PR body)
plus WebFetch of the two PR pages.

---

## 2. Contribution requirements (CONTRIBUTING.md, AGENTS.md)

- **DCO, not CLA.** Every commit needs `Signed-off-by` (`git commit -s`); the required "DCO Check" blocks the PR.
  The local draft commit is deliberately **not** signed off: the sign-off is the owner's personal certification.
  Before pushing: `git rebase --signoff main` (or `git commit --amend -s`) as Cyb3rb1ade.
- **Conventional Commits** required; squash-merge, so the PR title becomes the commit subject
  (draft uses `feat(desktop): add PLUR1BUS agent preset`, matching #7208).
- Search open PRs/issues for duplicates and link the closest one ("none found" otherwise). "Entirely new features with
  no prior discussion" are likely to be closed — a preset is a small data entry (Devin/Pi went straight to PR), but an
  issue first ("Add PLUR1BUS as a preset ACP harness") is the safe route, especially for a young project.
- Tests for new behaviour; `just ci` must pass (fmt, clippy `-D warnings`, file-size ratchet — desktop Rust ≤ 1500
  lines/file, biome, tsc, Rust/Tauri/desktop/mobile tests, builds). Linux needs GTK/WebKitGTK dev libs for the Tauri crate.
- AGENTS.md PR checklist: open as **draft**; agent review; an agent exercised the change; **a human tested it
  themselves**; only then add `buzz-review-completed` to the PR body. UI-visible changes need before/after screenshots
  (via `scripts/post-screenshots.sh`, never relay media URLs). AI-assisted PRs are fine; the author must have reviewed
  the code. Don't force-push during review.
- Preset guide step 1: "Verify the ACP entrypoint from the vendor's own documentation … Test with the actual binary."
  → upstream reviewers will expect a published `plur1bus acp` doc page and a release they can install.
- License Apache-2.0; contributions licensed under it. Our logo is MIT (owner's own mark) — fine, recorded in CREDITS.

---

## 3. The gap on our side

| Buzz needs | PLUR1BUS today (m1b-2a-h2) | Planned where |
|---|---|---|
| `plur1bus` on PATH | yes (Rust CLI) | 2a |
| `plur1bus acp` ACP agent server on stdio | **absent** (no `acp` subcommand; stubs name M2/M3/M4) | D25 inbound ACP → **M2** |
| a real turn: LLM call, streaming, stop reasons, cancel | **absent** — no providers, no turn loop | 2c (session store, submit/event turn loop, compaction) + M2 (providers, D15/D16) |
| sessions keyed by Buzz session (`session/new` → id; resume across prompts) | absent | 2c; D32(e) SessionScope |
| shell/tool execution so the model can run `buzz messages send` | **absent** — tool execution with `Principal` is "needed by 2b", shell tools via MCP plugins (D38, 2b) | 2b/2c |
| BUZZ_* credentials reaching the tool execution locus (the core, not the `plur1bus acp` shim) | n/a | **design decision needed** (§4, T4) |
| accept `systemPrompt` field (if we answer protocolVersion 2) or tolerate standing context inline (if 1) | n/a | D32(g) transport table (inbound side) |
| permission requests | n/a | D32 rejects `allow_once`; Buzz auto-answers `allow_once` → our policy must not depend on the ACP client's answer |
| memory for the agent | yes: `memory add/recall --agent … --json` over the core RPC (stable, ADR-016) | 2a (works today) |

Conflicts with our own decisions that the owner has to weigh:

- **D32 rejects "CLI-side-effect replies instead of the ACP stream"** — Buzz's contract *is* CLI side effects
  (`buzz messages send`). For Buzz we must ship a Buzz-posting capability anyway; the ACP stream still carries the full
  turn (our provenance, ADR-016), the Buzz post is an additional tool effect.
- **D32(d) "no credentials in env vars"** — Buzz hands the agent's Nostr key only via env (`BUZZ_PRIVATE_KEY`). The shim
  receives it from Buzz; the question is only whether it is forwarded to the core per session over the local RPC
  (in memory, never persisted) or whether the core's Buzz channel adapter (M4, nostr-tools) uses it.
- **D32/D38 reject auto-approval** — Buzz auto-approves every ACP permission request. Dangerous-tool approval must be
  enforced harness-side (human's own channel, D21/D24), treating Buzz as a client that always says yes.

Alternative integration (different direction): M4 already plans **Buzz as a channel** (nostr-tools) — PLUR1BUS agents
join Buzz rooms as members with their own keys, no Buzz desktop needed. The ACP preset is the "Buzz manages a PLUR1BUS
agent" direction; both can coexist and should share the same Buzz posting code in the core.

---

## 4. Proposed harness-side plan outline (Buzz integration)

Order respects the approved milestone chain (2a → 2b → M1b-3 → 2c → M2 …); nothing here pulls work forward without an
owner decision.

- **T0 (now, docs only):** record the Buzz contract (§1.3) as the first consumer of D25 inbound ACP; add "Buzz preset"
  to ADR-011 / D25 acceptance ("an external ACP host drives a PLUR1BUS agent"). Owner decisions O1–O3 below.
- **T1 (now, zero code on Buzz side):** document the tier-3 custom harness JSON (§5.1) and a Buzz skill for existing Buzz
  agents to use PLUR1BUS memory via `plur1bus memory recall/add --json` (§5.2).
- **T2 (2b):** tool execution under a `Principal`; shell tool (Desktop Commander-class MCP plugin, D38) with harness-side
  approval policy; an allowlisted `buzz` CLI invocation is the reference safe command.
- **T3 (2c):** session store + turn loop exposed over core RPC (`session.new`, `session.prompt` streaming events,
  `session.cancel` with bounded grace) — the exact shape the ACP shim maps onto.
- **T4 (M2, D25):** `plur1bus acp [--agent <id>]` — thin stdio ACP server in the Rust CLI (or a TS module), mapping
  initialize/session.new/prompt/cancel/set_model onto the core RPC; answers `protocolVersion: 1` first (standard ACP,
  standing context arrives inline) and moves to 2 with a `systemPrompt` field when D32(g) lands; advertises no
  `authMethods`; emits `session/update` chunks and a keepalive during long recalls/LLM waits; maps `session/cancel`;
  forwards `BUZZ_RELAY_URL/BUZZ_PRIVATE_KEY/BUZZ_AUTH_TAG` from its env to the core as session-scoped, non-persisted
  tool environment (per O2); agent selection by `--agent` arg or env (`PLUR1BUS_AGENT`), since Buzz passes no agent id.
  Depends on M2 providers for the LLM.
- **T5 (M2):** conformance tests: replay Buzz's own fixtures (`crates/buzz-acp/src/acp.rs` tests use shell-scripted
  NDJSON agents) against `plur1bus acp`; a system test that runs the real `buzz-acp` binary (`cargo build -p buzz-acp`)
  with `BUZZ_ACP_AGENT_COMMAND=plur1bus BUZZ_ACP_AGENT_ARGS=acp` against a local relay (`just relay`) and asserts a
  mention → recall → `buzz messages send` round trip, cancel, and crash-respawn.
- **T6 (after T5 green):** publish docs page "Use PLUR1BUS with Buzz" at a stable URL (the preset's
  `install_instructions_url`), cut a release, open the Buzz issue, then the upstream PR from the drafted branch (§6).
- **T7 (M4, optional):** Buzz channel adapter (nostr-tools) sharing the posting code with T4.

Owner decisions needed: **O1** protocolVersion 1 vs 2 at launch; **O2** how BUZZ_* credentials reach the core's tool
environment (session-scoped forward vs M4 channel adapter owning the key); **O3** preset label/brand ("PLUR1BUS" vs
"PLUR1BUS Harness"), official logo, and which URL is the install/docs page.

---

## 5. What works today

### 5.1 Tier-3 custom harness (no upstream PR, same spawn path as the preset)

Save as `<app-data>/custom_harnesses/plur1bus.json` (or add via Settings → custom harness), once `plur1bus acp` exists:

```json
{
  "id": "plur1bus",
  "label": "PLUR1BUS",
  "command": "plur1bus",
  "args": ["acp"],
  "env": { "PLUR1BUS_AGENT": "bernd" },
  "installInstructionsUrl": "https://github.com/Cyb3rb1ade/PLUR1BUS-Harness",
  "installHint": "Install the PLUR1BUS harness and start its core daemon."
}
```

Caveat: if the upstream preset lands with id `plur1bus`, the preset reserves that id and a custom file with the same id
is skipped — use `plur1bus-dev` for local testing. Env shown is an assumption (agent selection, §7).

### 5.2 PLUR1BUS memory inside existing Buzz agents (today, no ACP)

Claude Code / Codex / Goose agents in Buzz have shells and skill dirs (`.claude/skills`, `.codex/skills`,
`.goose/skills`). A small skill telling the agent to call `plur1bus memory recall --agent <id> --json "<query>"` before
answering and `plur1bus memory add --agent <id> --json "<fact>"` for durable facts works against the 2a core today
(stable commands, ADR-016). After 2b, the same agents can attach the PLUR1BUS MCP server through their *own* MCP config
(Buzz does not inject per-agent MCP servers; `build_mcp_servers` is one global `buzz-dev-mcp`). This is D28's
"central memory for external agentic systems" role, and needs nothing from Buzz upstream.

---

## 6. When to open the upstream PR

Only when all of these hold (Buzz's own preset guide requires testing "with the actual binary"):

1. `plur1bus acp` is released (installable by a stranger from the linked URL) and documented there.
2. T5 passes: the real `buzz-acp` drives `plur1bus acp` against a local relay — mention in, recall, `buzz messages send`
   out, cancel within grace, respawn after kill.
3. The owner has tested it in the Buzz desktop app himself (AGENTS.md step 3; screenshots of the catalog entry for the
   PR body).
4. Official logo and label settled (O3); DCO sign-off added by the owner.
5. A Buzz issue exists (or a duplicate search found none) and is linked from the PR.

Realistically that is **after M2** (inbound ACP + providers), not before. Until then use §5.1/§5.2. Opening earlier
would advertise a command that does not exist, which the reviewers' first step ("verify the ACP entrypoint") would
catch, and it would burn goodwill.

PR checklist when the time comes: rebase on current `main` (presets.rs changes often — 11 commits since July), re-run
`cargo test --manifest-path desktop/src-tauri/Cargo.toml preset`, `pnpm --dir desktop test`, `just ci`, `git rebase
--signoff`, open as **draft**, body in the #3225 shape (Summary / Related issue / Scope / Testing), add
`buzz-review-completed` only after the human test.

---

## 7. The drafted adapter

Branch `feat/plur1bus-adapter` in `/home/claude/work/buzz`, commit `fc16f2149` `feat(desktop): add PLUR1BUS agent preset`:

| File | Change |
|---|---|
| `desktop/src-tauri/src/managed_agents/discovery/presets.rs` | new `PresetHarness { id: "plur1bus", label: "PLUR1BUS", command: "plur1bus", args: &["acp"], install_instructions_url: "https://github.com/Cyb3rb1ade/PLUR1BUS-Harness", install_hint: …daemon…, underlying_cli: None }` appended after openclaw; test `plur1bus_preset_uses_native_acp_invocation` (available/not-installed, args, source, no parallelism cap) modeled on the Devin test |
| `desktop/src/features/onboarding/ui/RuntimeIcon.tsx` | `PRESET_LOGOS.plur1bus = "/harness-logos/plur1bus.svg"` |
| `desktop/public/harness-logos/plur1bus.svg` | placeholder mark (ring + "1", 64×64, dark tile) — **replace with the official PLUR1BUS logo** |
| `desktop/public/harness-logos/CREDITS.md` | provenance row, MIT © 2026 Cyb3rb1ade |
| `desktop/src/features/settings/ui/harnessCatalogCopy.ts` (+ `.test.mjs`) | "A self-hosted multi-agent harness built around the PLUR1BUS memory core." with source comment (README of the harness repo) |
| `crates/buzz-acp/README.md` | PLUR1BUS added to the tier-2 list + a note (daemon-backed like OpenClaw; tools run in the core; BUZZ_* env reaches the shim, not the core, unless forwarded) |

Not touched on purpose: onboarding lists (Pi/Devin omitted them too), `default_agent_args`/`default_agent_env`,
parallelism cap (the core is multi-tenant; add a cap only if T5 shows contention).

Assumptions (all to be re-verified before upstreaming):

- A1 the ACP entrypoint is `plur1bus acp` with no further required args (agent chosen by default config, env
  `PLUR1BUS_AGENT`, or a later `--agent` flag — if a flag becomes mandatory, `args` must carry it or the preset needs a
  default agent).
- A2 the binary name on PATH is `plur1bus` on all platforms (Windows `plur1bus.exe` resolves via Buzz's PATH probe).
- A3 no `underlying_cli`: `plur1bus acp` is not a wrapper around a separately installed vendor CLI; the daemon it needs
  is part of the same install.
- A4 no auth probe/`authMethods`: login happens in PLUR1BUS itself (`plur1bus login`, M2), never through Buzz.
- A5 the install/docs URL is the harness repo root until a dedicated "Use with Buzz" page exists (O3).
- A6 label "PLUR1BUS"; description paraphrases the harness README; logo is a placeholder.

Verification run locally:

- `rustfmt --edition 2021 --check presets.rs` — clean (after one rustfmt pass on the new test).
- `presetLogos.test.mjs` + `harnessCatalogCopy.test.mjs` — 16/16 pass (includes "preset plur1bus has a bundled logo").
- `biome check` on the touched TS files — clean after `--write` on one line wrap; `tsc --noEmit` for desktop — exit 0.
- Full desktop JS suite (non-jsdom half of `pnpm test`): 6678 tests, 6645 pass, 33 fail — all 33 in unrelated files
  (canvas, thread replies, inbox, project git views, known-agent pubkeys), every one with the same loader error
  `Expected a string … for the "source" from the "load" hook but got null` — a Node 22 vs required Node 24 loader-hook
  incompatibility in this container, not caused by the draft. Re-run on Node 24 before a PR.
- **Not run:** the Tauri Rust tests (`cargo test --manifest-path desktop/src-tauri/Cargo.toml`) and `just ci` — this
  container lacks `libwebkit2gtk-4.1-dev`/GTK and has 2 cores / 11 GB free disk. The new Rust test mirrors the passing
  Devin test field for field; it must be run before any PR.
- Desktop deps were installed with `pnpm install --filter ./desktop --frozen-lockfile --ignore-scripts` (Node 22 here;
  Buzz wants Node 24).

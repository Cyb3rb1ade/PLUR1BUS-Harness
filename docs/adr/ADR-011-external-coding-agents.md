# ADR-011: External coding agents

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D5, D6, D11; `docs/phase0/auftrag-original-2026-09-21.md` §7, §8, §10, §11, §12 (M6), §13 Q3; `docs/phase0/research/protocols-channels-coding-clis.md` (Coding CLIs, ACP ecosystem, minimum-viable adapter strategy); `docs/phase0/research/providers-chat-auth-caching.md` (subscription-login policy); `docs/phase0/research/hermes-learnings-and-import.md` A2, A12; `docs/phase0/research/harness-engineering-state-of-the-art.md` §5; local repos `agent-client-protocol@bba7ddf`, `buzz@77729ab`; ADR-003, ADR-005, ADR-008

## Context

D5 promotes "attach any installed coding CLI" to a first-class subsystem: auto-detect the binary, reuse its login, expose it as an agent for `delegate_task` / `consult_agent`, project boards and channels, on an ACP basis with a PTY/JSON adapter for CLIs without ACP. M6 acceptance requires "an external ACP agent as a team member" (auftrag §12).

What the evidence supports:

- **ACP covers most of the target list, and more of it than the research note concluded.** The ACP registry in the checked-out repo (`docs/get-started/registry.mdx` @ `agent-client-protocol` `bba7ddf`) is described as "a curated set of agents, including only the ones that support authentication" and lists, with versions: Claude Agent **0.79.0** (`agentclientprotocol/claude-agent-acp`), Codex **1.12.0** (`agentclientprotocol/codex-acp`), goose **1.51.0**, Gemini CLI **0.60.0**, GitHub Copilot **1.0.87**, Kimi CLI **1.51.0**, Qwen Code **0.24.3**, Cline **3.0.62**, OpenCode **1.18.31**, **Grok Build 1.0.40** (xAI), **Google Antigravity 1.1.1**, **pi ACP 0.0.33** (`svkozak/pi-acp`), Amp 0.9.0, Auggie 0.36.0. `docs/get-started/agents.mdx` additionally lists **Cursor** (`cursor.com/docs/cli/acp`), OpenClaw, Hermes Agent, OpenHands, Mistral Vibe, Kiro CLI and others. This **upgrades** several entries the research note marked "gap/unverified" — grok, pi, agy/Antigravity, OpenCode, Cline and Cursor all have an ACP path.
- **Only three are cross-validated by a real third-party harness.** `buzz-acp` documents exactly three agents it has wired up and tested: **goose** (native `goose acp`), **codex** (via `@agentclientprotocol/codex-acp`), **claude code** (via `@agentclientprotocol/claude-agent-acp`) — `crates/buzz-acp/README.md:12,65,69-93` @ `buzz` `77729ab`. Registry listing ≠ working integration.
- **As the ACP client we hold the dangerous capabilities.** ACP v1 client methods are `session/request_permission`, `session/update`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `elicitation/create|complete` (`schema/v1/meta.json`, `schema/v1/schema.json` `x-method` @ `bba7ddf`). The external agent *asks us* to read files, write files and run commands — so containment is enforceable by us, not delegated to the vendor's own sandbox.
- **Headless JSON modes exist as a fallback for the two highest-value CLIs.** `claude -p --output-format text|json|stream-json` (one JSON event per line), plus `--allowedTools`/`--disallowedTools`, `--max-turns`, `--max-budget-usd`; `codex exec --json` → JSON-Lines with `thread.started`, `turn.started`, `turn.completed`, `item.started`, `item.completed`, `error`, plus `--sandbox {read-only|workspace-write|danger-full-access}`, `--ephemeral`, `--output-schema` (`protocols-channels-coding-clis.md`, Coding CLIs, citing code.claude.com and learn.chatgpt.com docs, 2026-09-22).
- **Credential stores are documented, and we must not touch their contents.** Claude Code: macOS Keychain with `~/.claude/.credentials.json` (mode `0600`) as fallback, `~/.claude/.credentials.json` on Linux, `%USERPROFILE%\.claude\.credentials.json` on Windows, directory overridable via `CLAUDE_CONFIG_DIR`; `claude setup-token` mints a ~1-year OAuth token exposed as `CLAUDE_CODE_OAUTH_TOKEN`. Codex: `~/.codex/auth.json`, documented as "treat like a password: it contains access tokens", root overridable via `$CODEX_HOME`, CI path `CODEX_API_KEY`. Qwen Code: `~/.qwen/settings.json`; the Qwen OAuth free tier was **discontinued 2026-04-15**, and the docs steer headless users to env vars/API keys (all `protocols-channels-coding-clis.md`, Coding CLIs).
- **Vendor policy makes "run the vendor's own CLI" the only compliant path for subscription logins.** Anthropic's legal/compliance doc states verbatim that OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens" ([Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), fetched 2026-09-22, via `providers-chat-auth-caching.md`). Gemini CLI's terms name the pattern explicitly: "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services … is a violation of applicable terms and policies" ([Gemini CLI ToS & Privacy](https://geminicli.com/docs/resources/tos-privacy/), fetched 2026-09-22, ibid.). OpenAI's position on Codex OAuth in third-party harnesses is **ambiguous/unclarified** ([openai/codex Discussion #8338](https://github.com/openai/codex/discussions/8338), maintainer response 2025-12-19, ibid.). xAI's SuperGrok OAuth is undocumented and entitlement-gated (403s to legitimate subscribers, ibid.).
- **pi's objection applies double here.** An opaque vendor CLI invoked as a black box is exactly "a black box within a black box" ([Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), via `harness-engineering-state-of-the-art.md` §5).
- **Hermes already proved the ACP-client direction works**, driving GitHub Copilot's CLI as an external ACP subprocess (`plugins/model-providers/copilot-acp/__init__.py:1-60`, via `hermes-learnings-and-import.md` A2/A12) — including the cost we inherit: enumerating models required spinning up a real ACP session, because the CLI's login lives in a credential store the harness cannot read.

## Decision

Build a **three-tier external-agent subsystem** with ACP as the primary and preferred tier. An attached CLI becomes a **first-class harness agent** (`engine.kind = "external"`, ADR-003) with its own persona preamble, approval policy, budget, project membership and channel bindings — and with its output treated as data. **Discovery never reads a credential file's contents**: we probe the binary, its version and observable login state, and then let the child process resolve its own authentication from its own home directory, which is also the only ToS-compliant way to use subscription logins. Every external run is a **replayable harness session**. As the ACP client we implement `fs/*` and `terminal/*` ourselves and scope them to the project worktree, which is the strongest containment available and is unavailable in Tiers 2 and 3.

### Discovery

| Step | Method | Rule |
|---|---|---|
| Binary | `PATH` probe (`which`/`where`, plus per-vendor default install paths); user may pin an absolute path | Never execute anything found outside `PATH` without explicit operator confirmation |
| Version | documented `--version` with a bounded-probe wrapper | Timeout + kill; a hang is not an exception (Hermes needed `bounded_probe_run` because `subprocess.run(timeout=…)` can hang forever on Windows when a `conhost.exe` descendant holds duplicated pipe handles — `hermes_cli/subcommands/claw.py:106-109`, bug `#87134`, via `hermes-learnings-and-import.md` A14) |
| ACP capability | the vendor's documented ACP entry point (`--acp`, `acp` subcommand, or the adapter package), probed by an `initialize` handshake with a short timeout | Handshake only; no session created |
| Login state | **existence and mode of the credential path only** (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.qwen/settings.json`, `%USERPROFILE%\.claude\.credentials.json`), or a documented non-secret status command, or macOS Keychain *presence* | **Never read, copy, parse, log or forward the contents.** Report `logged-in` / `not-detected` / `unknown`, never a token |
| Env | construct the child env from an allowlist plus the CLI's own `*_HOME`/`*_CONFIG_DIR` | `process.env` is never inherited wholesale (ADR-003 isolation table) |

If a CLI is not logged in, the harness shows the vendor's own documented login command and lets the user run it — it never proxies, brokers or stores a vendor credential. The only tokens the harness may hold are ones the vendor documents for programmatic use and the user pastes deliberately (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, `CODEX_API_KEY`, a Qwen API key); these live in the secret store (ADR-005) scoped to that external agent.

### Adapter tiers

**Tier 1 — ACP (native or adapter).** One code path, the ACP client from ADR-008 (`@agentclientprotocol/sdk`, schema v1). Evidence level per CLI:

| CLI | ACP path | Evidence level | Source |
|---|---|---|---|
| Claude Code | adapter `@agentclientprotocol/claude-agent-acp` (wraps the Claude Agent SDK; not built into the `claude` binary) | **Cross-validated** — working in `buzz-acp` | `crates/buzz-acp/README.md:85-93` @ `77729ab`; registry 0.79.0 @ `bba7ddf`. *Repo-owner ambiguity:* `registry.mdx:112` says `agentclientprotocol/claude-agent-acp`, `agents.mdx:12` says `zed-industries/claude-agent-acp` — pin at integration time |
| OpenAI Codex CLI | adapter `@agentclientprotocol/codex-acp` | **Cross-validated** — working in `buzz-acp`; note it attempts a ChatGPT WebSocket login first (logs a non-fatal `426`) and falls back to `OPENAI_API_KEY` | `crates/buzz-acp/README.md:69-81` @ `77729ab`; registry 1.12.0 |
| Goose | native `goose acp` | **Cross-validated** — working in `buzz-acp` | `crates/buzz-acp/README.md:65` @ `77729ab`; registry 1.51.0 |
| Gemini CLI | native `gemini --acp` | **Vendor-documented + called a reference implementation by the ACP project**, not third-party-validated | `docs/libraries/typescript.mdx:42` @ `bba7ddf`; registry 0.60.0; `protocols-channels-coding-clis.md` |
| GitHub Copilot CLI | native `copilot --acp` (stdio, or `--port`), public preview since 2026-01-28 | **Vendor-documented**; also the direction Hermes's `copilot-acp` provider drives | registry 1.0.87 @ `bba7ddf`; `hermes-learnings-and-import.md` A2 |
| Qwen Code | native (`packages/cli/src/acp-integration/acpAgent.ts`) | **Vendor-documented** | registry 0.24.3 @ `bba7ddf`; `protocols-channels-coding-clis.md` |
| Kimi CLI / Kimi Code | native `kimi acp` | **Vendor-documented** | registry 1.51.0 @ `bba7ddf` |
| Cline | native (CLI) | **Registry-listed only** | registry 3.0.62 @ `bba7ddf` |
| OpenCode | native | **Registry-listed only** (upgrades the note's "web-search-level" confidence) | registry 1.18.31 @ `bba7ddf`; `agents.mdx:37` |
| Cursor CLI | documented ACP path (`cursor.com/docs/cli/acp`) | **Registry/docs-listed only** (upgrades the note's "gap") | `agents.mdx:20` @ `bba7ddf` |
| Grok Build (xAI) | listed as an ACP agent | **Registry-listed only** (upgrades the note's "unverified") | `registry.mdx:689` (v1.0.40) @ `bba7ddf` |
| Google Antigravity (`agy`) | listed as an ACP agent | **Registry-listed only** (upgrades the note's "gap") | `registry.mdx:661` (v1.1.1) @ `bba7ddf` |
| pi | adapter `svkozak/pi-acp` | **Registry-listed only**; note that pi's author deliberately ships no subagent tool | `registry.mdx:878` (v0.0.33), `agents.mdx:39` @ `bba7ddf`; `harness-engineering-state-of-the-art.md` §5 |
| Amp, Auggie, Junie, OpenHands, Kiro, Mistral Vibe, … | registry entries | **Registry-listed only** | `registry.mdx` @ `bba7ddf` |

**Tier 2 — headless JSON / stream mode.** For CLIs whose ACP path proves brittle, and as the documented fallback for the two highest-value ones: `claude -p --output-format stream-json` (+ `--allowedTools`, `--max-turns`, `--max-budget-usd`), `codex exec --json` (+ `--sandbox workspace-write`, `--ephemeral`, `--output-schema`), Qwen Code headless mode, Cursor CLI headless, Antigravity CLI headless (**exact flags for the last three are unverified** — `protocols-channels-coding-clis.md` marks them as gaps). Tier 2 gives structured events but **no permission callback**: the CLI decides what to touch, so containment shifts to the workdir, the terminal backend sandbox and the CLI's own sandbox flags.

**Tier 3 — PTY with prompt/marker parsing.** Last resort, opt-in, marked "unsupported" in the UI. `node-pty` (prebuild on Windows arm64 is **not yet verified** — `docs/phase0/research/verification-log.md`), a per-CLI prompt/marker grammar, a hard wall-clock timeout and a mandatory sandboxed terminal backend. Candidates: **Aider** (Python, no ACP evidence found, headless/JSON flags unconfirmed — the one genuine Tier-3 case in the assignment's list) and anything else with no documented non-interactive mode. The CLIs the assignment listed as Tier 3 — grok, pi, agy, opencode, cline, cursor — all now have an ACP path (table above) and belong in Tier 1 at "registry-listed" evidence, not in Tier 3.

### The external agent as a first-class agent

An attached CLI is an `Agent` record (ADR-003) with `engine.kind = "external"`. It has: a `persona.md` used only as the prompt preamble we pass in (the vendor CLI keeps its own system prompt — we do not replace it); its **own** approval policy and budget; membership in projects; optional channel bindings; a place in `delegate_task` / `consult_agent` target lists and on project boards. It does **not** get the caller's permissions (ADR-003), and its output enters the calling agent as `tool_result` with provenance, never as instructions (auftrag §7, §11).

Memory: by default an external agent has **no PLUR1BUS store** — its results are captured as provenance-tagged cards in the *caller's* `agent-private` scope. A store is opt-in per external agent (open question 4 in ADR-003). It never receives `user`-scope or `agent-private` content belonging to other agents, and nothing is shared into it except through explicit `/share` (copy-never-move, re-embedding).

### Permission model

As the **ACP client** we implement the client-side methods, so we are the enforcement point:

| ACP client method | Harness behaviour |
|---|---|
| `session/request_permission` | routed to that external agent's approval policy (ADR-003); `auto` / `ask` / `deny` per tool class; `ask` surfaces in the UI and on the originating channel; identity-bound confirmation for destructive classes (auftrag §11) |
| `fs/read_text_file`, `fs/write_text_file` | path-contained to the agent's project **worktree** via the engine's `resolveInside` / `isPathInside` convention (`lib/sql-safety.js:121,23`, via `plur1bus-crons-embedding-portability.md` §3); symlink escape resolved through `realpath` before the check; writes also blocked outside the worktree even when the vendor agent believes it has permission |
| `terminal/create|output|wait_for_exit|kill|release` | commands run in the agent's configured terminal backend with the constructed env allowlist; dangerous-command detection and the conservative default from auftrag §11 apply; wall-clock and output caps enforced |
| `elicitation/create|complete` | surfaced as a harness clarification request to the originating human, never auto-answered by another agent |
| `session/update` | streamed into the harness session transcript and, where the behaviour profile allows, into the channel via streaming-by-edit |

Tiers 2 and 3 have no permission callback. There, containment is: a dedicated worktree as CWD, the sandboxed terminal backend, the CLI's own sandbox flag where one exists (`codex --sandbox workspace-write`), an explicit env allowlist, and a hard timeout. **`--dangerously-skip-permissions` and equivalents are never set by the harness** and are refused in configuration.

### Session mapping — the answer to pi's objection

Every external run is a harness session with a durable transcript: the prompt we sent, every `session/update` (or Tier-2 JSON event, or Tier-3 parsed marker), every permission request and its decision with actor and timestamp, every file read/written with path, every command with exit code, token/cost accounting where the CLI reports it, and the final result. It is replayable, diffable and attached to the project board entry that caused it. That is the difference between "we shelled out to a coding agent" and "a coding agent is a member of this project": the black box gets a glass wall, which is exactly the design response the dossier prescribes ([Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), via `harness-engineering-state-of-the-art.md` §5).

### Minimum set for M6 acceptance — recommendation (Q6)

**Tier 1, shipped and in CI: Claude Code, OpenAI Codex CLI, Goose. Tier 1, shipped best-effort: Gemini CLI. Tier 2 fallback: Claude Code and Codex. Everything else: discoverable and attachable, but labelled "community-tested, unverified" until a spike closes it.**

Why these four:

1. **Claude Code, Codex and Goose are the only three cross-validated end-to-end by a comparable third-party harness** (`buzz-acp` @ `77729ab`). That is the difference between "should work" and "known to work", and M6's acceptance criterion is a working external team member, not a support matrix.
2. **Claude Code and Codex are also the two with a documented, structured non-ACP fallback** (`claude -p --output-format stream-json`, `codex exec --json`), so a broken adapter release does not break M6.
3. **Goose is native ACP and Apache-licensed/open**, so it is the reference target for our client with no vendor-policy ambiguity — useful as the CI counterparty that can run without anyone's subscription.
4. **Gemini CLI is native ACP and is called a production-ready reference implementation by the ACP project itself**, which makes it the cheapest fourth; but it is not third-party-cross-validated, so it ships best-effort rather than as an acceptance gate.

Explicitly **not** in the M6 set, despite registry listings: Copilot CLI, Qwen Code, Kimi Code, Cline, OpenCode, Cursor, Grok Build, Antigravity, pi, Amp. Each gets a verification spike (below); any that passes can be promoted without a design change, because Tier 1 is one code path.

Acceptance for M6: attach each of the four by discovery; run one `delegate_task` per CLI against a fixture repository in a worktree; assert a permission request reached the approval policy and was honoured; assert a write outside the worktree was refused; assert the session transcript replays.

### Risks

| Risk | Detail | Mitigation |
|---|---|---|
| **CLI churn** | Registry versions move constantly (Claude Agent 0.79.0, Codex 1.12.0, Gemini 0.60.0, goose 1.51.0, Copilot 1.0.87 at `bba7ddf`); adapter packages are third-party and young (`pi-acp` 0.0.33, `amp-acp` 0.9.0) | Pin adapter versions per external agent; nightly integration job per Tier-1 CLI against a fixture repo; a CLI that fails two consecutive nights is auto-marked degraded in the UI |
| **Adapter-repo ambiguity** | `claude-agent-acp` is attributed to two different orgs across sources in the same repo (`registry.mdx:112` vs `agents.mdx:12` @ `bba7ddf`) | Resolve and pin the exact package+registry at integration time; record it in `docs/assumptions.md` |
| **ToS / login reuse** | ADR-005 classifies Anthropic Claude subscription OAuth and Google Gemini CLI / Code Assist / Antigravity OAuth as **`prohibited`** (never shipped), OpenAI ChatGPT/Codex OAuth as **ambiguous → not shipped**, xAI SuperGrok as **unverified → not shipped** (ADR-005 policy table, all sourced to vendor docs fetched 2026-09-22 via `providers-chat-auth-caching.md`) | **Running the vendor's own unmodified CLI is the compliant path** and is the whole design: the CLI authenticates itself, under its own ToS, with credentials we never see, read or transmit. We never implement a vendor's consumer OAuth flow, never store a subscription token, and never present one to a third-party client. Note Anthropic's companion clause "The Claude Code binary must not be modified" (ADR-005 policy table): we spawn `claude` unmodified, and `claude-agent-acp` wraps the **Claude Agent SDK**, not the CLI binary. Documented tokens the vendor publishes for programmatic use (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`) are the only ones we hold |
| **`restricted` logins (auftrag §13 Q3)** | Default is opt-in with a risk warning | Keep the default, and make the warning specific per vendor from ADR-005's `policy_status` / `policy_source` / `policy_checked` fields; never render an "attach with vendor login" affordance for a flow ADR-005 marks `prohibited` — attachment of the vendor's own CLI stays available, because that is a different act |
| **Hidden cost** | External runs are not covered by our provider budget accounting unless the CLI reports usage | Wall-clock and turn caps always; per-agent budget in harness units; show "cost unknown" honestly rather than guessing |
| **Windows** | `node-pty` prebuild on Windows arm64 unverified (`verification-log.md`); Windows subprocess hangs with duplicated pipe handles (`hermes-learnings-and-import.md` A14) | Bounded probe wrapper everywhere; Tier 3 unavailable on any platform without a verified `node-pty`; CI matrix entry per target |
| **Prompt injection via repository content** | The external agent reads the worktree and may act on instructions inside it | Its output is data; it cannot escalate its own approval policy; destructive classes always require confirmation; the lethal-trifecta framing (private data + untrusted content + external communication) is the checklist (`harness-engineering-state-of-the-art.md` §5) |

### Verification spike list

| # | Spike | Output | Est. |
|---|---|---|---|
| 1 | Pin the canonical `claude-agent-acp` package and repo owner | one line in `docs/assumptions.md` | 0.25 d |
| 2 | End-to-end ACP client against goose, codex-acp, claude-agent-acp on a fixture repo | the M6 harness test | 2 d |
| 3 | Gemini CLI `--acp` end-to-end | pass/fail + notes | 0.5 d |
| 4 | Copilot CLI `--acp`, Qwen Code, Kimi CLI ACP | promotion decision per CLI | 1.5 d |
| 5 | Cline, OpenCode, Cursor CLI, Grok Build, Antigravity, pi-acp handshake probes | which are attachable today | 1.5 d |
| 6 | Tier-2 fallback: `claude -p --output-format stream-json`, `codex exec --json` event mapping onto the session transcript | adapter + tests | 1 d |
| 7 | Confirm exact headless flags for Qwen Code, Cursor CLI, Antigravity (notes list these as gaps) | close three gaps in `protocols-channels-coding-clis.md` | 0.5 d |
| 8 | Aider: does a machine-readable non-interactive mode exist? | Tier 2 or Tier 3 decision | 0.5 d |
| 9 | Worktree containment red-team: symlink, `..`, absolute path, `$HOME` write, `git config core.hooksPath` | containment test suite | 1 d |
| 10 | `node-pty` prebuild on Windows arm64 and macOS arm64 | Tier-3 availability matrix | 0.5 d |
| 11 | Credential-probe audit: prove no code path reads credential-file contents | a test + a lint rule | 0.5 d |

## Options considered

### Option A: ACP only
| Dimension | Assessment |
|---|---|
| Complexity | Low — one client, already needed for ADR-008 |
| Fit with brief D1–D11 | **Partially fails D5** — "attach any installed coding CLI" excludes Aider and anything unlisted |
| Cross-platform risk | Low |
| Maintenance burden | Lowest |
| Latency / token cost | Best — no PTY scraping, structured streaming |

**Pros:** one code path; the permission/fs/terminal callbacks give real containment; the registry list is now long enough that "ACP only" covers almost everything. **Cons:** no graceful degradation when an adapter release breaks (and adapters are third-party and young); no story at all for a CLI a user already relies on that never adopts ACP.

### Option B: Three-tier stack — ACP, headless JSON, PTY (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | Medium–High |
| Fit with brief D1–D11 | Direct fit with D5 ("ACP basis; PTY/JSON adapter for CLIs without ACP") |
| Cross-platform risk | Medium — Tier 3 depends on `node-pty` prebuilds (Windows arm64 unverified) |
| Maintenance burden | Medium — one adapter interface, three implementations, per-CLI quirks quarantined in small descriptors |
| Latency / token cost | Tier 1 best; Tier 3 worst and explicitly labelled unsupported |

**Pros:** exactly what D5 asks for; Tier 2 is a real safety net for the two most valuable CLIs; tiers are visible to the user, so expectations match reality. **Cons:** three code paths; Tier 3 will always be flaky and generates support load; containment weakens as the tier number rises, which must be shown in the UI rather than papered over.

### Option C: Treat each CLI as a model provider (Hermes `copilot-acp` shape)
| Dimension | Assessment |
|---|---|
| Complexity | Low–Medium |
| Fit with brief D1–D11 | **Fails D5** — a provider is not an agent: no board membership, no own approval policy or budget, no channel binding |
| Cross-platform risk | Low |
| Maintenance burden | Low |
| Latency / token cost | Enumerating capabilities costs a real session (Hermes's `fetch_models()` must open one because the CLI's login is in an OS credential store it cannot read — `hermes-learnings-and-import.md` A2) |

**Pros:** elegant reuse of the provider pipeline; proven by Hermes. **Cons:** collapses an autonomous agent into an inference backend, losing precisely the first-class-agent semantics D5 demands; and it hides the external agent's tool use inside a "completion", which re-creates pi's black box.

## Trade-off analysis

The decisive trade is **coverage vs. containment**. Tier 1 is both the widest-coverage and the safest tier, because ACP inverts control: the external agent must ask us for files and terminals, so we can contain it. Every step down the tiers buys one more CLI at the cost of losing an enforcement point. That argues for making Tier 1 the default and the tier visible in the UI, rather than silently falling back — a user should know that their Tier-3 agent is contained only by its working directory.

The second trade is **compliance vs. convenience**. The tempting feature — "log in once in the harness and use your Claude/Gemini subscription everywhere" — is precisely what Anthropic and Google prohibit in explicit, current terms. The design that satisfies D5 ("reuse its login") *and* the ToS is the one where we never see the login at all: the vendor's own binary authenticates itself. This is not a workaround, it is the documented compliant path, and it is also the more robust engineering choice, because vendor credential formats change without notice.

The third trade is **breadth at M6 vs. credibility**. Attaching fourteen registry-listed CLIs is a day's configuration and a quarter of support tickets. Four, of which three are independently proven, is a demo that works.

## Consequences

- **Easier:** adding a CLI is a descriptor plus a nightly job, not new architecture; ACP gives us permission, file and terminal enforcement for free; external runs are auditable and replayable like any other session; the subscription-ToS problem disappears by construction; ADR-008's ACP client is shared, so ADR-011 costs the adapters, not the protocol.
- **Harder:** a nightly integration matrix against third-party binaries is a permanent operational cost; Tier 2 and Tier 3 have materially weaker containment and the UI must say so; cost accounting is incomplete for CLIs that do not report usage; Windows Tier 3 may simply be unavailable; each vendor's ToS must be re-checked before promoting a CLI out of "community-tested".
- **Revisit when:** ACP v2 stabilises (ADR-008) and adapters move; a vendor publishes a supported third-party auth path (then ADR-005's policy table changes and so might this design); or the nightly matrix shows one of the four M6 CLIs is chronically unstable, in which case it drops to best-effort.

## Conflicts with the brief

**Finding 1 — the brief's CLI list is broader than the evidence supports for M6.**
D5 names "claude-code, codex, gemini-cli, grok, kimi, opencode, pi, agy, goose, …". Only Claude Code, Codex and Goose are cross-validated end-to-end anywhere (`crates/buzz-acp/README.md:12` @ `77729ab`); the rest are vendor- or registry-listed only (`registry.mdx` @ `bba7ddf`).
**Options:** (a) ship all of them as "supported" and accept the support load; (b) ship four as supported and the rest as attachable-but-unverified (proposed); (c) ship only the three cross-validated ones.
**Recommended resolution:** (b). D5's intent — attach any installed CLI comfortably — is met, because discovery and attachment work for every listed CLI; only the *support promise* is narrowed, and the spike list closes the gap CLI by CLI.

**Finding 2 — "reuse its login" cannot mean the harness handling vendor credentials.**
D5 says "reuse its login". Anthropic's terms forbid third parties collecting, storing or intermediating Claude.ai credentials or session tokens; Google's forbid third-party software accessing the services behind Gemini CLI ([Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Gemini CLI ToS & Privacy](https://geminicli.com/docs/resources/tos-privacy/), both fetched 2026-09-22, via `providers-chat-auth-caching.md`).
**Options:** (a) implement vendor OAuth flows in the harness; (b) read the CLI's credential files and pass tokens along; (c) spawn the vendor CLI so it resolves its own credentials, and never touch them (proposed).
**Recommended resolution:** (c). (a) and (b) are prohibited for at least two of the listed vendors and ambiguous for a third; ADR-005 already decides that no `prohibited` flow ships and names ADR-011 as the compliant route to the same user outcome. (c) satisfies D5's user-visible intent exactly — the user does not log in twice — while the harness never sees a secret. The discovery step is therefore restricted to *existence* checks, not reads.

**Finding 3 — "Q6" is not in the original open-questions list.**
auftrag §13 numbers open questions 1–5 only. The M6 minimum-set question is answered above and should be added to the register as a new numbered question.

## Open questions for the owner

1. **Q6 (needs a decision now):** confirm the M6 set as Claude Code + Codex + Goose (gated) and Gemini CLI (best-effort)? Or add Copilot CLI, given Hermes already drives it?
2. Should **Tier 3 (PTY)** ship in v0.1 at all, or be deferred until a concrete CLI needs it (Aider is currently the only candidate)?
3. Should an external agent be allowed to be **bound to a channel directly** (a Telegram bot that is Claude Code), or only reachable through another agent's `delegate_task`?
4. Should external agents get **their own PLUR1BUS store** (default proposed: no, results captured into the caller's store)?
5. **Budget units:** with usage unreported by most CLIs, is wall-clock + turns an acceptable budget, or should external agents require an API-key path so cost is measurable?
6. For CLIs whose subscription login is **prohibited or ambiguous** for third-party use, should the harness still offer attachment (the vendor's own binary is compliant), with a warning — or hide them entirely?

## Action items

1. [ ] Define the `ExternalAgentDescriptor` (binary names, version command, ACP entry point, tier, credential-path *existence* probes, env allowlist, headless flags, known quirks) and ship descriptors for the four M6 CLIs.
2. [ ] Implement discovery with a bounded probe wrapper (timeout + kill) and a lint rule / test proving no code path reads a credential file's contents (spike 11).
3. [ ] Implement the Tier-1 adapter over ADR-008's ACP client: `session/request_permission` → approval policy; `fs/*` → `resolveInside`-style worktree containment with `realpath`; `terminal/*` → sandboxed backend with env allowlist, timeout and output caps.
4. [ ] Implement the Tier-2 adapter for `claude -p --output-format stream-json` and `codex exec --json`, mapping their event streams onto the same session transcript shape.
5. [ ] Implement the external-agent record type (`engine.kind = "external"`) and wire it into `delegate_task` / `consult_agent`, project boards and the trace UI (ADR-003).
6. [ ] Implement session capture and replay for external runs, including permission decisions with actor and timestamp.
7. [ ] Write the containment red-team suite (spike 9) and make it a required check.
8. [ ] Stand up the nightly per-CLI integration matrix against a fixture repository; add the auto-degrade rule after two consecutive failures.
9. [ ] Work the spike list; promote CLIs out of "community-tested, unverified" only with a green nightly job and a ToS re-check against ADR-005.
10. [ ] Feed the corrected ACP evidence (grok, pi, agy, OpenCode, Cline, Cursor now registry-listed) back into `docs/phase0/research/protocols-channels-coding-clis.md`.
11. [ ] Add the M6 minimum-set question to `docs/assumptions.md` as open question 6.

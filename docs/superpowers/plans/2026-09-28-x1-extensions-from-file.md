# Track X1 — Extensions from a file: `.p1x` verification, install, enable/disable, uninstall for skills and module plugins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** This is the plan for milestone **X1** of track X (`docs/milestones.md` "Track X"; core spec D79–D85). It has 15 tasks and a total of **9.5 agent-days**, inside X1's share of **7–10 ad** (spec §12, milestones §2 row X1–X3). It covers the `.p1x` reader and verifier, install from a file for the kinds `skill`, `module` and `channel`, the D80 lifecycle (installed(disabled) → enabled → uninstalled, trash, restore), the CLI (`skill`, `plugin`, `ext`), the supervisor RPC `ext.*`, audit lines, capability disclosure before enable, rollback on failure, the three `1staid` rows, fuzzing, a system test and the docs. **Not here:** the `mcp-server` and `bundle` kinds, `.mcpb`/`.dxt` and Claude Code plugin import (**X2**); the web UI, the upload endpoint, the confirm route and the D1 `.p1x` association (**X3**); the catalogue, search, per-item updates, pin/skip, revocation fetch and override, the 24 h integrity timer and key rotation (**X4**); `ext lint`, the publishing repository, the real signing keys and the first packages (**X5**).

**Goal:** A person runs `plur1bus skill install zabbix-triage.p1x` or `plur1bus plugin install channel-x.p1x`, sees the verified trust tier, capabilities and scripts, confirms, and gets the item installed and disabled. `skill|plugin enable` shows the capabilities once more and switches it on (hot for modules, next turn for skills). `uninstall` moves it to a 14-day trash, and `restore` brings it back disabled. A tampered, unsafe or incompatible package is refused with an exact reason, and the tree stays byte-identical.

**Architecture:** A new pure Rust crate, `crates/plur1bus-ext`, parses and verifies packages and never writes to disk: strict ZIP audit with our own central-directory parser, a streaming hash of every entry, the manifest schema, compatibility, minisign trust and script derivation. It also packs a directory into a `.p1x` (for `ext pack` and for normalising plain skill folders). Extraction reuses the one verified extractor, `install::archive::extract` (⟂EXT 1). The lifecycle lives in `crates/plur1bus/src/ext/`, split into a **worker half** (inspect, stage: touches package bytes) and a **supervisor-safe half** (commit, enable/disable, uninstall, restore, list: only renames, index and state writes, config changes). The supervisor never parses package bytes. It runs the worker half as a child process, `plur1bus ext __worker`, and commits its result itself. The offline CLI runs both halves in-process under `run/supervisor.lock`, exactly like `module install`.

**Tech Stack:** Node 24.21, TypeScript 5.9, `node:test`, Rust 1.95, clap 4, serde_json, jsonschema 0.26, sha2 0.10, `zip` 8 (writer only, for `pack`), `flate2` 1, `minisign-verify` 0.2.5, `semver` 1, `icu_normalizer` 2. Every crate named here is already in `Cargo.lock` (ruling X1-R28). Dev only: `minisign` 0.10 (already a dev-dependency) behind the new `plur1bus-ext` feature `testkit`. **New TypeScript dependencies:** none.

**Spec:** `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` (authority). Binding: §2 (taxonomy), §5 (format, naming rules, other inputs), §6 (lifecycle, one fact one place, hot enable/disable, uninstall/purge/restore), §7.1 (file source), §7.3 (the importer's index contract), §7.4 (bundled skills), §8 (trust, verification order, capabilities, what is not protected), §9.2 (inspect-confirm), §10.1 (CLI), §10.2 (RPC), §12 (X1 row and acceptance 1–8), §14. Core spec rows D79–D85 (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2), D14, D69. Also binding: `docs/module-guide.md` §12 (⟂EXT 1–5, on branch `docs/h3bb-t12-adrs`), the 2a-H3b-b plan § "Extension-ecosystem compatibility (⟂EXT)", `docs/import.md` §9 (skill store, folder hash `plur1bus-skill-sha256/v1`, lock), ADR-012 §10 (supervisor), ADR-013 (restart classes, `x-tier`), ADR-016 (additive surface, `--json` ids).

**Owner decisions still open.** Spec §13 Q1–Q17 are unanswered. This plan runs on the spec's stated defaults: Q1 `.p1x` and `application/vnd.plur1bus.extension+zip`; Q4 key custody (no key material exists yet, X1-R6); Q5 installed(disabled) after install; Q6 unsigned and unknown-signer file installs allowed after an explicit acknowledgment, with `extensions.allowUnsigned`; Q9 a revoked item is refused and locked (the `--force-revoked` override is X4); Q14 14 days of trash. Q2, Q3, Q7, Q8, Q10–Q13, Q15–Q17 do not affect X1.

---

## Prerequisites (must hold before Task 1 starts)

| # | Prerequisite | Why | Check |
|---|---|---|---|
| P1 | 2a-H3b-b is complete on `main`: PRs #41 (Task 8) and #42 (Task 11) merged, and branch `docs/h3bb-t12-adrs` (`efc96bc`, module-guide §12 with the ⟂EXT seams) merged. | Task 15 amends module-guide §12. Task 13 appends to `CHECK_IDS` after H3b-b's 18 ids. Tasks 6–9 build on `install::archive` and `modules::install`. | `git merge-base --is-ancestor efc96bc origin/main` exits 0; `grep -c '"models.cache",' crates/plur1bus/src/commands/firstaid.rs` = 1. |
| P2 | Open PRs that touch `crates/plur1bus/src/supervisor/` (#44, #45, #46 on 2026-09-28) are merged or closed. | Task 11 edits `supervisor/{server,modules,state,subscribers,mod}.rs`. | `gh pr list --state open --search "supervisor"` lists none of them. |
| P3 | Nothing else has claimed RPC **1.4.0**. | X1-R8 fixes `x-since: "1.4.0"` for `ext.*`. On 2026-09-28 no spec or branch claims it (the direct-chat spec D92–D93 and the plugin-distribution spec D86–D91 add no RPC method). | `grep -rn '"1.4.0"' packages/rpc-schema/schema` is empty on `origin/main`. |

---

## Repository, branch, and how to run anything

**Work repo:** `/home/claude/PLUR1BUS-Harness`. Cut branch **`feat/x1-extensions`** from `origin/main` after P1–P3, using the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree. **Node:** `export PATH=/home/claude/.node24/bin:$PATH`.

**Green:**

```bash
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
```

One crate: `cargo test -p plur1bus-ext`. One TS package: `scripts/test-package.mjs`'s command inside the package (AGENTS.md). System test: `cargo build --release -p plur1bus && pnpm build && cargo run -q -p plur1bus-ext --features testkit --example make-fixtures -- /tmp/p1x-fx && PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_EXT_FIXTURES=/tmp/p1x-fx node --experimental-strip-types --test tests/system/extensions.test.ts`. Run `pnpm docs:gen` after touching the RPC schema, the config schema or any clap text, and commit the regenerated `docs/*.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`. Every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, `--amend` or push, and never change git config (`-c` only).
- **No key material, no secrets, no real user data.** No minisign key, public or secret, is committed, not even a test key. Tests and the fixture generator create a throwaway keypair in memory per run (`plur1bus_ext::testkit`, feature `testkit`), and the public key reaches the code under test only through the test seam `PLUR1BUS_TEST_EXT_PUBKEYS`. The pinned first-party key list ships **empty** (X1-R6). Agent ids (`bernd`, `anna`), module names (`fixture`, `fixture-b`) and skill names (`demo-skill`, `demo-scripts`) are synthetic.
- **Tests never touch a real service manager, `~/.plur1bus` or a real `runtime/`.** Every test uses its own temp home. A system test starts the supervisor with `daemon start` against a temp home; no test calls `service install`.
- **CI green on Linux, macOS and Windows.** The PR #2 Windows rules still apply (`fs.realpathSync`, `fileURLToPath`, `pnpm` through a shell, stop over RPC and never with `SIGTERM`). POSIX-only tests are `#[cfg(unix)]` or `{ skip: process.platform === "win32" }`. Exec bits are asserted only on unix.
- **Supervisor dependency budget (core spec §4, ADR-012 §10):** the supervisor process never parses package bytes (X1-R2). Task 5 extends `scripts/lint-hygiene.mjs`: `crates/plur1bus/src/supervisor/**` and the supervisor-safe files `crates/plur1bus/src/ext/{mod,paths,state,index,overlays,host,worker,commit,lifecycle,remove,list}.rs` must not match `\b(plur1bus_ext::(zipaudit|verify|pack|normalise)|install::archive|install::fetch|zip::|flate2|minisign_verify)\b`. A supervisor panic still exits 70.
- **B1 stays < 100 ms p95:** every JSON Schema validator in `plur1bus-ext` and `ext/` is built lazily (`OnceLock`). `pnpm bench` must not regress by more than 5 ms p95 against `main`; Task 12's report quotes both numbers.
- **Versions:** RPC schema **1.3.0 → 1.4.0** (Task 10). Every new method and notification carries `x-server: "supervisor"`, `x-stability: "experimental"`, `x-since: "1.4.0"`, and closed params. Existing `x-since: "1.3.0"` values never change; literals that mean "the current RPC version" move to `"1.4.0"`. Config `schemaVersion` stays 1 (additive keys only). Module API stays `"1"` (`module.json` gains the optional `kind`, additive). `1staid.check/1` keeps its id and gains three ids appended at the end. Every new CLI `about` starts with `[experimental] `.
- **New CLI `--json` ids:** `skill.list/1`, `skill.show/1`, `skill.install/1`, `skill.uninstall/1`, `skill.restore/1`, `skill.enable/1`, `skill.disable/1`, the same seven under `plugin.`, `ext.inspect/1`, `ext.pack/1`, `ext.verify/1`. `install --dry-run` prints `ext.inspect/1`. Failures are `error/1`.
- **Error codes:** the closed `ErrorCode` enum only. New `reason` strings (X1-R4): `package-invalid`, `signature-invalid`, `scripts-mismatch`, `incompatible`, `name-taken`, `kind-unsupported`, `policy-unsigned-disallowed`, `revoked`, `inspection-expired`, `acknowledge-unsigned`, `acknowledge-unknown-signer`, `acknowledge-downgrade`, `acknowledge-capabilities`, `busy`, `required-by`, `extension-unknown`, `trash-expired`, `bundled`, `needs-setup`, `tampered`, `agents-not-supported`, `worker-failed`. Reused frozen ⟂EXT reasons: `archive-unsafe-entry`, `archive-unsupported`, `download-too-large`, `digest-mismatch`, `reserved-name`, `socket-path-too-long`.
- **Test seams** (honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`): `PLUR1BUS_TEST_EXT_PUBKEYS=<label>=<base64>[,…]` (trusted keys added to the empty pinned set, Task 3), `PLUR1BUS_TEST_EXT_REVOCATIONS=<file>` (a revocation list in the §7.2 `revocations[]` shape, Task 5), `PLUR1BUS_TEST_EXT_FAIL_AT=<commit step id>` (the commit fails at that step, Task 7), `PLUR1BUS_TEST_EXT_INSPECT_TTL_MS=<ms>` (Task 5), `PLUR1BUS_TEST_HARNESS_VERSION=<semver>` (replaces the harness version in `compat` checks, Task 5).
- **Atomic writes everywhere:** temp file `<name>.tmp-<pid>` → `fsync` → `rename`; directories staged as `<name>.tmp-<pid>` and renamed. A killed command leaves no half-installed item under its final name, and `ext::recover` removes leftovers at the next supervisor start or offline command.
- **Byte-identity on refusal:** any refusal, at inspect or at install, leaves `skills/`, `modules/`, `extensions/` and `config.json` byte-identical (acceptance 2). Inspection files live in `run/inspect/`, never under `extensions/` (X1-R16).
- **Clocks:** durations on `Instant`; wall time only in `at`, `installedAt`, `expiresAt` fields.
- **English** everywhere. Generated docs are never hand-edited.

## Review Focus

Five inputs the spec implies but no acceptance criterion names. Each is pinned by a test in the owning task.

1. **An OpenClaw/Hermes skills import runs while a skill is installed from a file.** Both write `skills/index.json`. Expected: the second writer gets `E_LOCKED reason=skills-locked` (exit 3) and writes nothing; neither loses the other's entry. → Task 7 `a_skill_install_while_an_import_holds_the_lock_is_locked_and_writes_nothing`.
2. **The same name across kinds**, e.g. a skill `fixture` while the module `fixture` is installed. Expected: `E_CONFLICT reason=name-taken` at inspect, naming the installed kind. → Task 6 `a_skill_named_like_an_installed_module_is_name_taken_at_inspect`.
3. **An install interrupted between steps** (Ctrl-C, supervisor killed). Expected: no half-installed item, `modules.<name>.enabled` never left `true` for a module that is not installed, and the next command or supervisor start cleans `extensions/staging/` and `run/inspect/`. → Task 7 `an_install_failing_at_each_step_rolls_back_to_a_byte_identical_tree` (every `PLUR1BUS_TEST_EXT_FAIL_AT` step) and `recover_removes_staging_leftovers`.
4. **A home path with spaces and non-ASCII, and a long home on macOS.** Expected: install works under `/tmp/p1x A/Jürgen`, and a module whose socket path would not fit is refused **at inspect** with `socket-path-too-long`, before any confirmation. → Task 6 `a_module_whose_socket_path_does_not_fit_is_refused_at_inspect`; Task 14 runs the system test under a home with a space and `ü`.
5. **Installing the identical package twice** (double click, a retried script). Expected: the second install is a no-op that answers `replaced: false` with the current state, writes nothing and adds no audit line. → Task 7 `installing_the_identical_package_twice_is_a_no_op`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| X1-R1 | Spec §13 Q1–Q17 are open. | The plan runs on the stated defaults (header). Every place that depends on a default names it: installed(disabled) (Q5) in Task 7, the unsigned acknowledgment and `extensions.allowUnsigned` (Q6) in Tasks 3, 7, 10, revoked = refused and locked (Q9) in Tasks 5, 8, the 14-day trash (Q14) in Tasks 9, 10. |
| X1-R2 | Spec §10.2 puts `ext.*` on the supervisor (`x-server: "supervisor"`). Core spec §4 and the H3b-b lint forbid `zip`, `minisign_verify` and `install::archive` in `supervisor/`: the supervisor has no heavy dependencies and no reason to crash. Parsing untrusted ZIPs in it would add both. | **The supervisor never touches package bytes.** `ext.inspect` and the staging half of `ext.install` run in a child process, `plur1bus ext __worker inspect\|stage` (`std::env::current_exe()`, deadline 60 s for inspect and 300 s for stage, killed on overrun → `E_INTERNAL reason=worker-failed`). The worker prints one JSON line. A crashing parser only fails the call. The supervisor then commits (renames, index, state, config) in-process. The offline CLI calls the same worker functions in-process. The lint rule in Global Constraints enforces the split. |
| X1-R3 | Spec §8.4 puts "the parser and verifier" in `crates/plur1bus-ext` on the `zip` crate. ⟂EXT 1 says every package goes through `install::archive::verify_and_extract` and forbids a second extractor. The current extractor keeps inner symlinks, which `.p1x` forbids. | `plur1bus-ext` **audits and never extracts**. Its own central-directory parser checks every §5.1/§8.4 rule and streams each entry once through `flate2` to hash it, with no write. The worker then extracts with `install::archive::extract(archive, into, 0)` into staging. After that it walks the staged tree: any symlink, special file, extra or missing file, or hash or size mismatch against `files` refuses the install (TOCTOU closed). The package bytes are the copy in `run/inspect/<id>.p1x`, re-hashed against the inspection's sha256 before extraction. |
| X1-R4 | Spec §8.4's reasons `path-unsafe`, `zip-unsupported`, `too-large`, `hash-mismatch` name the same cases as the frozen ⟂EXT 2 vocabulary. ⟂EXT 2 forbids renames. | The frozen names win: unsafe entry, symlink or link entry → `archive-unsafe-entry`; unsupported ZIP feature → `archive-unsupported`; any size cap → `download-too-large`; per-file or whole-file hash mismatch → `digest-mismatch`. New reasons are additive (Global Constraints). Task 15 amends spec §8.4's list with this mapping. |
| X1-R5 | module-guide §12 (⟂EXT 2) lists `special-file`; `modules::install::InstallError::reason()` returns `not-a-regular-file`. | The code wins. `not-a-regular-file` is the reason, and Task 15 corrects module-guide §12. |
| X1-R6 | Spec §8.1 pins `ext-primary` and `ext-backup` in the binary. Neither key exists (Q4, X5). The spec names `minisign-verify` 0.3.0; the lock has 0.2.5, used by `update --check`. `minisign-verify` 0.2.5 exposes no key id accessor. | `plur1bus_ext::trust::PINNED_KEYS: &[(&str, &str)] = &[]`, with the labels `ext-primary` and `ext-backup` reserved in its doc comment. X5 fills it. Until then **no package can be `first-party` in production**, and a signed package shows as `unknown-signer`. Tests add keys through `PLUR1BUS_TEST_EXT_PUBKEYS`. The signature's key id is read from bytes 2..10 of the decoded signature line. A key id that matches no trusted key → tier `unknown-signer` with the id shown (the signature cannot be checked without the key). A trusted key id whose signature fails, a legacy `Ed` signature, or a trusted comment other than `p1x <id> <version> sha256(p1x.json)=<hex>` → `signature-invalid`. `minisign-verify` stays 0.2.5. The `packages/module-api` mirror of the keys waits for X5. |
| X1-R7 | Spec §8.4 step 6 checks sizes at inspect and hashes at extraction, so a hash mismatch or a deflate bomb is found only after confirmation. | The audit streams every entry once (inflate capped at the declared size + 1, SHA-256, first 4 bytes kept for script derivation), so a hash mismatch, a lying size and a bomb are refused **at inspect**, with no write. Extraction re-hashes (X1-R3). |
| X1-R8 | Spec §10.2 lets the X1 plan fix `x-since` and has no subscription method for `ext.changed` (the supervisor's notifications go to connections that called a `*.watch` method). | RPC **1.4.0**. X1 methods: `ext.list`, `ext.show`, `ext.inspect`, `ext.install`, `ext.uninstall`, `ext.restore`, `ext.enable`, `ext.disable`, and **`ext.watch`** (new, modelled on `module.watch`: returns `{ subscriptionId, items }` and subscribes to `ext.changed`). `ext.update`, `ext.pin`, `ext.unpin`, `ext.skip`, `ext.search`, `ext.catalog.refresh` are X4 and are not added. The core's `ext.changed` subscription and skill reload wait for the 2c turn loop (X1-R26). |
| X1-R9 | `ext.inspect` takes `{ path } \| { upload } \| { catalog }`. `ext.install` takes `config` and `secrets`. No upload endpoint (X3), no catalogue (X4) and no secret store (ADR-005 is unimplemented) exist. | X1's `ext.inspect` params: `{ source: { path } }`, closed. X3 and X4 add alternatives additively. X1's `ext.install` params: `{ inspectionId, acknowledge?, enable? }`, closed, with no `config` or `secrets`. An item that declares a `required` secret slot installs, shows the overlay `needs-setup`, and `enable` refuses it with `E_NOT_AVAILABLE reason=needs-setup` until the secret store lands. |
| X1-R10 | Kinds in X1. | `skill`, `module`, `channel`. A `.p1x` of kind `mcp-server` or `bundle`, or a `.mcpb`/`.dxt`/Claude Code plugin input, is refused at inspect with `E_NOT_AVAILABLE reason=kind-unsupported`, detail `"<kind> packages arrive in X2"`. For skills, a plain folder, a `.zip` and an Anthropic `.skill` are normalised into an **unsigned** in-memory `.p1x` (id `local/<name>`, publisher `local`) and then run through the same pipeline (acceptance 3). A module directory stays `module install <dir>` (trust `dev`, D14 unchanged). |
| X1-R11 | Spec §10.2 `ext.enable\|disable { name, agents? }`, with per-agent selection in `agents.<id>.skills.blocked[]` (§6.2). The config schema closes `agents.<id>` to `{createdAt, displayName}`. | `agents.<id>.skills = { blocked: string[], pinned: string[], applyAt: "next-turn"\|"next-session" }` is added (live, advanced, X1-R21). Skill **enable**: without `agents` or with `"all"`, index `enabled: true` and the name is removed from every agent's `blocked`. With `agents: [A…]`, index `enabled: true`, the name is removed from each listed agent's `blocked` and added to every other configured agent's `blocked`. An agent created later starts with the skill (documented). Skill **disable**: without `agents`, index `enabled: false` and the lists are untouched. With `agents`, the name is added to those agents' `blocked`. An unknown agent → `E_AGENT_UNKNOWN`. Module/channel: `agents` → `E_INVALID_PARAMS reason=agents-not-supported`, because `modules.<name>.enabled` is the only switch (§6.2). `pinned` is stored and shown, and not interpreted before D69. |
| X1-R12 | Setup copies bundled skills into `skills/` without writing `skills/index.json`. A folder without an index entry has no defined state. | A skill folder without an index entry lists as **enabled**, source `bundled` when the install manifest's `skills[]` names it with source `bundled`, else `local`, and trust `release` or `dev` respectively. The first ext mutation of such a skill writes its entry with that source. |
| X1-R13 | The owner requires capability disclosure before enable. Spec §8.3 discloses before install, and install ends disabled, so enable is the step after which code can run. | The first `ext.enable` of an item, and any later enable after its capabilities changed, needs `acknowledge: ["capabilities"]`. Without it: `E_APPROVAL_REQUIRED reason=acknowledge-capabilities`, `data.capabilities`, `data.scripts`, and `data.authority` (`"full"` for every module and channel, §8.6). The acknowledged capabilities' SHA-256 is recorded in `state.json` (`capabilitiesAck`). Items with trust `release` or `dev` and no package record need no acknowledgment. `ext.install { enable }` needs the same acknowledgment in the same call. `ext.enable\|disable` also take `dryRun?: boolean`, which returns `{ restart, heldBack }` without writing, so the CLI shows dependents before it applies (§6.3). |
| X1-R14 | `skills/index.json` has two writers: the TS importer and now the Rust ext code. | The ext code takes the importer's own lock, `<home>/imports/.lock` (exclusive create, `{pid, at}`, a dead pid's lock taken over, a live holder → `E_LOCKED reason=skills-locked`, exit 3), for every index write. It preserves unknown top-level and per-entry fields, sorts by `id`, writes 2-space JSON with a trailing newline, mode 0600, atomically. The only new entry field is `package: { id, version, trust } \| null` (§6.2). `source` for file installs is `file`. `sha256` is the folder hash `plur1bus-skill-sha256/v1`, ported to Rust and checked against the TS implementation by a shared vector (Task 4). |
| X1-R15 | Spec §6.1 answers a second mutation with `E_CONFLICT reason=busy`. The supervisor's module-op queue answers a cancelled op with `E_NOT_AVAILABLE reason=busy`. | Both stay. One process-wide `try_lock` mutex serialises ext mutations (`install`, `uninstall`, `restore`, `enable`, `disable`). A second mutation gets `E_CONFLICT reason=busy` and changes nothing. The module queue's meaning is unchanged. |
| X1-R16 | Acceptance 2 requires `extensions/` to stay byte-identical after a refusal. §9.2's inspection must persist its bytes for 10 minutes. | Inspections live in `run/inspect/<inspectionId>.{p1x,json}` (0600, pruned when older than the TTL at every inspect, and at supervisor start). `extensions/staging/` is created on demand and removed when a refusal leaves it empty. |
| X1-R17 | Revocation, integrity and overrides depend on the catalogue (X4). Acceptance 6 and 7 are X1. | X1 reads revocations from `extensions/catalog/revocations.json` if present (written only by X4 after signature checks; X1 never writes it) or from `PLUR1BUS_TEST_EXT_REVOCATIONS`. A match (`id` + semver range) refuses install (`E_DENIED reason=revoked`), refuses enable, stops an installed module (held back `ext-revoked`), and fails `1staid check extensions.revoked`. `--force-revoked` is X4. Integrity: installed files are re-hashed against `state.json` at `ext.show`, `ext.enable`, `1staid check extensions.integrity`, and at supervisor start for enabled packaged modules. The last result is cached in the record (`integrity`) and shown by `ext.list`. The 24 h timer and repair-from-cache are X4. |
| X1-R18 | Bundled items "cannot be deleted; uninstall hides them" (§6.4). The hide must survive `setup` re-copying. | X1 `uninstall` of a bundled skill sets `removedByUser: true` in `state.json` and `enabled: false` in the index, and moves nothing. `--purge` → `E_DENIED reason=bundled`. `setup` and `update` honouring `removedByUser` is M8. X1 has no bundled modules. |
| X1-R19 | Trash layout and pruning are unspecified. | `extensions/trash/<trashId>/` with `trashId = <name>-<version>-<YYYYMMDDTHHMMSSZ>` holds `code/`, `package.p1x` (if cached), `data/` (purge only), `record.json` (the state record plus the index entry) and `config.json` (the removed config section, purge only). Entries older than `extensions.trashDays` are pruned at the start of every ext mutation. No timer runs. Replacing an installed item with another version moves the old code into the trash first, so a failed commit rolls back from there. |
| X1-R20 | `compat.harness` uses npm-style ranges (`">=0.2.0 <1.0.0"`). The `semver` crate wants comma-separated comparators. §5.2 `platforms` uses `win32-*`, `install::targets` uses `win-*`. | The schema allows comparator sets separated by spaces, and no `\|\|`. Rust splits on whitespace and joins with `", "` before `VersionReq::parse`. The harness version is `env!("CARGO_PKG_VERSION")` (test seam `PLUR1BUS_TEST_HARNESS_VERSION`). Platform ids map from `Target::id()`: `win-x64` → `win32-x64`, `win-arm64` → `win32-arm64`, others unchanged. `compat.moduleApi` is checked against `modules::manifest::api_version_supported` with the current version. `compat.rpc` against `plur1bus_rpc::RPC_VERSION` (new constant, Task 10). `compat.container: false` in container mode → `incompatible`. |
| X1-R21 | Config keys the spec names without a schema. | Added to `config.schema.json`, all `x-restart: "live"` (read by ext at call time), `x-tier: "advanced"`: `extensions.allowUnsigned` (boolean, default `true`), `extensions.trashDays` (integer 1–365, default 14), `extensions.limits.packageBytes` (integer, 1 MiB–1 GiB, default 268435456), `extensions.limits.skillBytes` (default 16777216), and `agents.<id>.skills` (X1-R11). `schemaVersion` stays 1. |
| X1-R22 | §5.2: `module.json` gains an optional `kind`. The Rust `Manifest` has `deny_unknown_fields`. | `packages/module-api/schema/manifest.schema.json` gains `"kind": { "enum": ["module", "channel"] }`, and the Rust `Manifest` gains `kind: Option<String>`. Module API stays `"1"`. At staging, a `module.json` whose `name`, `version` or `kind` disagrees with the `.p1x` manifest → `package-invalid`. |
| X1-R23 | §8.2 requires the capability `extensions.manage` (ADR-007). No `authorize()` exists yet. | X1 authorises like `module.install`: the supervisor token is the owner. The ADR-007 check arrives with ADR-007's implementation. |
| X1-R24 | §10.1 lists `ext pack\|verify\|lint` and container forwarding through `ext inspect --stdin`. | X1 ships `ext pack` (it also normalises skill folders) and `ext verify` (offline, no home needed). `ext lint` is X5. Every file argument accepts `-` for stdin, which is spooled to `run/inspect/`. The host-to-container forwarding is D1/X3. |
| X1-R25 | §10.2 adds the four mutations to the WebMCP deny list; milestones put the list in X3. `ext.*` is `x-server: "supervisor"`, which `buildWebMcpTools` already skips. | X1 adds `ext.install`, `ext.uninstall`, `ext.restore`, `ext.enable`, `ext.disable`, `ext.update` to `FORBIDDEN_EXACT` in `packages/webmcp/src/provider.ts` now (one line, defence in depth). X3 keeps the UI work. |
| X1-R26 | §6.3: the core reloads skills on `ext.changed`. No skill consumer exists in the core yet. | X1 emits `ext.changed` to `ext.watch` subscribers. `skill list --json` and `ext.list` report the effective per-agent set (`agents`), which is what present consumers read (§6.3). `applyAt` is stored and shown. The core subscription is 2c. |
| X1-R27 | §5.2 names the schema id `https://plur1bus.app/schema/p1x/1/p1x.schema.json`. Internal schemas use `plur1bus.dev`. | Kept as the spec says: `.p1x` is a public format third parties reference. `extensions/state.json` is internal: `https://plur1bus.dev/schema/ext-state/1/ext-state.schema.json`. |
| X1-R28 | New crate dependencies. | `plur1bus-ext` depends on `serde`, `serde_json`, `sha2` 0.10, `flate2` 1, `zip` 8 (`default-features = false`, `deflate-flate2`; writer for `pack` only), `minisign-verify` 0.2, `jsonschema` 0.26 (`default-features = false`), `semver` 1, `icu_normalizer` 2 (NFC check). All are in `Cargo.lock` today. Optional `minisign` 0.10 behind feature `testkit`. |
| X1-R29 | Reinstall rules. | Same `id`, same package sha256 as installed → no-op (Review Focus 5). Same `id`, other version → replace (`replaced: true`). A lower version needs `acknowledge: ["downgrade"]`, else `E_APPROVAL_REQUIRED reason=acknowledge-downgrade`. The enable state is kept, and a widened capability set needs a new acknowledgment at the next enable (X1-R13). Same `name` with another `id`, or another kind → `E_CONFLICT reason=name-taken`. |
| X1-R30 | Where the `1staid` rows go. | `extensions.integrity`, `extensions.consistency`, `extensions.revoked`, appended after `models.cache`: `CHECK_IDS` grows from 18 to **21**. They live in a new `commands/firstaid_ext.rs`. `1staid repair` plans nothing for them (report only; repair from cache is X4). `skills/plur1bus-ops/playbooks/diagnose.md` names the three ids (the H3b-b freshness test requires it). |
| X1-R31 | §6.4 moves secrets and `ctx.dataDir`/`P1X_DATA` into scope. No secret store exists, and `P1X_DATA` needs a change in the supervisor's child environment. | X1 creates `data/ext/<name>/` at install, keeps it at uninstall and moves it to the trash at purge. Passing it to modules (`ctx.dataDir`, `P1X_DATA`) is X2, together with MCP servers. There are no secrets to purge in X1, and the purge confirmation says so. |
| X1-R32 | Audit lines (§8.5, HB12). | `crate::audit::append` from the ext layer, in the supervisor or the offline CLI, `detail.via` = `"supervisor"`\|`"offline"`. Actions: `ext.install` (detail: `id`, `version`, `kind`, `sha256`, `trust`, `keyId`, `acknowledged[]`, `replaced`), `ext.enable`, `ext.disable` (detail: `agents`), `ext.uninstall`, `ext.purge`, `ext.restore` (detail: `trashId`). A no-op writes no line. |

**Out of scope:** everything listed in the scope note; secrets and `userConfig` at install (X1-R9); `ctx.dataDir` (X1-R31); RBAC (X1-R23); D49 `skill proposals`; bundled-item hiding in `setup` (X1-R18).

---

## File structure

```
crates/plur1bus-ext/ (new crate)
  Cargo.toml, schema/p1x.schema.json                                      T1, T2
  src/{lib,refusal,zipaudit}.rs                                            T1
  src/{manifest,compat}.rs                                                 T2
  src/{trust,verify}.rs, tests/{verify,fuzz}.rs                            T3
  src/{pack,normalise,skill,folder_hash,scripts}.rs, src/testkit.rs, examples/make-fixtures.rs,
    tests/fixtures/skill-hash/ (+ expected.json)                           T4
crates/plur1bus/src/ext/ (new)
  {mod,paths,state,index,overlays,host}.rs; schema/ext-state.schema.json   T5
  {inspect,stage,worker}.rs                                                T6
  {commit,list}.rs                                                         T7
  lifecycle.rs                                                             T8
  remove.rs                                                                T9
crates/plur1bus/src/modules/{install,manifest}.rs                          T6 (kind, remove_to)
crates/plur1bus/src/supervisor/{server,modules,state,subscribers,mod}.rs, supervisor/ext.rs (new)   T11
crates/plur1bus/src/commands/{skill,plugin,ext}.rs (new), cli.rs, main.rs, commands/mod.rs   T12 (main.rs `mod ext;` in T5)
crates/plur1bus/src/commands/firstaid_ext.rs (new), commands/firstaid.rs   T13
crates/plur1bus/tests/{ext_state,ext_stage,ext_commit,ext_lifecycle,ext_remove,ext_supervisor,ext_cli,firstaid}.rs   T5–T13
crates/plur1bus/Cargo.toml (dev-dep plur1bus-ext testkit), Cargo.lock     T1 (crate), T5 (plur1bus dep)
crates/plur1bus-rpc/{build.rs,src/lib.rs,tests/fixtures.rs}                T10
packages/rpc-schema/{schema/rpc.schema.json,fixtures/methods/ext.*.json,fixtures/notifications/ext.changed.json,test/*}   T10
packages/config-schema/{schema/config.schema.json,fixtures/*}; crates/plur1bus-config/tests/config.rs   T10
packages/module-api/schema/manifest.schema.json, packages/module-api/test/manifest.test.ts   T6
packages/webmcp/{src/provider.ts,test/provider.test.ts}                    T10
packages/core/test/import/{skills-registry-ext,folder-hash-vector}.test.ts T5, T4
scripts/lint-hygiene.mjs                                                   T5
tests/system/extensions.test.ts (new), .github/workflows/{ci,nightly}.yml  T14 (nightly fuzz in T3)
skills/plur1bus-ops/playbooks/diagnose.md                                  T13
docs/extensions.md (new), docs/module-guide.md, docs/adr/ADR-012, ADR-016, AGENTS.md, docs/milestones.md,
  docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md (§8.4 reason list only)   T15
docs/rpc.md, docs/config.md (generated) T10; docs/cli.md (generated) T12
```

## Task map, batches, model tiers and effort

| # | Task | Produces (used by) | Tier | ad |
|---|---|---|---|---|
| 1 | `plur1bus-ext`: strict ZIP audit and entry hashing | `audit_zip`, `hash_entry`, `Refusal`, `Limits` (2–4, 6) | opus | 0.75 |
| 2 | `.p1x` manifest schema, parse, naming, compatibility | `P1xManifest`, `parse_manifest`, `check_compat`, `HostFacts` (3–9) | sonnet | 0.5 |
| 3 | Trust (minisign), the ordered inspect pipeline, fuzzing | `TrustStore`, `inspect_reader`, `Inspection` (6, 12, 14) | opus | 1.0 |
| 4 | `pack`, script derivation, skill normalisation, Agent Skills check, folder hash, testkit and fixture generator | `pack_dir`, `is_script`, `normalise_skill`, `skill_folder_hash`, `EXCLUDED`, `testkit` (3, 6, 7, 12, 14) | sonnet | 0.5 |
| 5 | Ext state layer: paths, `state.json`, index writer and lock, overlays, host facts, lint rule | `ExtPaths`, `ExtState`, `SkillIndex`, `ImportLock`, `overlays_of`, `host_facts`, `trust_store` (6–13) | sonnet | 0.75 |
| 6 | Worker half: inspect record, staging, kind checks, `module.json` `kind`, `__worker` | `inspect`, `stage`, `spawn_worker`, `remove_to` (7, 11, 12) | opus | 0.75 |
| 7 | Commit with rollback: skill and module install, list/show | `install_commit`, `ModuleHost`, `list_items`, `show_item`, `recover` (8, 9, 11, 12) | opus | 0.75 |
| 8 | Enable/disable, capability acknowledgment, dry-run plan | `enable`, `disable` (11, 12) | opus | 0.75 |
| 9 | Uninstall, purge, restore, trash | `uninstall`, `restore`, `prune_trash` (11, 12) | sonnet | 0.5 |
| 10 | RPC 1.4.0 `ext.*` + `ext.changed`, config keys, WebMCP deny list | generated types (11), config keys (7–9) | sonnet | 0.5 |
| 11 | Supervisor wiring: `ext.*` handlers, worker spawn, `ext.watch`, held-back overlays, recovery | — (12, 14) | opus | 0.75 |
| 12 | CLI `skill`, `plugin`, `ext`; offline mode; disclosure prompts | — (14) | opus | 0.75 |
| 13 | `1staid check` `extensions.integrity\|consistency\|revoked` | — | sonnet | 0.25 |
| 14 | System test (acceptance 1, 3, 4, 5 end to end) and CI wiring | — | sonnet | 0.5 |
| 15 | Docs: `docs/extensions.md`, module-guide, ADR records, AGENTS.md, milestones, spec §8.4 mapping | — | sonnet | 0.5 |
| | **Total** | | | **9.5** |

**Effort check:** 9.5 ad against X1's 7–10 ad (spec §12; milestones Track X). It stays inside the band because `ext lint`, the integrity timer, the revocation override, secrets and `ctx.dataDir` are ruled out (X1-R9, R17, R24, R31). Review cycles are not counted, as in earlier plans. If Task 3 or Task 7 runs over by more than 0.5 ad, the owner decides whether Task 13 moves to X4.

**Parallel batches** (no two tasks in a batch touch the same file, generated docs included; see the conflict scan):

- **Batch A:** Tasks **1, 5, 10**.
- **Batch B:** Tasks **2, 13** (Task 13 needs Task 5).
- **Batch C:** Task **4** (needs Tasks 1, 2).
- **Batch D:** Task **3** (needs Task 4's `testkit`, `is_script` and `EXCLUDED`).
- **Batch E:** Task **6**.
- **Batch F:** Task **7**.
- **Batch G:** Tasks **8, 9**.
- **Batch H:** Task **11**.
- **Batch I:** Task **12**.
- **Batch J:** Task **14**.
- **Batch K:** Task **15**.

## Conflict scan

| File | Tasks | Kind of change | Seq / resolution |
|---|---|---|---|
| `crates/plur1bus-ext/src/lib.rs` | 1, 2, 4, 3 | each adds its `pub mod` lines | A → B → C → D |
| `crates/plur1bus-ext/Cargo.toml`, `Cargo.lock` | 1, 4 | T1 all runtime deps and the `minisign` dev-dependency; T4 the optional `minisign` and feature `testkit` | A → C |
| `crates/plur1bus/Cargo.toml` | 5 | `plur1bus-ext` dependency and dev-dependency with `testkit` | — |
| `crates/plur1bus/src/main.rs` | 5, 6, 12 | T5 `mod ext;`; T6 the hidden `ext __worker` dispatch; T12 the visible commands | A → E → I |
| `crates/plur1bus/src/ext/mod.rs`, `ext/host.rs` | 5, 7, 11 | T5 declares every submodule (placeholder files for T6–T9); T7 adds `recover`; T11 swaps host.rs's RPC version literal for `plur1bus_rpc::RPC_VERSION` | A → F → H |
| `crates/plur1bus/src/modules/install.rs`, `modules/manifest.rs` | 6 | `remove_to`; `kind` | — |
| `crates/plur1bus/src/supervisor/*` | 11; P2 | handlers, topic, held-back reasons | P2 first |
| `crates/plur1bus/src/commands/firstaid.rs` | 13 | `CHECK_IDS` + three calls | — |
| `crates/plur1bus/src/cli.rs`, `commands/mod.rs` | 6, 12 | T6 `Cmd::Ext` with the hidden `__worker` only; T12 the rest of the surface | E → I |
| `scripts/lint-hygiene.mjs` | 5 | supervisor-safe ext files rule | — |
| `packages/rpc-schema/schema/rpc.schema.json`, `docs/rpc.md` | 10 | methods, 1.4.0 | — |
| `packages/config-schema/schema/config.schema.json`, `docs/config.md` | 10 | keys | — |
| `docs/cli.md` | 12 | generated | — |
| `.github/workflows/nightly.yml` | 3 | fuzz job | — |
| `.github/workflows/ci.yml` | 14 | fixture generation step, `extensions.test.ts` into the system list | — |
| `packages/module-api/schema/manifest.schema.json` | 6 | `kind` | — |
| `docs/module-guide.md` | 15; P1 | §12 amendments | P1 first |

---

### Task 1: `plur1bus-ext` — strict ZIP audit and entry hashing

**Files:**
- Create: `crates/plur1bus-ext/Cargo.toml` (package `plur1bus-ext`, workspace version/edition/licence, runtime deps per X1-R28, `[dev-dependencies] minisign = "0.10"`), `crates/plur1bus-ext/src/{lib,refusal,zipaudit}.rs`
- Test: unit tests in `zipaudit.rs`, `crates/plur1bus-ext/tests/zipaudit.rs` (archives built in the test byte by byte and with `zip::ZipWriter`)

**Interfaces:**
- Produces:
  ```rust
  // refusal.rs
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct Refusal { pub code: &'static str /* ErrorCode name */, pub reason: &'static str, pub detail: String }
  impl Refusal { pub fn invalid(reason: &'static str, detail: impl Into<String>) -> Self /* E_INVALID_PARAMS */ }
  pub mod reason { pub const PACKAGE_INVALID: &str = "package-invalid"; pub const SIGNATURE_INVALID: &str = "signature-invalid";
    pub const SCRIPTS_MISMATCH: &str = "scripts-mismatch"; pub const INCOMPATIBLE: &str = "incompatible";
    pub const UNSAFE_ENTRY: &str = "archive-unsafe-entry"; pub const UNSUPPORTED: &str = "archive-unsupported";
    pub const TOO_LARGE: &str = "download-too-large"; pub const DIGEST: &str = "digest-mismatch";
    pub const RESERVED: &str = "reserved-name"; pub const KIND_UNSUPPORTED: &str = "kind-unsupported"; }
  // zipaudit.rs
  pub struct Limits { pub package_bytes: u64, pub entry_bytes: u64, pub max_entries: usize, pub max_ratio: u64,
                      pub max_segments: usize, pub max_name_bytes: usize, pub manifest_bytes: u64 }
  impl Default for Limits { /* 256 MiB, 128 MiB, 20_000, 100, 16, 240, 1 MiB */ }
  #[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum Method { Stored, Deflate }
  pub struct Entry { pub name: String, pub method: Method, pub compressed: u64, pub uncompressed: u64,
                     pub crc32: u32, pub exec: bool, pub data_offset: u64 }
  pub struct Audited { pub size: u64, pub sha256: String, pub entries: Vec<Entry> }
  pub struct EntryDigest { pub sha256: String, pub size: u64, pub head: Vec<u8> /* first ≤ 4 bytes */ }
  pub fn audit_zip<R: std::io::Read + std::io::Seek>(r: &mut R, limits: &Limits) -> Result<Audited, Refusal>;
  pub fn hash_entry<R: std::io::Read + std::io::Seek>(r: &mut R, e: &Entry) -> Result<EntryDigest, Refusal>;
  pub fn read_entry<R: std::io::Read + std::io::Seek>(r: &mut R, e: &Entry, cap: u64) -> Result<Vec<u8>, Refusal>;
  ```
  `audit_zip` hashes the whole stream (SHA-256), then parses from the end: exactly one EOCD record at `len − 22` (a comment length ≠ 0 or any byte after it → `archive-unsupported`), no ZIP64, single disk, the central directory ending right at the EOCD, the first local header at offset 0. For each central entry: method 0 or 8, flag bit 0 (encryption) clear, the local header's name, method, sizes and CRC equal the central ones (bit 3 data descriptors: the descriptor must equal them too), entries contiguous and non-overlapping. Names: valid UTF-8, NFC (`icu_normalizer`), no `\`, NUL or control character, no leading `/`, no drive letter, no empty, `.` or `..` segment, ≤ 16 segments, ≤ 240 bytes, no Windows reserved device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with any extension, case-insensitive), no segment ending in `.` or space, no two names equal after `to_lowercase` + NFC. Unix mode from the external attributes: symlink (`0o120000`), hard link, device, FIFO or socket → `archive-unsafe-entry`; a directory entry (name ends in `/`) → `archive-unsafe-entry` (only implied directories). `exec` = any of `0o111`. Uncompressed > `entry_bytes`, total > `package_bytes`, a ratio above `max_ratio`, or more than `max_entries` → `download-too-large`. `hash_entry` inflates with `flate2::read::DeflateDecoder`, capped at `uncompressed + 1` bytes: more or fewer bytes than declared, or a CRC mismatch → `digest-mismatch`.

- [ ] **Step 1: Write the failing tests** in `tests/zipaudit.rs`, one per rule, each asserting `(code, reason)`: `accepts_a_stored_and_deflated_archive_and_lists_entries`, `refuses_bytes_after_the_eocd` (`archive-unsupported`), `refuses_an_archive_comment`, `refuses_bytes_before_the_first_local_header`, `refuses_a_local_header_that_disagrees_with_the_central_directory`, `refuses_encrypted_and_zip64_and_multi_disk`, `refuses_bzip2_and_other_methods`, `refuses_parent_absolute_drive_backslash_and_control_names` (`archive-unsafe-entry`, one case each), `refuses_too_many_segments_and_long_names`, `refuses_windows_device_names_and_trailing_dot_or_space`, `refuses_case_and_nfc_collisions` (`A.md`/`a.md`, NFC vs NFD `é`), `refuses_symlink_hardlink_device_and_explicit_directory_entries`, `refuses_a_101_to_1_ratio_and_an_oversized_entry_and_too_many_entries` (`download-too-large`), `hash_entry_refuses_a_lying_uncompressed_size` (`digest-mismatch`), `hash_entry_keeps_the_first_four_bytes`, `audit_hashes_the_whole_stream`.
- [ ] **Step 2: Run** `cargo test -p plur1bus-ext` → FAIL (crate empty).
- [ ] **Step 3: Implement** `refusal.rs` and `zipaudit.rs` per the Interfaces. The parser is our own (little-endian field reads over the `Read + Seek` handle). `zip` is not used here.
- [ ] **Step 4: Run** `cargo test -p plur1bus-ext` and `cargo clippy -p plur1bus-ext --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `feat(ext): plur1bus-ext crate with a strict ZIP audit and streaming entry hashes (spec §5.1, §8.4 steps 1–3)`.

---

### Task 2: `.p1x` manifest schema, parse, naming, compatibility

**Files:**
- Create: `crates/plur1bus-ext/schema/p1x.schema.json`, `crates/plur1bus-ext/src/{manifest,compat}.rs`
- Modify: `crates/plur1bus-ext/src/lib.rs`
- Test: unit tests in both files, `crates/plur1bus-ext/tests/manifest.rs`

**Interfaces:**
- Consumes: `Refusal`, `reason::*` (Task 1).
- Produces:
  ```rust
  pub const P1X_SCHEMA_JSON: &str = include_str!("../schema/p1x.schema.json");
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)] #[serde(rename_all = "kebab-case")]
  pub enum Kind { Skill, Module, Channel, McpServer, Bundle }
  #[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct FileEntry { pub sha256: String, pub size: u64, #[serde(default)] pub exec: bool }
  #[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct P1xManifest { pub format: u32, pub id: String, pub name: String, pub version: String, pub kind: Kind,
    pub title: BTreeMap<String, String>, pub summary: BTreeMap<String, String>, pub publisher: Value, pub licence: String,
    pub compat: Value, pub requires: Value, #[serde(default)] pub dependencies: Vec<Value>, pub capabilities: Value,
    #[serde(default)] pub default_enabled: bool, pub scripts: Vec<String>, pub files: BTreeMap<String, FileEntry>,
    #[serde(flatten)] pub rest: serde_json::Map<String, Value> /* homepage, repository, notes, created, remote, members, upstream */ }
  pub fn parse_manifest(raw: &[u8], reserved: &[&str]) -> Result<P1xManifest, Refusal>;
  pub fn valid_name(n: &str) -> bool;        // ^[a-z][a-z0-9]*(-[a-z0-9]+)*$, ≤ 62 chars
  pub fn valid_publisher(p: &str) -> bool;   // ^[a-z][a-z0-9-]{0,31}(\.[a-z0-9-]{1,32})*$
  // compat.rs
  pub struct HostFacts { pub harness_version: String, pub module_api_current: u32, pub rpc_version: String,
                         pub platform: Option<String>, pub container: bool }
  pub fn check_compat(m: &P1xManifest, host: &HostFacts) -> Result<(), Refusal>;   // reason incompatible; detail names the field
  pub fn harness_req(range: &str) -> Result<semver::VersionReq, String>;           // X1-R20
  pub fn capability_hash(capabilities: &Value) -> String;                           // SHA-256 of canonical JSON (sorted keys)
  ```
  The schema is the §5.2 manifest, draft 2020-12, closed at every level, `$id` per X1-R27, `x-stability: "experimental"`. `files` keys match `^payload/`. `sha256` is 64 lower-case hex. The `compat.harness` pattern allows space-separated comparators and no `||`. `parse_manifest` refuses a BOM, non-UTF-8, more than 1 MiB, schema errors, `id` whose name part ≠ `name`, an invalid publisher, and `name` in `reserved` (→ `reserved-name`). Everything else → `package-invalid`, with the schema errors joined in `detail`. `id`'s publisher is `id.split('/')[0]`, and it must equal `publisher.id`.

- [ ] **Step 1: Write the failing tests:** `parses_the_spec_example_manifest` (the §5.2 example with real hashes), `refuses_a_bom_non_utf8_and_over_1_mib`, `refuses_unknown_properties_at_every_level`, `name_rule_is_the_d14_and_agent_skills_intersection` (`a`, `zabbix-triage` accepted; `A`, `-a`, `a--b`, `a-`, 63 chars, `a_b` refused), `publisher_rule` (`plur1bus`, `io.github.jdoe` accepted; `IO.x`, `x.` refused), `id_must_match_name_and_publisher`, `reserved_names_are_refused` (`core`, `con`), `harness_ranges_with_spaces_parse_and_or_ranges_are_refused`, `compat_refuses_harness_module_api_rpc_platform_and_container_each_with_its_field_named`, `win_platform_ids_map_to_win32` (via a `HostFacts` built for `win-x64`), `capability_hash_ignores_key_order`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with a lazily built `jsonschema::Validator` (`OnceLock`), `semver`, and the X1-R20 conversion.
- [ ] **Step 4: Run** `cargo test -p plur1bus-ext` → PASS.
- [ ] **Step 5: Commit** `feat(ext): p1x manifest schema, naming rules and compatibility checks (spec §5.2, §8.4 step 5)`.

---

### Task 3: Trust, the ordered inspect pipeline, fuzzing

**Files:**
- Create: `crates/plur1bus-ext/src/{trust,verify}.rs`, `crates/plur1bus-ext/tests/{verify,fuzz}.rs`
- Modify: `crates/plur1bus-ext/src/lib.rs`, `.github/workflows/nightly.yml` (job `ext-fuzz`: `PLUR1BUS_FUZZ_SECONDS=600 cargo test -p plur1bus-ext --features testkit --test fuzz -- --ignored --nocapture`); `crates/plur1bus-ext/Cargo.toml` (`[[test]] verify` and `fuzz` with `required-features = ["testkit"]`)

**Interfaces:**
- Consumes: Tasks 1, 2; Task 4's `scripts::is_script`, `skill::EXCLUDED` and `testkit` (`test_key`, `build_package`, `tamper`).
- Produces:
  ```rust
  // trust.rs
  pub const PINNED_KEYS: &[(&str, &str)] = &[];   // (label, base64 public key); "ext-primary", "ext-backup" reserved (X1-R6)
  pub struct TrustStore { /* (label, PublicKey, key id [u8; 8]) */ }
  impl TrustStore { pub fn new(keys: &[(String, String)]) -> Result<TrustStore, String>; pub fn is_empty(&self) -> bool }
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)] #[serde(rename_all = "kebab-case")]
  pub enum Tier { Release, FirstParty, UnknownSigner, Unsigned, Imported, Dev }
  #[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct Trust { pub tier: Tier, pub key_id: Option<String> /* 16 upper-case hex */, pub key_label: Option<String> }
  pub fn trusted_comment(id: &str, version: &str, manifest_raw: &[u8]) -> String; // "p1x <id> <version> sha256(p1x.json)=<hex>"
  pub fn verify_signature(manifest_raw: &[u8], minisig: Option<&[u8]>, m: &P1xManifest, store: &TrustStore) -> Result<Trust, Refusal>;
  // verify.rs
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)] #[serde(rename_all = "lowercase")] pub enum Status { Pass, Warn, Fail }
  #[derive(Clone, Debug, Serialize)] pub struct CheckRow { pub id: &'static str, pub status: Status, pub detail: String }
  #[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ScriptInfo { pub path: String, pub size: u64, pub first_line: Option<String> /* ≤ 120 chars, printable only */ }
  #[derive(Clone, Debug)] pub struct Inspection { pub sha256: String, pub size: u64, pub manifest: P1xManifest, pub manifest_raw: Vec<u8>,
    pub trust: Trust, pub checks: Vec<CheckRow>, pub scripts: Vec<ScriptInfo>, pub entries: Vec<Entry> }
  pub struct Policy<'a> { pub limits: Limits, pub skill_bytes: u64, pub store: &'a TrustStore, pub host: &'a HostFacts,
    pub reserved: &'a [&'a str], pub revoked: &'a dyn Fn(&str, &str) -> Option<String> /* id, version → reason */ }
  pub fn inspect_reader<R: Read + Seek>(r: &mut R, p: &Policy) -> Result<Inspection, Refusal>;
  pub fn inspect_file(path: &Path, p: &Policy) -> Result<Inspection, Refusal>;  // size check on metadata before opening
  ```
  `inspect_reader` runs §8.4 steps 1–7 in this order and emits one `CheckRow` per step with the ids `size`, `zip`, `signature`, `manifest`, `compat`, `files`, `scripts`, `revocation`: size → `audit_zip` → exactly `p1x.json`, optionally `p1x.json.minisig`, and `payload/…` at the root (anything else → `package-invalid`) → `read_entry` of both (≤ 1 MiB) → `verify_signature` → `parse_manifest` → `check_compat` → kind (`mcp-server`/`bundle` → `E_NOT_AVAILABLE kind-unsupported`, X1-R10; a skill whose `files` contain a name matching `skill::EXCLUDED` → `package-invalid`, X1-R14) → a skill's total payload over `skill_bytes` → `download-too-large` → the entry set under `payload/` equals `files` keys, and each `hash_entry` equals its `FileEntry` (`digest-mismatch`) → the script set derived with `is_script` equals `scripts` (signed: `scripts-mismatch`; unsigned: a `warn` row) → `revoked(id, version)` → `E_DENIED revoked`. Signature cases: no minisig → `Unsigned`; a key id in the store with a valid signature and trusted comment → `FirstParty`; an unknown key id → `UnknownSigner`; otherwise `signature-invalid`. `Release`, `Imported` and `Dev` are assigned by callers, never here.

- [ ] **Step 1: Write the failing tests** (`tests/verify.rs`), with packages and keys from `testkit`: `a_signed_skill_package_is_first_party_and_passes_every_check`, `an_unsigned_package_is_unsigned_and_a_script_mismatch_is_only_a_warning`, `a_package_signed_by_an_unknown_key_is_unknown_signer_with_its_key_id`, the acceptance 2 variants **with their exact reasons**: `a_changed_payload_byte_is_digest_mismatch`, `an_extra_entry_is_package_invalid`, `a_dot_dot_entry_is_archive_unsafe_entry`, `a_symlink_entry_is_archive_unsafe_entry`, `a_case_collision_pair_is_archive_unsafe_entry`, `a_101_to_1_bomb_is_download_too_large`, `a_manifest_signed_for_another_id_is_signature_invalid`, `bytes_after_the_eocd_are_archive_unsupported`. Also `a_legacy_ed_signature_is_signature_invalid`, `a_signed_package_whose_scripts_list_is_wrong_is_scripts_mismatch`, `mcp_server_and_bundle_kinds_are_kind_unsupported_naming_x2`, `a_revoked_id_and_version_is_denied`, `checks_come_in_the_binding_order`, `a_skill_over_16_mib_is_download_too_large`, `a_p1x_skill_with_an_env_file_is_package_invalid`.
- [ ] **Step 2: Write the fuzz test** `tests/fuzz.rs`: `#[test] #[ignore] fn fuzz_inspect_never_panics_and_never_accepts_a_mutant_as_first_party()`. Seed corpus: 6 valid packages built with `testkit`. Loop until `PLUR1BUS_FUZZ_SECONDS` (default 20) elapses, with a seeded xorshift RNG (`PLUR1BUS_FUZZ_SEED`, printed): bit flips, byte runs, truncation, splicing central-directory fields between packages, duplicated entries. `inspect_reader` runs on a `Cursor` inside `catch_unwind`; a panic fails with the seed. An `Ok` result with tier `FirstParty` must equal the original manifest bytes. A non-ignored `fuzz_smoke` runs 2 s in every `cargo test`.
- [ ] **Step 3: Run** → FAIL. **Implement** `trust.rs`, `scripts.rs`, `verify.rs`. Add the nightly job.
- [ ] **Step 4: Run** `cargo test -p plur1bus-ext --features testkit` and `PLUR1BUS_FUZZ_SECONDS=60 cargo test -p plur1bus-ext --features testkit --test fuzz -- --ignored` → PASS. Quote the executed iteration count in the report.
- [ ] **Step 5: Commit** `feat(ext): minisign trust tiers and the ordered inspect pipeline; fuzz target (spec §8.1–§8.4, acceptance 2 and 8)`.

---

### Task 4: `pack`, script derivation, skill normalisation, Agent Skills check, folder hash, testkit

**Files:**
- Create: `crates/plur1bus-ext/src/{pack,scripts,normalise,skill,folder_hash,testkit}.rs`, `crates/plur1bus-ext/examples/make-fixtures.rs`, `crates/plur1bus-ext/tests/{pack,skill}.rs`, `crates/plur1bus-ext/tests/fixtures/skill-hash/{SKILL.md,scripts/run.sh,references/a.md}`, `crates/plur1bus-ext/tests/fixtures/skill-hash/expected.json`, `packages/core/test/import/folder-hash-vector.test.ts`
- Modify: `crates/plur1bus-ext/src/lib.rs`, `crates/plur1bus-ext/Cargo.toml` (`[features] testkit = ["dep:minisign"]`, `minisign = { version = "0.10", optional = true }`; `[[example]] make-fixtures required-features = ["testkit"]`)

**Interfaces:**
- Consumes: Tasks 1, 2 (`audit_zip`, `hash_entry`, `parse_manifest`, `FileEntry`).
- Produces:
  ```rust
  // scripts.rs
  pub fn is_script(path: &str, exec: bool, head: &[u8]) -> bool; // exec bit, "#!", a segment `scripts` or `bin` under payload/, ELF 7F454C46, Mach-O FEEDFACE/FEEDFACF/CEFAEDFE/CFFAEDFE/CAFEBABE, PE "MZ"
  // pack.rs
  pub fn pack_dir(template: &Value, payload: &Path, created: &str, out: &mut (impl Write + Seek)) -> Result<P1xManifest, Refusal>;
  // fills files (sorted), scripts (derived), created; writes p1x.json first, then payload/… sorted, deflate, no comment;
  // refuses a symlink or special file in `payload` (archive-unsafe-entry)
  // skill.rs
  pub struct SkillFront { pub name: String, pub description: String, pub license: Option<String>, pub version: Option<String> }
  pub fn validate_skill_md(raw: &str, dir_name: &str) -> Result<SkillFront, Refusal>; // agentskills.io: name rule + = dir, description 1–1024, compatibility ≤ 500
  pub const EXCLUDED: &[&str] = &[".env", ".env.*", "auth.json", "credentials.json", "*.pem", "*.key", "id_rsa*", ".git/", ".DS_Store"]; // docs/import.md §9.3
  // normalise.rs
  pub enum SkillInput { Dir(PathBuf), Zip(PathBuf) }  // .zip or .skill: SKILL.md at the root, or one top folder holding it
  pub fn normalise_skill(input: &SkillInput, created: &str, out: &mut (impl Write + Seek)) -> Result<P1xManifest, Refusal>;
  // id "local/<name>", publisher {id:"local", name:"Local"}, version = frontmatter version or metadata.version or "0.0.0",
  // licence = frontmatter license or "NOASSERTION", compat {harness:">=0.0.0"}, requires {runtime:{type:"none"}},
  // capabilities {} ; a `.zip` input is audited with audit_zip first; symlinks refused (never followed); EXCLUDED names refused
  // folder_hash.rs
  pub fn skill_folder_hash(files: &[(String, String)]) -> String; // (posix relpath, sha256 hex) → "sha256:" + hex(SHA-256(Σ relpath "\0" hex "\n")) sorted by relpath
  // testkit.rs (cfg feature "testkit")
  pub struct TestKey { pub label: String, pub public_b64: String /* secret kept in memory */ }
  pub fn test_key(label: &str) -> TestKey;
  pub fn sign_manifest(key: &TestKey, manifest_raw: &[u8], comment: &str) -> Vec<u8>;
  pub fn build_package(template: &Value, payload: &Path, key: Option<&TestKey>) -> Vec<u8>;
  pub fn tamper(pkg: &[u8], how: Tamper) -> Vec<u8>;  // enum Tamper { PayloadByte, ExtraEntry, DotDot, Symlink, CaseCollision, Bomb101, ForeignId, AppendAfterEocd }
  ```
  Task 3 also refuses a `.p1x` skill package containing an `EXCLUDED` name (X1-R14: the importer's scan would hash it differently). `make-fixtures <dir>` writes `signed-skill.p1x`, `unsigned-folder-skill/` (with `scripts/run.sh`), `module-fixture.p1x` (payload from `$PLUR1BUS_FIXTURE_MODULE` or `packages/module-fixture/dist`, `kind: "module"`), `fixture-b.p1x` (needs `fixture`), the eight `Tamper` variants of the signed skill, and `pubkeys.env` (`PLUR1BUS_TEST_EXT_PUBKEYS=test=<base64>`).

- [ ] **Step 1: Write the failing tests:** `pack_fills_files_and_scripts_and_the_result_audits_clean` (round trip: `audit_zip` passes, `parse_manifest` passes, every `hash_entry` equals its `files` entry), `script_derivation_finds_exec_shebang_scripts_dir_bin_dir_and_native_magic`, `pack_refuses_symlinks_and_special_files` (`#[cfg(unix)]`), `validate_skill_md_enforces_the_agent_skills_rules` (name ≠ dir, description empty or 1025 chars, bad name), `normalise_a_folder_a_zip_and_a_dot_skill_to_the_same_manifest_files`, `normalise_refuses_excluded_secret_files_and_symlinks`, `testkit_tamper_produces_the_eight_variants`, `folder_hash_matches_the_shared_vector` (reads `expected.json`). TS: `folder-hash-vector.test.ts` → `folderHash` from `packages/core/src/import/skills-scan.ts` over the same fixture directory equals `expected.json`'s `sha256`.
- [ ] **Step 2: Run** → FAIL. Generate `expected.json` once with the TS `folderHash` (the TS implementation is the reference) and commit it.
- [ ] **Step 3: Implement.** Add the example.
- [ ] **Step 4: Run** `cargo test -p plur1bus-ext --features testkit`, `cargo run -q -p plur1bus-ext --features testkit --example make-fixtures -- /tmp/p1x-fx && ls /tmp/p1x-fx`, and the core package's tests → PASS.
- [ ] **Step 5: Commit** `feat(ext): pack, script derivation, skill folder/.zip/.skill normalisation, Agent Skills check, folder hash port, testkit and fixture generator (spec §5.3, §8.4 step 6, X1-R10, X1-R14)`.

---

### Task 5: Ext state layer — paths, `state.json`, index writer and lock, overlays, host facts

**Files:**
- Create: `crates/plur1bus/src/ext/{mod,paths,state,index,overlays,host}.rs`, and one-line placeholder files `crates/plur1bus/src/ext/{inspect,stage,worker,commit,list,lifecycle,remove}.rs` (module doc comment only), `crates/plur1bus/schema/ext-state.schema.json`, `crates/plur1bus/tests/ext_state.rs`, `packages/core/test/import/skills-registry-ext.test.ts`, `packages/core/test/fixtures/skills-index-ext.json`
- Modify: `crates/plur1bus/Cargo.toml` (`plur1bus-ext = { path = "../plur1bus-ext" }`; dev: same with `features = ["testkit"]`), `crates/plur1bus/src/main.rs` (`mod ext;`), `crates/plur1bus/src/paths.rs` (`Layout::extensions()`, `Layout::ext_data(name)`, `Layout::imports()`), `scripts/lint-hygiene.mjs` (rule in Global Constraints) and its script test

**Interfaces:**
- Produces:
  ```rust
  // paths.rs
  pub struct ExtPaths { pub root: PathBuf /* <home>/extensions */, pub state: PathBuf, pub cache: PathBuf, pub staging: PathBuf,
    pub trash: PathBuf, pub revocations: PathBuf /* extensions/catalog/revocations.json */, pub inspect: PathBuf /* run/inspect */ }
  impl ExtPaths { pub fn of(layout: &Layout) -> ExtPaths; pub fn cached(&self, sha256: &str) -> PathBuf }
  // state.rs
  pub const STATE_SCHEMA_JSON: &str; pub const STATE_VERSION: u32 = 1;
  #[derive(Clone, Debug, Serialize, Deserialize, PartialEq)] #[serde(rename_all = "camelCase")]
  pub struct ItemRecord { pub id: String, pub name: String, pub kind: String, pub version: String, pub source: String /* file */,
    pub trust: String, pub key_id: Option<String>, pub package_sha256: String, pub installed_at: String,
    pub previous_version: Option<String>, pub files: BTreeMap<String, plur1bus_ext::manifest::FileEntry> /* payload-relative */,
    pub capabilities: Value, pub capabilities_ack: Option<String>, pub scripts: Vec<String>, pub required_secrets: Vec<String>,
    pub removed_by_user: bool, pub integrity: Option<Integrity> }
  pub struct Integrity { pub checked_at: String, pub ok: bool, pub paths: Vec<String> }
  pub struct ExtState { pub schema_version: u32, pub items: BTreeMap<String, ItemRecord> }
  pub fn read(p: &ExtPaths) -> Result<ExtState, String>;   // missing → empty; schema-validated; newer version → Err
  pub fn write(p: &ExtPaths, s: &ExtState) -> io::Result<()>; // atomic, 0600
  // index.rs
  pub struct SkillIndex(pub Value);  // {version:1, skills:[…]} with unknown fields kept
  impl SkillIndex { pub fn entry(&self, id: &str) -> Option<&Value>; pub fn upsert(&mut self, entry: Value); pub fn remove(&mut self, id: &str) -> Option<Value>;
                    pub fn set_enabled(&mut self, id: &str, on: bool) -> bool }
  pub fn read_index(layout: &Layout) -> Result<SkillIndex, ExtError>;  // same refusals as TS readIndex: index-invalid, index-newer
  pub fn write_index(layout: &Layout, idx: &SkillIndex) -> io::Result<()>; // sorted by id, 2-space JSON + "\n", 0600, atomic
  pub struct ImportLock { /* releases on drop if the pid is still ours */ }
  pub fn lock_skills(layout: &Layout) -> Result<ImportLock, ExtError>; // <home>/imports/.lock, X1-R14
  // overlays.rs
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)] #[serde(rename_all = "kebab-case")]
  pub enum Overlay { NeedsSetup, Incompatible, Revoked, Tampered, Error }
  pub struct Revocation { pub id: String, pub versions: semver::VersionReq, pub action: String, pub reason: Value }
  pub fn load_revocations(p: &ExtPaths) -> Vec<Revocation>;          // + PLUR1BUS_TEST_EXT_REVOCATIONS; unreadable → empty + warn line
  pub fn revoked(revs: &[Revocation], id: &str, version: &str) -> Option<String>; // action "disable" only
  pub fn rehash(layout: &Layout, rec: &ItemRecord) -> Integrity;      // skills/<name>/ or modules/<name>/ against rec.files
  pub fn overlays_of(rec: &ItemRecord, host: &HostFacts, revs: &[Revocation], manifest_compat: Option<&Value>) -> Vec<Overlay>;
  // host.rs
  pub fn host_facts() -> plur1bus_ext::compat::HostFacts;   // version seam, Target mapping, container_mode(), current_api_version(), RPC_VERSION
  pub fn trust_store() -> plur1bus_ext::trust::TrustStore;  // PINNED_KEYS + PLUR1BUS_TEST_EXT_PUBKEYS under test internals
  pub fn reserved_names() -> &'static [&'static str];        // modules::manifest::RESERVED_NAMES
  pub fn inspect_ttl() -> Duration;                           // 10 min; PLUR1BUS_TEST_EXT_INSPECT_TTL_MS
  // mod.rs
  #[derive(Debug, Clone)] pub struct ExtError { pub code: &'static str, pub reason: Option<&'static str>, pub message: String, pub data: Value }
  impl From<plur1bus_ext::refusal::Refusal> for ExtError
  ```
  Task 10 (same batch) creates `plur1bus_rpc::RPC_VERSION`, so `host.rs` starts with `const RPC_VERSION: &str = "1.4.0";` and a comment naming Task 11, which replaces it with the generated constant.

- [ ] **Step 1: Write the failing tests** (`tests/ext_state.rs`): `state_round_trips_validates_and_refuses_a_newer_version`, `index_writer_keeps_unknown_fields_sorts_and_matches_the_ts_format` (writes from `packages/core/test/fixtures/skills-index-ext.json`'s input half and compares bytes with its output half), `index_reader_refuses_invalid_ids_like_the_importer`, `lock_skills_refuses_a_live_holder_and_takes_over_a_dead_one` (a child process holding the lock; a lock file with pid 999999), `revocations_match_by_id_and_semver_range_and_ignore_warn`, `rehash_reports_a_changed_file_and_a_missing_file`, `overlays_needs_setup_for_a_required_secret_incompatible_revoked_tampered`, `trust_store_ignores_the_seam_without_test_internals`, `host_facts_maps_win_to_win32`. TS: `skills-registry-ext.test.ts` → `readIndex` accepts the fixture's output (entries with `package`, `source: "file"`), and `writeIndex` after `readIndex` keeps `package` on every entry. Lint script test: a line `use plur1bus_ext::verify;` in a temp copy of `ext/commit.rs` is flagged; the same line in `ext/stage.rs` is not.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The index writer's JSON formatting follows `writeIndex` in `packages/core/src/import/skills-registry.ts`. The lock follows `acquireLock` there.
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_state`, the core package's tests, `node scripts/lint-hygiene.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(ext): extension state, skills index writer sharing the importer's lock, overlays, host facts and the supervisor-safe lint rule (spec §6.2, X1-R12, X1-R14, X1-R17)`.

---

### Task 6: Worker half — inspection records, staging, kind checks, `module.json` `kind`, `ext __worker`

**Files:**
- Modify: `crates/plur1bus/src/ext/{inspect,stage,worker}.rs`, `crates/plur1bus/src/cli.rs` and `crates/plur1bus/src/main.rs` (only the hidden `Cmd::Ext { cmd: ExtCmd }` with its single variant `__worker`; Task 12 adds the visible variants), `crates/plur1bus/src/modules/manifest.rs` (`kind: Option<String>`), `crates/plur1bus/src/modules/install.rs` (`remove_to`), `packages/module-api/schema/manifest.schema.json` (`kind`), `packages/module-api/test/manifest.test.ts`
- Test: `crates/plur1bus/tests/ext_stage.rs`, unit tests in `modules/install.rs`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces:
  ```rust
  // inspect.rs
  pub enum Source { Path(PathBuf), Stdin }
  #[derive(Clone, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct InspectionRecord { pub inspection_id: String, pub expires_at: String, pub sha256: String, pub source_path: Option<String>,
    pub normalised: bool, pub manifest: Value, pub trust: Value, pub checks: Value, pub capabilities: Value, pub scripts: Value,
    pub requires: Value, pub replaces: Option<Value> /* { version, capabilityDiff: { changed: [key] } } */, pub name_taken_by: Option<String> }
  pub fn inspect(layout: &Layout, src: Source, id: &str) -> Result<InspectionRecord, ExtError>;
  pub fn load(layout: &Layout, id: &str) -> Result<InspectionRecord, ExtError>;   // expired or missing → E_NOT_FOUND inspection-expired
  pub fn prune(layout: &Layout);
  // stage.rs
  pub struct StagedItem { pub name: String, pub kind: plur1bus_ext::manifest::Kind, pub dir: PathBuf /* …/payload */,
                          pub record: crate::ext::state::ItemRecord, pub package: PathBuf /* run/inspect/<id>.p1x */ }
  pub fn stage(layout: &Layout, id: &str) -> Result<StagedItem, ExtError>;
  pub fn worker_main(layout: &Layout, args: WorkerArgs) -> !;   // in stage.rs; prints one JSON line: {ok:true,…} or {ok:false,error:{code,reason,message,data}}
  // worker.rs (supervisor-safe: only std::process)
  pub fn spawn_worker(layout: &Layout, args: &[&str], deadline: Duration) -> Result<Value, ExtError>;
  // modules/install.rs
  pub fn remove_to(layout: &Layout, name: &str, dest: &Path) -> Result<(), InstallError>; // rename modules/<name> → dest (dest must not exist)
  ```
  `inspect`: `Stdin` is spooled to `run/inspect/<id>.p1x` (0600) with the package cap enforced while reading. A path is copied there (a directory, `.zip` or `.skill` goes through `normalise_skill` into that file, `normalised: true`). Then `plur1bus_ext::verify::inspect_file` runs with `host::{host_facts, trust_store, reserved_names}`, `extensions.limits.*` and `extensions.allowUnsigned` from `config.json` (`policy-unsigned-disallowed` → `E_DENIED` when false and the tier is below `first-party`), and `load_revocations`. Afterwards, name checks against the installed tree: `skills/<name>` or `modules/<name>` owned by another id or kind → `E_CONFLICT name-taken` (detail names the installed kind). A module or channel is checked with the D14 socket-path rule for this home (`socket-path-too-long`, Review Focus 4). `replaces` is filled when the same id is installed. `inspect` writes the record to `run/inspect/<id>.json` and returns it. `stage` loads the record, re-hashes the spooled package against `sha256` (`digest-mismatch`), and calls `install::archive::extract(pkg, extensions/staging/<name>-<id>, 0)`. It then walks `…/payload`: a symlink or special file → `archive-unsafe-entry`; the file set, sizes and hashes must equal `files`; modes are set to 0755 for `exec: true`, else 0644. Kind checks: skill → `validate_skill_md` and the frontmatter `name` equals `name`; module/channel → `modules::manifest::parse_manifest` on `payload/module.json`, then name, version and `kind` (default `module`) equal the manifest (`package-invalid`, X1-R22), and the entry file exists. Any refusal removes the staging directory and an empty `extensions/staging/`. The `__worker` subcommand is hidden: `plur1bus ext __worker inspect --home <h> --id <id> (--path <p>|--stdin)` and `… stage --home <h> --id <id>`.

- [ ] **Step 1: Write the failing tests** (`tests/ext_stage.rs`, fixtures from `testkit`): `inspect_writes_only_under_run_inspect` (hash `skills/`, `modules/`, `extensions/`, `config.json` before and after), `inspect_of_each_tampered_variant_refuses_and_leaves_the_tree_byte_identical` (the eight acceptance 2 variants, exact reasons), `a_skill_named_like_an_installed_module_is_name_taken_at_inspect` (Review Focus 2), `a_module_whose_socket_path_does_not_fit_is_refused_at_inspect` (`#[cfg(unix)]`, a home padded to the limit; Review Focus 4), `unsigned_is_denied_when_allow_unsigned_is_false`, `an_expired_inspection_is_inspection_expired` (TTL seam 1 ms), `stage_rehashes_the_spooled_package` (flip one byte of `run/inspect/<id>.p1x` → `digest-mismatch`), `stage_refuses_a_module_json_whose_kind_or_version_disagrees`, `stage_refuses_a_skill_whose_frontmatter_name_differs`, `stage_sets_exec_modes_from_files` (`#[cfg(unix)]`), `a_refused_stage_removes_its_staging_directory`, `worker_prints_one_json_line_and_exits_nonzero_on_refusal`, `worker_is_killed_after_its_deadline` (a test-only `--sleep-ms` arg honoured under test internals). Unit: `remove_to_moves_the_module_and_refuses_an_existing_dest`. TS `manifest.test.ts`: `kind accepts module and channel and refuses others`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Generate inspection ids with `uuid` v4.
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_stage`, the module-api tests → PASS.
- [ ] **Step 5: Commit** `feat(ext): inspection records, verified staging via the one extractor, kind checks and the ext worker process (spec §8.4 steps 8–10, X1-R2, X1-R3, X1-R16)`.

---

### Task 7: Commit with rollback — skill and module install; list and show

**Files:**
- Modify: `crates/plur1bus/src/ext/{commit,list,mod}.rs` (`recover` in `mod.rs`)
- Test: `crates/plur1bus/tests/ext_commit.rs`

**Interfaces:**
- Consumes: Tasks 5, 6; config keys from Task 10 (read as JSON at call time).
- Produces:
  ```rust
  pub trait ModuleHost {
      fn config(&self) -> Value;                                                  // running config.json
      fn set_config(&mut self, changes: Vec<(String, Value)>, dry_run: bool) -> Result<Value /* {restart:{modules}, heldBack} */, ExtError>;
      fn install_module(&mut self, staged: crate::modules::install::Staged) -> Result<bool, ExtError>;
      fn remove_module(&mut self, name: &str, into: &Path) -> Result<(), ExtError>; // stop, then remove_to
      fn notify(&mut self, change: Value);                                        // ext.changed params
      fn via(&self) -> &'static str;                                              // "supervisor" | "offline"
  }
  pub struct InstallOpts { pub acknowledge: Vec<String>, pub enable: Option<Agents> }
  #[derive(Clone, Debug, PartialEq)] pub enum Agents { All, Some(Vec<String>) }
  pub fn install_commit(layout: &Layout, host: &mut dyn ModuleHost, rec: &InspectionRecord, staged: StagedItem, opts: &InstallOpts)
      -> Result<Value /* {name, version, kind, replaced, state} */, ExtError>;
  pub fn list_items(layout: &Layout, cfg: &Value, filter: &ListFilter) -> Value;  // {items: ExtItem[]}
  pub fn show_item(layout: &Layout, cfg: &Value, name: &str) -> Result<Value, ExtError>; // ExtDetail; runs rehash (X1-R17)
  pub fn recover(layout: &Layout) -> Vec<String>;                                 // removes staging leftovers and expired inspections
  pub const COMMIT_STEPS: [&str; 6] = ["config", "code", "state", "cache", "index", "enable"];
  ```
  Before any write: acknowledgments. Tier `unsigned` needs `"unsigned"`, `unknown-signer` needs `"unknown-signer"`, a lower version needs `"downgrade"` (X1-R29), and `enable` needs `"capabilities"` (X1-R13); a missing one → `E_APPROVAL_REQUIRED acknowledge-<x>`, with the inspection in `data`. Identical id and sha → no-op (Review Focus 5). Steps in `COMMIT_STEPS` order, each undone in reverse on a later failure, and `PLUR1BUS_TEST_EXT_FAIL_AT` fails the named step:
  - **config** (module/channel only): if `modules.<name>.enabled` is not already `false`, set it to `false`, remembering the previous value (absent or `true`).
  - **code**: a replaced item's code first moves to the trash (X1-R19). Skill: rename `…/payload` → `skills/<name>` under `lock_skills`. Module: `modules::install::stage(layout, …/payload)`, then `host.install_module`.
  - **state**: upsert the `ItemRecord` (trust, key id, files, capabilities, `required_secrets` from `capabilities.secrets[].required`).
  - **cache**: copy the package to `extensions/cache/<sha256>.p1x`.
  - **index** (skill only, under `lock_skills`): upsert `{id: name, source: "file", sourcePath, sha256: folder hash, enabled: false, importedAt, package: {id, version, trust}}`. Replacing keeps the previous `enabled`.
  - **enable** (only with `opts.enable`): Task 8's `enable` with the same host.
  Also created at install: `data/ext/<name>/`. Last: one audit line and `host.notify`. The ext mutex is `try_lock` → `E_CONFLICT busy` (X1-R15). `list_items` merges `state.json`, `skills/index.json`, unindexed skill folders (X1-R12), `modules::scan` and `config.json`. Each item is `{name, id, kind, version, source, trust, state: "installed"|"enabled", overlays, enabled, agents}`. `agents` is `"all"` or the agents the skill is effective for (index enabled, not in that agent's `blocked`). `ExtDetail` = `{item, manifest, capabilities, scripts, signer: {keyId, label}|null, files: {count, bytes}, dependents, trash: [{trashId, version, at}]}`. The offline `ModuleHost` implementation lives in this file (`OfflineHost`: config through `plur1bus_config` read/validate/write, module through `modules::install::commit`).

- [ ] **Step 1: Write the failing tests** (`tests/ext_commit.rs`, offline host): `a_signed_skill_installs_disabled_with_index_state_and_cache` (acceptance 1, part 1: index entry passes the TS-compatible reader rules, `enabled: false`, `package.trust = "first-party"` via the key seam), `a_module_package_installs_disabled_and_config_says_so`, `unsigned_needs_acknowledge_unsigned_and_unknown_signer_needs_its_own`, `install_and_enable_needs_acknowledge_capabilities`, `a_lower_version_needs_acknowledge_downgrade_and_replaces_into_the_trash`, `installing_the_identical_package_twice_is_a_no_op` (Review Focus 5; no audit line), `an_install_failing_at_each_step_rolls_back_to_a_byte_identical_tree` (loops over `COMMIT_STEPS`; config value restored exactly, including absent), `a_skill_install_while_an_import_holds_the_lock_is_locked_and_writes_nothing` (Review Focus 1), `recover_removes_staging_leftovers`, `a_second_mutation_while_one_runs_is_busy`, `list_shows_unindexed_bundled_and_local_skills_as_enabled`, `list_reports_per_agent_effective_sets`, `show_reports_tampered_after_a_file_edit` (acceptance 6, first half), `install_writes_one_audit_line_with_trust_and_acknowledgments`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_commit` → PASS.
- [ ] **Step 5: Commit** `feat(ext): install commit for skills and modules with per-step rollback, acknowledgments, list and show (spec §6.1, §6.2, §8.3, §9.2, acceptance 1, 2)`.

---

### Task 8: Enable/disable, capability acknowledgment, dry-run plan

**Files:**
- Modify: `crates/plur1bus/src/ext/lifecycle.rs`
- Test: `crates/plur1bus/tests/ext_lifecycle.rs`

**Interfaces:**
- Consumes: Task 7 (`ModuleHost`, `Agents`, the mutex), Task 5.
- Produces:
  ```rust
  pub struct ToggleOpts { pub agents: Option<Agents>, pub acknowledge: Vec<String>, pub dry_run: bool }
  pub fn enable(layout: &Layout, host: &mut dyn ModuleHost, name: &str, o: &ToggleOpts) -> Result<Value, ExtError>;
  pub fn disable(layout: &Layout, host: &mut dyn ModuleHost, name: &str, o: &ToggleOpts) -> Result<Value, ExtError>;
  // result: { name, state, restart: { modules: string[] }, heldBack: string[] }
  pub fn dependents(layout: &Layout, cfg: &Value, name: &str) -> Vec<String>; // enabled modules whose needs reach `name` transitively (modules::graph)
  ```
  Semantics per X1-R11 and X1-R13. Enable refuses overlays first: `revoked` → `E_DENIED revoked`; `needs-setup`, `incompatible`, `tampered` (fresh `rehash`) → `E_NOT_AVAILABLE` with that reason. Unknown name → `E_NOT_FOUND extension-unknown`. Skill writes go to the index (under `lock_skills`) and to `agents.*.skills.blocked` through `host.set_config`. Module writes go to `modules.<name>.enabled` through `host.set_config`, whose result supplies `restart` and `heldBack`. `dry_run` makes no write and returns the same shape. On success: `capabilitiesAck` recorded (enable), one audit line, `host.notify`.

- [ ] **Step 1: Write the failing tests:** `enable_for_one_agent_only_blocks_it_for_the_others_and_disable_reverts` (acceptance 1, second half: agents `bernd`, `anna`; `list` shows `agents: ["bernd"]`), `enable_all_clears_every_blocked_entry`, `disable_without_agents_keeps_the_lists`, `an_unknown_agent_is_e_agent_unknown`, `agents_on_a_module_is_agents_not_supported`, `first_enable_needs_acknowledge_capabilities_with_the_disclosure_in_data` (module: `data.authority == "full"`; skill with scripts: `data.scripts` lists them), `re_enable_after_disable_needs_no_new_acknowledgment_unless_capabilities_changed`, `enable_refuses_revoked_needs_setup_incompatible_and_tampered` (acceptance 6's enable half), `disable_is_always_allowed_even_when_revoked`, `dry_run_writes_nothing_and_returns_the_plan_with_dependents`, `module_disable_holds_back_a_dependent_in_the_plan` (a fake `ModuleHost` returning a plan; the live supervisor case is Task 11), `enable_and_disable_write_one_audit_line_each`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_lifecycle` → PASS.
- [ ] **Step 5: Commit** `feat(ext): hot enable/disable for skills (per-agent) and modules, capability acknowledgment and dry-run plans (spec §6.3, X1-R11, X1-R13)`.

---

### Task 9: Uninstall, purge, restore, trash

**Files:**
- Modify: `crates/plur1bus/src/ext/remove.rs`
- Test: `crates/plur1bus/tests/ext_remove.rs`

**Interfaces:**
- Consumes: Tasks 5, 7, 8 (`disable` for `cascade`).
- Produces:
  ```rust
  pub struct RemoveOpts { pub purge: bool, pub cascade: bool }
  pub fn uninstall(layout: &Layout, host: &mut dyn ModuleHost, name: &str, o: &RemoveOpts) -> Result<Value, ExtError>; // {name, removed:true, trashId, purged}
  pub fn restore(layout: &Layout, host: &mut dyn ModuleHost, trash_id: &str) -> Result<Value, ExtError>;             // {name, version, state:"installed"}
  pub fn prune_trash(layout: &Layout, days: u32) -> Vec<String>;   // called first by every mutation (Task 7's entry points too)
  ```
  Per X1-R18, R19, R31. `required-by`: `dependents` non-empty and no `cascade` → `E_CONFLICT required-by`, `data.dependents`. `cascade` disables them first. Skill: move `skills/<name>` into `trash/<id>/code`, remove its index entry and state record into `record.json`. Module: `host.remove_module(name, trash/<id>/code)`; `modules.<name>` stays. Purge adds `data/ext/<name>` → `trash/<id>/data`; for a module, the `modules.<name>` section goes into `config.json` in the trash and is deleted from the config; for a skill, the name is removed from every `agents.*.skills.{blocked,pinned}`. Restore: a trash entry older than `extensions.trashDays` or missing → `E_NOT_FOUND trash-expired`; a present name → `E_CONFLICT name-taken`; otherwise it replays install's order (config `enabled: false` first, then code, state, index with `enabled: false`, data and config section back) and always ends installed(disabled). Audit: `ext.uninstall` or `ext.purge`, `ext.restore`.

- [ ] **Step 1: Write the failing tests:** `uninstall_keeps_data_and_config_and_moves_code_to_the_trash` (acceptance 5, part 1), `purge_moves_data_and_removes_the_config_section_and_says_no_secrets_exist`, `restore_within_the_window_brings_the_item_back_disabled_with_data_and_config` (acceptance 5, part 2), `restore_after_the_window_is_trash_expired` (`extensions.trashDays: 1` and a backdated entry), `restore_onto_a_taken_name_is_name_taken`, `uninstall_of_a_required_module_is_required_by_and_cascade_disables_dependents_first`, `uninstall_of_a_bundled_skill_hides_it_and_purge_is_denied`, `prune_removes_only_expired_entries`, `uninstall_restore_uninstall_round_trips_byte_identical_code`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_remove` → PASS.
- [ ] **Step 5: Commit** `feat(ext): uninstall into a 14-day trash, purge, restore and required-by refusals (spec §6.4, acceptance 5)`.

---

### Task 10: RPC 1.4.0 `ext.*` and `ext.changed`, config keys, WebMCP deny list

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json`, `packages/rpc-schema/test/{schema,stability}.test.ts`, `crates/plur1bus-rpc/build.rs` (emit `pub const RPC_VERSION: &str` from `x-rpc-version`), `crates/plur1bus-rpc/src/lib.rs` (re-export), `crates/plur1bus-rpc/tests/fixtures.rs` (arms), every literal meaning "the current RPC version" (found by `grep -rn '"1\.3\.0"' crates packages scripts tests`, deciding each hit: `x-since` values stay; handshake, `rpc` status fields and `$id` move), `packages/config-schema/schema/config.schema.json`, `packages/config-schema/fixtures/*` (regenerated), `crates/plur1bus-config/tests/config.rs`, `packages/webmcp/src/provider.ts`, `packages/webmcp/test/provider.test.ts`, `docs/rpc.md`, `docs/config.md` (regenerated)
- Create: `packages/rpc-schema/fixtures/methods/ext.{list,show,inspect,install,uninstall,restore,enable,disable,watch}.json`, `packages/rpc-schema/fixtures/notifications/ext.changed.json`

**Interfaces:**
- Produces (`$defs`): `ExtKind` (`skill|module|channel`, additively extended by X2), `ExtOverlay`, `ExtTrustTier` (`release|first-party|unknown-signer|unsigned|imported|dev`), `ExtAgents` (`"all"` or `AgentId[]`), `ExtItem`, `ExtDetail`, `ExtInspection` (§10.2 result shape: `inspectionId, expiresAt, sha256, manifest, trust{tier, keyId?, label?}, checks[{id, status, detail}], capabilities, scripts[{path, size, firstLine?}], requires, replaces?{version, capabilityDiff{changed}}`). Methods, all `x-server: "supervisor"`, `x-stability: "experimental"`, `x-since: "1.4.0"`, params `additionalProperties: false`:
  - `ext.list { kind?: ExtKind[], state?: ("installed"|"enabled")[], agent?: AgentId }` → `{ items: ExtItem[] }`
  - `ext.show { name }` → `ExtDetail`
  - `ext.inspect { source: { path } }` → `ExtInspection`
  - `ext.install { inspectionId, acknowledge?: ("unsigned"|"unknown-signer"|"downgrade"|"capabilities")[], enable?: { agents: ExtAgents } }` → `{ name, version, kind, replaced, state }`
  - `ext.uninstall { name, purge?, cascade? }` → `{ name, removed, trashId, purged }`
  - `ext.restore { trashId }` → `{ name, version, state }`
  - `ext.enable` / `ext.disable { name, agents?: ExtAgents, acknowledge?: ("capabilities")[], dryRun?: boolean }` → `{ name, state, restart: { modules: string[] }, heldBack: string[] }`
  - `ext.watch {}` → `{ subscriptionId, items: ExtItem[] }`
  - Notification `ext.changed { name, kind, state, version, overlays }` (`x-server: "supervisor"`).
  Each method's `description` lists its `reason` values from Global Constraints. The title and `x-rpc-version` become 1.4.0, and `$id` `https://plur1bus.dev/schema/rpc/1.4.0/rpc.schema.json`. Config keys per X1-R21. WebMCP per X1-R25.

- [ ] **Step 1: Write the failing tests:** schema.test `declares rpc 1.4.0`, `every ext method is supervisor experimental since 1.4.0 with closed params`, `ext.changed is a supervisor notification`, `core.auth never lists ext methods and supervisor.auth lists all nine`; stability.test `RPC_VERSION is 1.4.0 and matches the $id`; plur1bus-rpc fixtures round-trip every `ext.*` fixture and `rpc_version_const_matches_the_schema`; config-schema TS and plur1bus-config: `restart_class_of("extensions.trashDays") == Live`, `tier_of("agents.bernd.skills.blocked") == advanced`, defaults (`allowUnsigned: true`, `trashDays: 14`, `packageBytes: 268435456`, `skillBytes: 16777216`); webmcp `ext mutations are refused even as a hypothetical core method` and `ext.list and ext.inspect are not refused by the deny list`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Run `pnpm gen && pnpm build && pnpm docs:gen`.
- [ ] **Step 4: Run** Green (all packages, `cargo test --workspace`).
- [ ] **Step 5: Commit** `feat(rpc,config): RPC 1.4.0 ext.* methods and ext.changed; extensions.* and agents.<id>.skills config keys; WebMCP deny list for ext mutations (spec §10.2, X1-R8, X1-R21, X1-R25)`.

---

### Task 11: Supervisor wiring — `ext.*` handlers, worker spawn, `ext.watch`, held-back overlays, recovery

**Files:**
- Create: `crates/plur1bus/src/supervisor/ext.rs` (`SupervisorHost: ModuleHost`, the `ext.*` handlers)
- Modify: `crates/plur1bus/src/supervisor/server.rs` (dispatch), `supervisor/subscribers.rs` (`Topic::Ext`), `supervisor/modules.rs` (held-back reasons; `uninstall_module` takes `into: Option<&Path>`; `ModuleVerb::Uninstall` carries it), `supervisor/state.rs` (`STOPPED_EXT_REVOKED = "ext-revoked"`, `STOPPED_EXT_TAMPERED = "ext-tampered"`, `STOPPED_EXT_INCOMPATIBLE = "ext-incompatible"`), `supervisor/mod.rs` (`ext::recover` and module overlays at start; `SupervisorState.ext_overlays: BTreeMap<String, Overlay>`), `crates/plur1bus/src/ext/host.rs` (`plur1bus_rpc::RPC_VERSION` replaces the literal; unit test `host_rpc_version_is_the_schema_version`)
- Test: `crates/plur1bus/tests/ext_supervisor.rs`

**Interfaces:**
- Consumes: Tasks 6–10.
- Produces: the supervisor serves the nine methods. `ext.inspect` → `spawn_worker(["inspect", "--id", id, "--path", p], 60 s)`. `ext.install` → `spawn_worker(["stage", "--id", id], 300 s)`, then `ext::commit::install_commit` with `SupervisorHost`. `SupervisorHost::set_config` calls `supervisor::config::set` (its restart plan becomes `restart`/`heldBack`). `install_module` pushes `ModuleVerb::Install`. `remove_module` pushes `ModuleVerb::Uninstall` with `into`. `notify` broadcasts `ext.changed` on `Topic::Ext`. `modules_view` gives a module with an ext overlay `Health::Stopped { reason: Some("ext-revoked"|"ext-tampered"|"ext-incompatible") }` after the `disabled` check, so its dependents are held back as `needs-unavailable`. Overlays are computed at supervisor start (after `ext::recover`, before `start_modules`) for packaged modules and refreshed after every ext mutation. The worker binary is `std::env::current_exe()`.

- [ ] **Step 1: Write the failing tests** (`tests/ext_supervisor.rs`, `common::start` with the fixture `.p1x` packages from `testkit`): `inspect_and_install_over_rpc_install_a_module_disabled_and_nothing_starts`, `enable_starts_the_module_and_disable_holds_back_its_dependent` (acceptance 4: `fixture` + `fixture-b`; after `ext.disable fixture`, `fixture-b` is `stopped`/`needs-unavailable`; `ext.enable fixture` restarts both), `dry_run_disable_names_the_dependent_before_applying`, `ext_watch_receives_ext_changed_for_install_enable_uninstall`, `a_revoked_installed_module_is_held_back_at_start` (acceptance 7, second half: revocation seam, supervisor restart, `daemon status` shows `ext-revoked`), `a_tampered_module_is_held_back_at_start`, `the_supervisor_process_never_opens_the_package` (on Linux: `/proc/<supervisor pid>/fd` never lists `run/inspect/*.p1x` during `ext.inspect`, sampled; `#[cfg(target_os = "linux")]`), `a_worker_failure_is_worker_failed_and_the_supervisor_keeps_serving` (test-only `--crash` arg), `concurrent_install_and_enable_is_busy`, `uninstall_over_rpc_moves_the_module_into_the_trash_and_restore_brings_it_back_disabled`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Handlers run on the connection thread and hold the ext mutex. Module work goes through the existing op queue.
- [ ] **Step 4: Run** `cargo test -p plur1bus --test ext_supervisor` and the existing `supervisor`, `module_cmd`, `supervisor_children` tests → PASS. `node scripts/lint-hygiene.mjs` → green.
- [ ] **Step 5: Commit** `feat(supervisor): ext.* over RPC with the worker process, ext.watch/ext.changed, held-back overlays and start-time recovery (spec §6.1, §6.3, §10.2, acceptance 4, 7)`.

---

### Task 12: CLI `skill`, `plugin`, `ext`; offline mode; disclosure prompts

**Files:**
- Create: `crates/plur1bus/src/commands/{skill,plugin,ext}.rs` (`skill` and `plugin` share one `ext_verbs` module in `ext.rs`)
- Modify: `crates/plur1bus/src/cli.rs`, `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/commands/mod.rs`, `docs/cli.md` (regenerated)
- Test: `crates/plur1bus/tests/ext_cli.rs`, `crates/plur1bus/tests/cli.rs` (existing `leaf_commands_are_stable_or_marked_experimental`)

**Interfaces:**
- Consumes: Tasks 6–11.
- CLI (every `about` starts `[experimental] `):
  ```
  plur1bus skill  list [--agent <id>] [--source <s>] [--state installed|enabled]
  plur1bus skill  show <name>
  plur1bus skill  install <file.p1x|file.skill|file.zip|dir|-> [--enable[=<agent,…>]] [--allow-unsigned] [--allow-unknown-signer] [--allow-downgrade] [--dry-run] [--yes]
  plur1bus skill  uninstall <name> [--purge] [--cascade] [--yes]
  plur1bus skill  restore <trash-id>
  plur1bus skill  enable|disable <name> [--agent <id>]… [--yes]
  plur1bus plugin list [--kind module|channel] [--state …] | show | install <file.p1x|-> [same flags] | uninstall | restore | enable | disable   (no --agent)
  plur1bus ext    inspect <file|dir|->
  plur1bus ext    pack <dir> [-o <file.p1x>]        # <dir> holds p1x.template.json and payload/; offline, no home
  plur1bus ext    verify <file.p1x>                 # inspection without a home (empty trust store + seam, no revocations, no name checks)
  plur1bus ext    __worker …                        # hidden (Task 6)
  ```
  Routing: `commands::config::route(layout)` → `Route::Supervisor(client)` calls `ext.*`; `Route::Direct` takes `commands::module::offline_lock` and calls the `ext::` functions in-process with `OfflineHost`. `skill install` refuses a `.p1x` whose kind is not `skill` (`E_INVALID_PARAMS package-invalid`, detail "use plugin install"), and `plugin install` refuses kind `skill`. Flow: inspect → print the disclosure (trust tier and why, signer key id, kind, id, version, publisher marked *unverified* below `first-party`, licence, summary, every capability in plain language, every script with size and first line, "contains N programs your agents can run", runtime, secrets, `replaces`) → confirm. On a TTY, one `[y/N]` whose question names the tier (`Install unsigned package?`, `Install package from unknown signer?`, `Install?`). With `--yes` plus the matching `--allow-*`, no prompt. With no TTY and no `--yes`, or a missing `--allow-*`: `E_APPROVAL_REQUIRED acknowledge-<x>` with the inspection in `data`, exit 2 (acceptance 3). `enable` prints the capability disclosure first and asks. `--yes` passes `acknowledge: ["capabilities"]`. For a module it first runs the dry-run plan and prints `will restart: …` / `will be held back: …`. `uninstall --purge` asks a second, separate question naming what goes ("data/ext/<name>, the configuration section; no secrets are stored yet").

- [ ] **Step 1: Write the failing tests** (`tests/ext_cli.rs`, offline and with `common::start`): `skill_install_signed_then_enable_for_one_agent_then_disable` (acceptance 1 through the CLI, `--json` ids checked), `an_unsigned_folder_skill_without_allow_unsigned_exits_2_with_its_scripts_listed` (acceptance 3), `install_dry_run_prints_ext_inspect_1_and_writes_nothing`, `plugin_install_refuses_a_skill_package_and_skill_install_refuses_a_module_package`, `offline_install_takes_the_supervisor_lock_and_a_starting_supervisor_is_refused`, `enable_without_yes_on_a_non_tty_exits_2_with_the_capabilities`, `module_enable_prints_the_restart_plan_before_applying` (human output), `install_from_stdin_works` (`-`), `ext_pack_then_ext_verify_round_trips`, `ext_verify_of_a_tampered_package_prints_the_reason_and_exits_1`, `every_new_leaf_is_experimental_and_every_json_document_has_its_schema_id`. `tests/cli.rs` stays green.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Run `pnpm docs:gen`.
- [ ] **Step 4: Run** Green. `pnpm bench` against `main`: ≤ 5 ms p95 regression, both numbers in the report.
- [ ] **Step 5: Commit** `feat(cli): skill, plugin and ext commands with inspection disclosure, acknowledgments and offline mode (spec §10.1, §8.3, acceptance 1, 3)`.

---

### Task 13: `1staid check` rows `extensions.integrity`, `extensions.consistency`, `extensions.revoked`

**Files:**
- Create: `crates/plur1bus/src/commands/firstaid_ext.rs`
- Modify: `crates/plur1bus/src/commands/firstaid.rs` (`CHECK_IDS: [&str; 21]`, three calls appended), `skills/plur1bus-ops/playbooks/diagnose.md` (names the three ids and what each means)
- Test: `crates/plur1bus/tests/firstaid.rs`, `crates/plur1bus/tests/repair.rs` (one case)

**Interfaces:**
- Consumes: Task 5 (`state::read`, `read_index`, `rehash`, `load_revocations`, `revoked`).
- Produces:
  ```rust
  pub(crate) fn check_ext_integrity(layout: &Layout) -> Check;    // fail listing "<name>: <path>" for every mismatch; no records → ok "no packaged extensions"
  pub(crate) fn check_ext_consistency(layout: &Layout) -> Check;  // fail: a record whose code dir is missing; warn: an index entry with `package` but no record; ok otherwise
  pub(crate) fn check_ext_revoked(layout: &Layout) -> Check;      // fail listing revoked installed items with reason
  ```
  Read-only. It never takes a lock and never writes `integrity` back into `state.json`.

- [ ] **Step 1: Write the failing tests:** `check_ids_are_append_only_and_end_with_the_three_extension_rows`, `integrity_fails_after_an_installed_skill_file_is_edited` (acceptance 6, second half), `consistency_warns_on_an_orphan_index_package_entry_and_fails_on_missing_code`, `revoked_fails_for_an_installed_revoked_item` (seam), `extension_rows_are_ok_on_a_fresh_home`, repair: `repair_plans_nothing_for_extension_checks`. The H3b-b freshness test `skill_freshness` stays green with the new ids named.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p plur1bus --test firstaid --test repair --test skill_freshness` → PASS.
- [ ] **Step 5: Commit** `feat(1staid): extensions.integrity, extensions.consistency and extensions.revoked checks (spec §6.2, §8.5, §8.7, acceptance 6, 7)`.

---

### Task 14: System test and CI wiring

**Files:**
- Create: `tests/system/extensions.test.ts`
- Modify: `tests/system/helpers.ts` (a `fixtures()` helper reading `PLUR1BUS_EXT_FIXTURES` and `pubkeys.env`), `.github/workflows/ci.yml` (before the system job's test run: `cargo run -q -p plur1bus-ext --features testkit --example make-fixtures -- "$RUNNER_TEMP/p1x-fx"`; add `tests/system/extensions.test.ts` to the explicit list; export `PLUR1BUS_EXT_FIXTURES`)

**Interfaces:**
- Consumes: Tasks 4, 12. The test runs the released binary only through the CLI, with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and the key seam from `pubkeys.env`.

- [ ] **Step 1: Write the test** `describe("X1 acceptance — extensions from a file", { skip: process.platform === "win32" && "POSIX system job" })` under a home whose path contains a space and `ü` (Review Focus 4): `a signed skill installs disabled, enables for bernd only, disables again, and the importer reads the index` (imports `readIndex` from `packages/core/src/import/skills-registry.ts` and reads the home's index: the entry has `source: "file"` and `package`); `an unsigned folder skill needs --allow-unsigned and lists its script` (exit 2, `data.scripts[0].path`); `a module package installs disabled, plugin enable starts it and fixture-b, plugin disable holds fixture-b back and prints the plan`; `uninstall keeps data and config, purge removes them, restore brings the item back disabled`; `every tampered variant is refused with its reason and skills/, modules/, extensions/ stay byte-identical` (hashes the trees). `after` stops the daemon over RPC (`daemon stop`) and reaps the home.
- [ ] **Step 2: Run** with the command in "Repository, branch, and how to run anything" → PASS on Linux; push a CI run and quote the Linux and macOS system legs.
- [ ] **Step 3: Commit** `test(system): X1 extensions acceptance end to end; fixture generation in CI (spec §12 acceptance 1–5)`.

---

### Task 15: Docs — `docs/extensions.md`, module guide, ADR records, AGENTS.md, milestones, spec §8.4 mapping

**Files:**
- Create: `docs/extensions.md`
- Modify: `docs/module-guide.md` (§2 the optional `kind`; §9 a pointer to `plugin install`; §12: point 2 `special-file` → `not-a-regular-file` (X1-R5) and the X1 additions to the refusal vocabulary; point 1 "`plur1bus-ext` audits, `install::archive::extract` extracts" (X1-R3); point 4 unchanged: X1 writes `state.json`, not `manifest.json`), `docs/adr/ADR-012-process-model-and-languages.md` (new §10.14 "X1 implementation record": the worker process boundary X1-R2, the lint rule, start-time overlays), `docs/adr/ADR-016-api-stability-and-versioning.md` (RPC 1.4.0, the new `--json` ids, the reason vocabulary), `AGENTS.md` (layout rows `crates/plur1bus-ext`, `crates/plur1bus/src/ext`, the new commands, the five seams, `make-fixtures`, `extensions.test.ts`), `docs/milestones.md` (X1 status line), `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` (§8.4's reason sentence: the X1-R4 mapping, marked "amended by the X1 plan")

- [ ] **Step 1: Write `docs/extensions.md`:** what `.p1x` is, the verification order with each reason, trust tiers and the empty pinned key set until X5 (X1-R6), the lifecycle and where each fact lives (§6.2 table as built), the CLI with one copy-pasteable example per verb using `--home /tmp/p1x-demo`, the RPC methods, what is **not** protected (§8.8, verbatim in substance), and what arrives in X2–X5.
- [ ] **Step 2: Write** the module-guide, ADR, AGENTS.md, milestones and spec edits listed above.
- [ ] **Step 3: Run** `pnpm docs:check`, `node scripts/lint-hygiene.mjs`, and every command in `docs/extensions.md` once against a temp home (note the results in the report).
- [ ] **Step 4: Commit** `docs: X1 extensions — docs/extensions.md, module-guide §2/§12, ADR-012 and ADR-016 records, AGENTS.md, milestones, spec §8.4 reason mapping`.

---

## Self-review (done while writing)

- **Spec coverage (§12 X1 row):** `crates/plur1bus-ext` strict ZIP, verifier, trust store, script derivation → Tasks 1–4; `p1x` and `state.json` schemas → Tasks 2, 5; `ext.*` RPC except catalogue/search/update + `ext.changed` → Tasks 10, 11 (update/pin/skip/search/catalog.refresh deferred by X1-R8, matching the row's "all verbs except catalogue/search/update-from-catalogue"; pin/skip ride with update in X4); CLI with offline mode → Task 12; skill kind incl. folder/`.zip`/`.skill` and the index contract → Tasks 4, 5, 7; module and channel over D14 → Tasks 6, 7, 11; hot enable/disable → Tasks 8, 11; uninstall/purge/restore/trash → Task 9; `ext pack|verify` → Tasks 4, 12 (`lint` → X5, X1-R24); `1staid` rows → Task 13; fuzzing → Task 3; docs → Task 15.
- **Acceptance 1–8:** 1 → Tasks 7, 8, 12, 14; 2 → Tasks 3, 6, 14 (all eight variants with exact reasons); 3 → Tasks 12, 14; 4 → Tasks 11, 14; 5 → Tasks 9, 11, 14; 6 → Tasks 7, 8, 13; 7 → Tasks 3, 11, 13 (test seam list); 8 → Task 3 (nightly 600 s; the "out-of-staging write" half holds by construction: `plur1bus-ext` never writes, X1-R3).
- **Requested scope:** reader and verification (Tasks 1–3), minisign with the first-party key and no key material (X1-R6), install from file for skill and D14-module kinds (Tasks 6, 7), other kinds named with their X-task (X1-R10), D80 states incl. disabled-after-install (Task 7), enable/disable/uninstall (Tasks 8, 9), CLI with `--json` ids (Task 12, Global Constraints), RPC in `rpc.schema.json` with `x-server`, experimental, closed params (Task 10), audit lines (X1-R32; Tasks 7–9), capability disclosure before enable (X1-R13; Tasks 8, 12), rollback (Task 7), Rust + TS + system tests (every task; TS in Tasks 4, 5, 6, 10; system in Task 14), docs regeneration (Tasks 10, 12). Tests never touch a real service manager (Global Constraints).
- **Verified against the code on `origin/main` @ 049b9a3:** `install::archive::{extract, verify_and_extract, sha256_file}` and `ArchiveError::reason()` strings; `modules::install::{stage, commit, uninstall, installed_dir}` and `InstallError::reason()` (`not-a-regular-file`, X1-R5); `modules::manifest::{RESERVED_NAMES, parse_manifest, api_version_supported, current_api_version}` and the `deny_unknown_fields` `Manifest`; `audit::append(layout, action, target, detail)`; `commands::config::{route, Route}`, `commands::module::{offline_lock, confirm}`; `supervisor::subscribers::Topic`, `supervisor::state::{STOPPED_DISABLED, …}`, `supervisor::config::set`; `firstaid::CHECK_IDS` (18 today); `Target::id()` values; `packages/core/src/import/skills-registry.ts` (`readIndex`, `writeIndex`, `acquireLock`, `imports/.lock`) and `skills-scan.ts` (`folderHash`, `plur1bus-skill-sha256/v1`); `scripts/lint-hygiene.mjs`'s supervisor rule; `packages/webmcp/src/provider.ts` `FORBIDDEN_EXACT`; RPC `x-rpc-version` 1.3.0 and the `ErrorCode` enum (all codes used exist); `Cargo.lock` has `zip` 8.6.0, `minisign-verify` 0.2.5, `minisign` 0.10.0, `semver` 1.0.28, `icu_normalizer` 2.3.0.
- **Type consistency:** `Refusal` (T1) → `ExtError` via `From` (T5); `P1xManifest`, `FileEntry`, `Kind` (T2) are used by T3–T9; `is_script`, `EXCLUDED`, `testkit` (T4) by T3; `Inspection` (T3) → `InspectionRecord` (T6) → `install_commit` (T7); `StagedItem.record: ItemRecord` (T5, T6); `ModuleHost`, `Agents` (T7) are used by T8, T9 and implemented by `OfflineHost` (T7) and `SupervisorHost` (T11); `COMMIT_STEPS` names the `PLUR1BUS_TEST_EXT_FAIL_AT` values; `Overlay` serialises to the `ExtOverlay` enum values (T10); `Tier` serialises to `ExtTrustTier`.
- **Review Focus:** each line names a test in its owning task (Tasks 7, 6, 7, 6/14, 7).
- **Proportion:** interfaces, rules and test names only; no function bodies. The one fixed string is the trusted-comment format from spec §5.1.

# Extensions: `.p1x` packages, skills and plugins (X1)

Status: **experimental**. X1 installs skills, modules and channels **from a file**. Everything below is what shipped in X1 (RPC 1.4.0); the design it follows is `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`, and where the shipped behaviour differs the rulings are recorded in ADR-012 §10.14 and ADR-016. Every command's `--help` starts with `[experimental] `.

Hand-written. The command reference (`docs/cli.md`) and the RPC reference (`docs/rpc.md`) are generated and are the authority on flags and shapes.

## 1. What a `.p1x` is

A `.p1x` is a ZIP archive (`application/vnd.plur1bus.extension+zip`) with exactly this at its root:

```
p1x.json            the manifest, at most 1 MiB, UTF-8, no BOM
p1x.json.minisig    a minisign signature over the exact bytes of p1x.json (optional: absent = unsigned)
payload/…           the item's files, and nothing else
```

`p1x.json` lists the SHA-256, size and exec bit of **every** payload file (`files`) and the set of programs the package contains (`scripts`). The signature covers `p1x.json` only; because `p1x.json` hashes every file, it binds the whole package, and a re-zipped package with identical content still verifies. The signature's trusted comment must be `p1x <id> <version> sha256(p1x.json)=<hex>`, so a signature cannot be moved onto another manifest.

Manifest fields that matter to a person: `id` (`<publisher>/<name>`), `name` (the local name: a directory, a module name and a skill name at once, so it is unique across kinds), `version` (semver), `kind`, `title`, `summary`, `publisher`, `licence`, `compat` (`harness` range, `moduleApi`, `rpc`, `platforms`, `container`), `requires.runtime`, `capabilities` (`network`, `filesystem`, `processes`, `harness` are always present; `secrets`, `hostBridge`, `tools`, `mcpApps` optional) and `defaultEnabled` (honoured only for bundled items).

**Kinds in X1:** `skill` (`payload/` is the skill folder, with `payload/SKILL.md`), `module` and `channel` (`payload/` is the module directory, with `payload/module.json`; the install is the D14 module install, module-guide §9). A `.p1x` of kind `mcp-server` or `bundle`, and `.mcpb`, `.dxt` and Claude Code plugin inputs, are refused at inspection with `E_NOT_AVAILABLE reason=kind-unsupported` (`"<kind> packages arrive in X2"`).

**Other inputs.** A skill folder with a `SKILL.md`, a `.zip` holding one and an Anthropic `.skill` are normalised in memory into an **unsigned** `.p1x` (id `local/<name>`, publisher `local`, trust `unsigned`) and then go through the same pipeline. The normalised manifest states what a skill without a manifest could do: with no scripts, `network: none`, no filesystem, no processes and no harness access; with scripts, network `any`, process spawning, read-write access to the agent workspace, and still no harness access. A module directory stays `plur1bus module install <dir>` (trust `dev`).

## 2. Verification, in order

`ext inspect`, `ext verify` and the inspection half of every install run the same ordered pipeline (`crates/plur1bus-ext`, `verify.rs`). Every step reads the file and **writes nothing**; the first failing step refuses the package with its reason. The checks appear as `checks[]` (`pass`, `warn`, `fail`) in the inspection document.

| Step (check id) | What is checked | Refusal |
|---|---|---|
| 1. `size` | the file is at most `extensions.limits.packageBytes` (256 MiB; a skill's payload `skillBytes`, 16 MiB) | `download-too-large` |
| 2–3. `zip` | whole-file SHA-256; a strict ZIP audit: central directory only, stored or deflate entries, no encryption or multi-disk, no data before the first header or bytes after the end record, no archive comment, local header equals central entry, at most 20 000 entries; names valid UTF-8 in NFC with no absolute path, drive letter, backslash, control character, `.`/`..`/empty segment, more than 16 segments or 240 bytes, reserved Windows device name, trailing dot or space, case or normalisation collision, symlink, hard link or explicit directory; no entry above 128 MiB or above a 100:1 ratio; Unicode-path extras refused | `archive-unsafe-entry` (unsafe name, link, special entry), `archive-unsupported` (a ZIP feature `.p1x` forbids), `download-too-large` (any cap), `digest-mismatch` (CRC or whole-file hash) |
| 4. `signature` | both files read; the signature is checked over the manifest bytes with the trusted key its key id names; yields the trust tier | `signature-invalid` (a trusted key whose signature fails, a legacy signature, or a trusted comment that names another id, version or hash) |
| 5. `manifest` | schema (closed) and naming rules; the trusted comment names this id and version | `package-invalid`, `reserved-name` |
| 5. `compat` | `harness` range, `moduleApi` (module and channel), `rpc`, `platforms`, `container` against this host | `incompatible` (`E_NOT_AVAILABLE`) |
| 6. `files` | the kind is supported; a skill's excluded names and size cap; the payload entry set equals `files` exactly, and every entry's SHA-256, size and exec bit match | `kind-unsupported`, `package-invalid`, `digest-mismatch` |
| 6. `scripts` | the derived script set (exec bit, shebang, or under `scripts/` or `bin/`; native binaries by magic number) equals `scripts` | `scripts-mismatch` for a signed package; a warning for an unsigned one |
| 7. `revocation` | the id and version are not revoked (see §5) | `revoked` (`E_DENIED`) |

Two more refusals come from the installation the package would land in, still at inspection and still before any write: `name-taken` (`E_CONFLICT`: the name belongs to another package id or another kind, the error names what holds it), `socket-path-too-long` (a module whose `run/module-<name>.sock` would not fit; not checked on Windows), and `policy-unsigned-disallowed` (`E_DENIED`, `extensions.allowUnsigned` is `false` and the package is not signed by a trusted key).

The audit streams every entry once (inflate capped at the declared size plus one byte, SHA-256), so a hash mismatch, a lying size and a deflate bomb are refused **at inspection**, not after confirmation. Installing re-checks: the package bytes are the copy kept under `run/inspect/`, re-hashed against the inspection, extracted by the shared installer extractor into staging, and the staged tree is walked again (no symlink, special file, extra or missing file, hash or size mismatch). `plur1bus-ext` audits and never extracts.

**Any refusal, at inspection or at install, leaves `skills/`, `modules/`, `extensions/` and `config.json` byte-identical** (a refused inspection leaves at most a file under `run/inspect/`).

### Process boundary

The supervisor never parses package bytes. `ext.inspect` and the staging half of `ext.install` run in a child process, `plur1bus ext __worker inspect|stage` (a hidden command), killed after 60 s and 300 s respectively; the child prints one JSON line. A crashing parser only fails the call with `E_INTERNAL reason=worker-failed`; a crashed or timed-out stage also discards the inspection, so the package must be inspected again. The supervisor then commits (renames, index, state, config) in-process. Offline, the CLI calls the same functions in-process. `scripts/lint-hygiene.mjs` enforces the split (ADR-012 §10.14).

## 3. Trust

| Tier | Meaning | Acknowledgment |
|---|---|---|
| `release` | bundled with a harness release (a bundled skill) | none |
| `first-party` | signature verifies with a pinned first-party extension key | none |
| `unknown-signer` | a signature whose key id no trusted key has (the id is shown; it cannot be checked without the key) | `unknown-signer` |
| `unsigned` | no signature; also a folder, `.zip` or `.skill` | `unsigned` |
| `imported` | written by a skills import (OpenClaw, Hermes), not by X1 | none |
| `dev` | `module install <dir>` | none (the command itself is the decision) |

**The pinned key set is empty until X5.** The first-party keys (`ext-primary`, `ext-backup`) do not exist yet, so `plur1bus_ext::trust::PINNED_KEYS` ships empty and **no package can be `first-party` in a production build**; a signed package shows as `unknown-signer` with its key id. No key material, not even a test key, is committed. Tests create a throwaway key in memory per run and hand its public half to the code under test through the test seam `PLUR1BUS_TEST_EXT_PUBKEYS` (AGENTS.md, "Test seams").

`extensions.allowUnsigned` (default `true`) set to `false` admits only packages signed by a trusted key (`E_DENIED reason=policy-unsigned-disallowed`), which in production, with the empty pinned set, means none.

## 4. Lifecycle and where each fact lives

```
 inspect ──▶ install ──▶ installed (disabled) ⇄ enabled
                              │       ▲
                              ▼       │ restore (disabled)
                          uninstalled (code in trash; data kept; purge also moves data)
```

Every install ends **installed(disabled)**: nothing runs until an explicit enable (or `install --enable`). An overlay condition is shown instead of the plain state and never changes the configuration: `needs-setup` (a required secret slot is unfilled; X1 has no secret store, so `enable` refuses with `E_NOT_AVAILABLE reason=needs-setup`), `incompatible` (`compat` no longer holds), `revoked`, `tampered`, `error`. An item under an overlay is not run; its enable flag is kept, except that a revoked item cannot be enabled at all.

| Fact | Where | Owner |
|---|---|---|
| Package record: id, version, kind, source (`file`), trust tier, signer key id and label, package sha256, `installedAt`, previous version, the `files` map, capabilities and their acknowledgment hash, scripts, `removedByUser`, last integrity result | `extensions/state.json` (schema `ext-state`, atomic, mode 0600) | supervisor, or the offline CLI |
| Package bytes and what the inspection derived from them | `extensions/cache/<sha256>.p1x` and `.json` | same |
| Skill files | `skills/<name>/` | same (core reads) |
| Skill enabled flag and provenance | `skills/index.json` (the importer's contract, plus `package: {id, version, trust} \| null`); the folder hash in it is provenance only | same; writes take the importer's lock `imports/.lock` |
| Per-agent skill selection | `agents.<id>.skills.{blocked, pinned, applyAt}` in `config.json` | same |
| Module and channel code | `modules/<name>/` | same |
| Module and channel enabled | `modules.<name>.enabled`: the only switch | same |
| Extension data | `data/ext/<name>/` (created at install; passing it to modules is X2) | the extension |
| Trash | `extensions/trash/<name>-<version>-<YYYYMMDDTHHMMSSZ>/` | same |
| Inspections | `run/inspect/<inspectionId>.{p1x,json}`, valid 10 minutes | same |

A skill folder with no index entry (the setup-copied bundled skills) lists as enabled: source `bundled` and trust `release` when the install manifest names it, else `local` and `dev`.

**Install commit.** Six steps in order, each registering its own undo: `config`, `code`, `state`, `cache`, `index`, `enable`. A failure at any step undoes the earlier ones in reverse, so the tree is byte-identical again and no audit line is written. Before the first write the commit re-checks what the inspection checked (name, socket address, revocations, `extensions.allowUnsigned`), because an inspection may be ten minutes old. A skill's index entry (disabled, `package` set) is written **before** its folder moves into place, so a kill never leaves a skill folder without an entry (which would list as enabled). `ext::recover` runs at every supervisor start and before every offline command: it removes `extensions/staging/`, expired inspections, dead writers' temp files and unfinished module staging, reconciles an index entry without a folder (or the reverse), puts code back that a killed replace or uninstall left in the trash, and finishes or undoes an interrupted restore. Right before the new code moves into place the commit writes a mark into its staging directory; a commit killed after that is finished when its state record was written (the cache gets the package and its meta from the inspection) and otherwise its new code is removed (a replaced item's code then comes back from the trash), so no code is ever left without its record. `daemon stop` waits (up to 60 s) for an install, uninstall, restore, enable or disable still running, and keeps serving the module steps it needs, so the supervisor's own stop never cuts one in half.

**Reinstall rules.** The identical package (same id, same sha256) is a no-op: `replaced: false`, nothing written, no audit line. The engine treats it as a no-op, but the CLI is stricter (X1-C25): outside a terminal an identical **unsigned** reinstall still needs `--allow-unsigned --yes`, and without them exits 2 with `E_APPROVAL_REQUIRED acknowledge-unsigned`, the same online and offline. The same id at another version replaces; a lower version needs the acknowledgment `downgrade`. A replace keeps the enable state; if the capabilities widen while the item is enabled, the install itself needs `capabilities`. The same name under another id or kind is `name-taken`. One process-wide lock serialises `install`, `uninstall`, `restore`, `enable` and `disable`; a second one gets `E_CONFLICT reason=busy` and changes nothing.

**Enable and capabilities.** The first enable of an item, and any later enable after its capabilities changed, needs the acknowledgment `capabilities`; without it `E_APPROVAL_REQUIRED reason=acknowledge-capabilities` carries the capabilities, scripts and authority in `error.data.ext` (`"full"` for every module and channel). The acknowledged capabilities' SHA-256 is recorded in `state.json`. Items with trust `release` or `dev` and no package record need none. Enable also re-hashes the installed files (a mismatch is `tampered`; a **missing folder is also reported as `tampered`**, with the paths, because RPC 1.4.0 has no other value).

**Per-agent skills.** `enable`/`disable` on a skill take `agents`. Enable without agents (or `all`) sets the index flag and clears the name from every agent's `blocked`. Enable for a list sets the flag, unblocks it for those agents and blocks it for every other configured agent (an agent created later starts with the skill). Disable without agents clears the flag and leaves the lists; with agents it adds the name to their `blocked`. An unknown agent is `E_AGENT_UNKNOWN`. Modules and channels have no per-agent switch: `agents` is `E_INVALID_PARAMS reason=agents-not-supported`. `pinned` is stored and shown, not interpreted before D69. `applyAt` (`next-turn` or `next-session`) is stored and shown; the core reads the skill set on `ext.changed` from the 2c turn loop on, and until then every present consumer reads the effective per-agent set from `skill list --json` and `ext.list`.

**Uninstall, purge, restore, trash.**

- *Uninstall* stops a module first, moves the code into a fresh trash entry (`code/`, `package.p1x` and its cache meta `package.json`, `record.json`) and removes the state record and index entry. Kept: `data/ext/<name>/` and, for a module or channel, its `modules.<name>` config section, so a reinstall resumes.
- *Purge* also moves `data/ext/<name>/` (`data/`) into the entry. For a **module or channel** the `modules.<name>` section moves into the entry's `config.json`. For a **skill** there is no section: purge removes the name from `agents.*.skills.{blocked,pinned}` and writes no `config.json`. X1 has no secret store, so no secret is deleted, and the confirmation says so.
- *The package is in exactly one place.* It moves from `extensions/cache/` into the trash entry and back by rename, and its cache meta (`<sha256>.json`, what `ext.show` reads) travels with it; the cache and the trash never both hold them (a copy only when the two are on different devices), and pruning an entry removes both.
- *Restore* brings an entry back as installed(disabled) within `extensions.trashDays` (default 14; older is `E_NOT_FOUND reason=trash-expired`); a taken name is `name-taken`.
- *Pruning* removes expired entries, and it runs **only in a mutation that has passed its refusal checks and is about to write** (never before a refusal, never on a no-op). No timer runs, so an expired entry lingers until the next writing mutation.
- *Refusals.* An enabled module that others need is `E_CONFLICT reason=required-by` with the dependents in `error.data.ext.dependents`. `--cascade` disables them first; **a cascade is not undone** if the uninstall then fails on I/O: the dependents stay disabled (less code running) and `error.data.ext.disabledDependents` names them.
- *Bundled skills* cannot be deleted. Uninstall **hides** them (`removedByUser: true`, index `enabled: false`, nothing moved) and answers `trashId: null`; `--purge` is `E_DENIED reason=bundled`. `setup` honouring the hide arrives with M8.

**Integrity and revocation.** Installed files are re-hashed against `state.json` at `ext.show`, at enable, in `1staid check extensions.integrity`, and at supervisor start for **enabled packaged modules** (a disabled one at its enable). `ext.show` computes the result without storing it; mutations store it. Revocations are read from `extensions/catalog/revocations.json` (written only by X4, never by X1) or, with test internals, from the file named by `PLUR1BUS_TEST_EXT_REVOCATIONS`. A match refuses install (`E_DENIED revoked`), refuses enable, holds back a running module, and fails `1staid check extensions.revoked`. The three checks `extensions.integrity`, `extensions.consistency` and `extensions.revoked` are appended to `1staid check` (21 ids); `1staid repair` plans nothing for them.

**Held-back modules.** A packaged module that is revoked, tampered or no longer compatible is not started: it is `stopped` with reason `ext-revoked`, `ext-tampered` or `ext-incompatible`, and its dependents are `needs-unavailable`. `module.start` and `module.restart` answer `E_NOT_AVAILABLE` with the same reason. An unreadable `state.json` at start holds back every packaged module as `ext-tampered` (fail closed).

**Audit.** Each mutation appends a line to `logs/audit.log` with `detail.via` `"supervisor"` or `"offline"`: `ext.install` (`id`, `version`, `kind`, `sha256`, `trust`, `keyId`, `acknowledged[]`, `replaced`), `ext.enable`, `ext.disable` (`agents`), `ext.uninstall`, `ext.purge`, `ext.restore` (`trashId`). A no-op writes none.

## 5. CLI

Three command groups, all `[experimental]`; `--json` output carries `"schema": "<command>/1"` (`skill.list/1`, `skill.show/1`, `skill.install/1`, `skill.uninstall/1`, `skill.restore/1`, `skill.enable/1`, `skill.disable/1`, the same seven under `plugin.`, `ext.inspect/1`, `ext.pack/1`, `ext.verify/1`; `install --dry-run` prints `ext.inspect/1`; failures are `error/1`). `skill` handles skills, `plugin` handles modules and channels; a package of the other kind is refused with a hint. Try it against a scratch home; every command below was run once against `/tmp/p1x-demo`:

```bash
# Build a package from a skill folder (the folder name must equal the skill's name); needs no home
mkdir -p demo/demo-skill/scripts
printf -- '---\nname: demo-skill\ndescription: Say hello.\n---\nRun scripts/hello.sh when asked.\n' > demo/demo-skill/SKILL.md
printf '#!/bin/sh\necho hello\n' > demo/demo-skill/scripts/hello.sh && chmod +x demo/demo-skill/scripts/hello.sh
plur1bus ext pack demo/demo-skill -o demo/demo-skill.p1x

plur1bus ext verify demo/demo-skill.p1x               # offline, no home: exit 1 with the reason when refused
plur1bus --home /tmp/p1x-demo ext inspect demo/demo-skill.p1x        # the disclosure; installs nothing
plur1bus --home /tmp/p1x-demo skill install demo/demo-skill.p1x --dry-run   # the same document

# Unsigned: outside a terminal this needs --allow-unsigned AND --yes (exit 2 with the inspection without them)
plur1bus --home /tmp/p1x-demo skill install demo/demo-skill.p1x --allow-unsigned --yes
plur1bus --home /tmp/p1x-demo skill list
plur1bus --home /tmp/p1x-demo skill show demo-skill
plur1bus --home /tmp/p1x-demo skill enable demo-skill --yes            # --agent <id> (repeatable): only those agents
plur1bus --home /tmp/p1x-demo skill disable demo-skill --yes
plur1bus --home /tmp/p1x-demo skill uninstall demo-skill --yes         # prints the restore command with the trash id
plur1bus --home /tmp/p1x-demo skill restore demo-skill-0.0.0-<UTC time>   # the id `uninstall` printed; restores disabled
plur1bus --home /tmp/p1x-demo skill uninstall demo-skill --purge --yes # also data/ext/demo-skill and its configuration
```

Modules and channels use `plugin install|list|show|enable|disable|uninstall|restore` the same way (`plugin install` takes a `.p1x` or `-` for stdin). `ext pack` builds one from a directory holding `p1x.template.json` (a manifest without `files`, `scripts` and `created`, which pack fills) and `payload/`. A minimal module:

```bash
mkdir -p demo/hello-mod/payload
cat > demo/hello-mod/payload/module.json <<'EOF'
{"name":"hello-mod","version":"1.0.0","apiVersion":"1","entry":"main.mjs","scope":"installation","priority":500,"kind":"module"}
EOF
echo 'console.log("hi")' > demo/hello-mod/payload/main.mjs
cat > demo/hello-mod/p1x.template.json <<'EOF'
{"$schema":"https://plur1bus.app/schema/p1x/1/p1x.schema.json","format":1,"id":"local/hello-mod","name":"hello-mod","version":"1.0.0","kind":"module",
 "title":{"en":"Hello module"},"summary":{"en":"A module that does nothing."},"publisher":{"id":"local","name":"Local"},"licence":"MIT",
 "compat":{"harness":">=0.0.0","moduleApi":["1"]},"requires":{"runtime":{"type":"node","range":">=24"}},
 "capabilities":{"network":{"mode":"none"},"filesystem":[],"processes":{"spawn":false},"harness":{"authority":"full"}}}
EOF

plur1bus ext pack demo/hello-mod -o demo/hello-mod.p1x
plur1bus --home /tmp/p1x-demo plugin install demo/hello-mod.p1x --allow-unsigned --yes
plur1bus --home /tmp/p1x-demo plugin enable hello-mod --yes            # prints the restart plan first
plur1bus --home /tmp/p1x-demo plugin disable hello-mod --yes           # prints what will be held back
plur1bus --home /tmp/p1x-demo plugin uninstall hello-mod --purge --cascade --yes
```

Every file argument accepts `-` for a package on stdin (spooled to `run/inspect/`). `ext pack` fills `files`, `scripts` and `created` and writes deterministically (the same input gives the same bytes); a skill folder with no template is normalised. Signing is a separate step (X5); `ext lint` arrives with it. `ext verify` trusts only the pinned keys and checks no revocations and no installed names.

### The disclosure flow

`install` inspects first and prints the disclosure: trust tier and why, the signer key id, id, version, publisher (marked *unverified* below `first-party`), licence, summary, every capability in plain language, every script with its size and first line, the runtime, the secrets, and what it replaces with the capability diff.

- **On a terminal:** one `[y/N]` question names the tier (and, with `--enable`, the capabilities), and acknowledges what the inspection shows. If the engine still asks for an acknowledgment (an enabled item whose capabilities widen), the CLI discloses and asks again.
- **Outside a terminal:** an acknowledgment that is *due* needs its flag **and** `--yes`: `--allow-unsigned`, `--allow-unknown-signer` or `--allow-downgrade` acknowledge only their tier or downgrade, and `--yes` acknowledges the capabilities. Without them the command exits 2 with `E_APPROVAL_REQUIRED acknowledge-<x>` and the inspection in the error data; it never acknowledges on its own. A package that needs no acknowledgment (a signed first-party package, installed disabled) installs without `--yes`, because nothing runs. This does not extend to an identical unsigned reinstall: that still needs `--allow-unsigned --yes` (X1-C25).
- **Enable** follows a five-step flow: a *dry run* (`dryRun: true` runs every refusal and writes nothing) answers `acknowledge-capabilities` with the disclosure; the CLI shows it; a *confirmation* (or `--yes`) follows; a *dry run with the acknowledgment* returns the restart plan (a module's `will restart` and `will be held back` lines); then the change is *applied*.
- **Uninstall** asks once (a purge asks again and names what goes); `--yes` is required outside a terminal.

### Routing and exit codes

With a supervisor that answers, every verb is its `ext.*` method; without one, the CLI takes the supervisor's single-instance lock, runs `ext::recover`, and calls the same functions in-process (offline). A lock held by a starting supervisor is `E_NOT_AVAILABLE reason=supervisor-running`, and a supervisor that holds its socket but does not answer is `supervisor-unresponsive` (both exit 2). A supervisor that predates extensions is the CLI-only refusal `E_NOT_AVAILABLE reason=supervisor-lacks-method` (restart it with `plur1bus daemon restart`); it is not an RPC error.

Exit codes of the ext commands: `E_LOCKED` (an importer holds `skills/index.json`, `reason=skills-locked`) exits 3; `E_NOT_AVAILABLE` and `E_APPROVAL_REQUIRED` exit 2 (so **`supervisor-running` exits 2** here); everything else exits 1. `plur1bus module` differs: its `supervisor-running` and `supervisor-not-running` refusals exit 1 (module-guide §9).

## 6. RPC (1.4.0)

Served by the supervisor (`x-server: "supervisor"`), all `x-stability: "experimental"`, `x-since: "1.4.0"`, params closed. Shapes and error lists are in `docs/rpc.md`.

| Method | Purpose |
|---|---|
| `ext.list`, `ext.show` | installed items (name, id, kind, version, source, trust, state, overlays, enabled, agents) and one item's manifest, capabilities, scripts, trust, files summary, dependents and trash entries; an unreadable `extensions/state.json` is `E_STORAGE reason=state-invalid` (for `ext.watch` and the mutations too), and an unreadable `skills/index.json` lists every skill as not enabled |
| `ext.inspect` `{ source: { path } }` | audit in a worker; keep the result 10 minutes; returns `inspectionId`, `expiresAt`, `sha256`, `manifest`, `trust`, `checks`, `capabilities`, `scripts`, `requires`, `replaces` |
| `ext.install` `{ inspectionId, acknowledge?, enable? }` | stage in a worker, commit; disabled unless `enable` (which needs `capabilities`) |
| `ext.uninstall` `{ name, purge?, cascade? }` | into the trash; `trashId` is `null` for a bundled hide |
| `ext.restore` `{ trashId }` | back from the trash, disabled |
| `ext.enable`, `ext.disable` `{ name, agents?, dryRun? }` | `{ name, state, restart: { modules }, heldBack }`; `dryRun` runs every refusal and writes nothing |
| `ext.watch` | returns every item and subscribes the connection to the `ext.changed` notification |

`ext.update`, `ext.pin`, `ext.unpin`, `ext.skip`, `ext.search` and `ext.catalog.refresh` are X4 and do not exist. `ext.install` takes no `config` or `secrets` (there is no secret store); `ext.inspect` takes no `upload` or `catalog` alternative (X3, X4).

**Errors** use the closed `ErrorCode` enum; `reason` carries the case. New reasons: `package-invalid`, `signature-invalid`, `scripts-mismatch`, `incompatible`, `name-taken`, `kind-unsupported`, `policy-unsigned-disallowed`, `revoked`, `inspection-expired`, `acknowledge-unsigned`, `acknowledge-unknown-signer`, `acknowledge-downgrade`, `acknowledge-capabilities`, `busy`, `required-by`, `extension-unknown`, `trash-expired`, `bundled`, `needs-setup`, `tampered`, `agents-not-supported`, `worker-failed`, plus `skills-locked` (`E_LOCKED`). The reused frozen vocabulary is `archive-unsafe-entry`, `archive-unsupported`, `download-too-large`, `digest-mismatch`, `reserved-name`, `socket-path-too-long`. `E_STORAGE` also carries `state-invalid` (`extensions/state.json` cannot be read), `index-invalid` and `index-newer` (`skills/index.json` cannot be read or is a newer schema).

Script paths (`scripts[].path`) are always the path inside the package, `payload/…`, in `ext.inspect`, `ext.show` and the enable's `acknowledge-capabilities` disclosure alike.

What a refusal shows travels in **`error.data.ext`** (the closed `ErrorObject.data` gained one optional object): `capabilities`, `scripts`, `authority`, `previousCapabilities`, `dependents`, `disabledDependents`, `paths`, `name`, `installedKind`, `installedId`, and for an install's `acknowledge-*` the whole inspection.

## 7. Configuration

All live (`x-restart: "live"`), `x-tier: "advanced"`: `extensions.allowUnsigned` (boolean, default `true`), `extensions.trashDays` (1–365, default 14), `extensions.limits.packageBytes` (1 MiB–1 GiB, default 256 MiB), `extensions.limits.skillBytes` (default 16 MiB), and per agent `agents.<id>.skills = { blocked, pinned, applyAt }`.

## 8. What is NOT protected

- **A signed package is only as good as its review.** `first-party` will mean the owner's key signed it after review, not that it is harmless.
- **Modules and channels run with full harness authority and the OS user's rights.** They can read `run/*.token`, call every RPC method, and read and write whatever that user can. Their declared capabilities are disclosure, not a boundary.
- **Skill scripts run as the OS user.** A script runs only through an agent's shell tool, and the approval policy is the only gate; approval fatigue defeats it. `allowed-tools` in `SKILL.md` is shown and never pre-approves anything.
- **Skill text is instructions by nature.** A skill can steer the model; nothing prevents bad advice.
- **Unsigned and unknown-signer installs rely entirely on the person** reading the disclosure. `network`, `filesystem` and `processes` capabilities are not enforced by an OS sandbox.
- **Local write access to the state root** can change installed files. The integrity check detects it at the next check; it does not prevent it, and an attacker who can also rewrite `extensions/state.json` defeats it. The re-hash covers the files the package recorded: an edited, replaced or deleted file is found, but a file **added** to `skills/<name>/` or `modules/<name>/` is not.
- **Key compromise.** Between a compromise and the next rotation or revocation an attacker can sign packages that verify.
- **Dependencies vendored inside a package** are reviewed at the pinned version only.

## 9. What arrives in X2–X5

- **X2:** `mcp-server` and `bundle` kinds, `.mcpb`/`.dxt` and Claude Code plugin inputs, `ctx.dataDir` and `P1X_DATA` for modules and scripts, per-agent MCP lists.
- **X3:** web UI, the upload endpoint (`ext.inspect` `upload`), D1 `.p1x` file association, the WebMCP deny list work beyond the one-line defence in depth already in place.
- **X4:** the signed catalogue and `ext.inspect` `catalog`, search, per-item updates with health gate and rollback, pin/skip, revocation lists and `--force-revoked`, the 24 h integrity timer and repair from the cache, key rotation.
- **X5:** the pinned first-party keys, `ext lint`, the publishing repository and first packages. After X5 a signed package can be `first-party`.

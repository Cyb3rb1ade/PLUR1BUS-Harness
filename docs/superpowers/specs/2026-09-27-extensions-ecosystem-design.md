# Extensions ecosystem (skills and plugins): design

**Status:** Draft for owner review · **Date:** 2026-09-27 · **Owner:** Christian (Cyb3rb1ade) · **Decision rows:** core spec D79–D85 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestones:** track X, X1–X5 (`docs/milestones.md`) · **Inputs:** core spec D14, D38, D46, D49, D56–D60, D64, D69, D71, D77, D78 · ADR-005, ADR-007, ADR-008, ADR-010, ADR-012 (§10, §11), ADR-013, ADR-016 · `docs/module-guide.md` · `2026-09-27-desktop-app-design.md` (DS12, DS28, DS32, DS34, §4.19, §4.20, §6.9, §6.16.7) · design canvas (`V2Skills`, `V2SkillsLibrary`, `V2Plugins`, `V2PluginsServer`, `V2Modules`, `V2McpApp`; conflict C6 in the desktop-design-canvas branch's desktop spec §13.5) · the parallel skills importer on `feat/import-detect` · external evidence in §4, all read 2026-09-27.

**Owner request, 2026-09-27 (translated from German):** "We need an importer for skills. We want to be able to download more skills and plugins from the plur1bus.app URL once we publish some, so think this ecosystem through now. There must be a button to enable and disable skills, enable and disable plugins, and install and uninstall plugins — first from a file, then over the web."

The owner was not available for questions while this was written. Every open choice below has a default that the design runs on, and every choice that is really the owner's is listed in §13 with a recommendation.

## 1. Goal

A person can add capabilities to PLUR1BUS without a harness release, and can see and control what was added. Concretely:

- One **package format** (`.p1x`) carries both skills and plugins. A signature and per-file hashes are verified before any byte is unpacked.
- Every installed item has a visible **state** and **buttons**: enable/disable for skills and plugins, install/uninstall for plugins (and skills). Disabling is hot where the process model allows it.
- Four **sources** feed the same install path: a local file (first), the signed web **catalogue** at `https://extensions.plur1bus.app/v1/index.json` (later), the OpenClaw/Hermes **importer**, and the skills **bundled** with a release.
- **Extensions update on their own**, per item, with the D78 update model (*Jetzt / Später / Überspringen*, pin, snapshot, health gate, automatic rollback). The harness product version does not move when an extension does.
- The **trust model** says what is checked, what the person is asked, and what is *not* protected.

## 2. Taxonomy

| Item | What it is | Runs as | Enable/disable takes effect | Existing decision |
|---|---|---|---|---|
| **Skill** | An Agent Skills folder: `SKILL.md` (YAML frontmatter + Markdown) plus optional `scripts/`, `references/`, `assets/` (§4.3) | Text read by the model. Scripts run only through the agent's own tools, under the approval policy | Next turn of each agent (§6.3) | D49, D56–D59, D64, D69, D71 |
| **Plugin · module** | A D14 module: `module.json` + entry script, a supervised process with the full module lifecycle | Supervisor child, restart class `module:<name>` (ADR-013) | Immediately, by supervisor stop/start | D14, D70 |
| **Plugin · channel** | A D14 module with package kind `channel` (Telegram, Discord, Matrix …) | As a module | As a module; bindings (D48) of a disabled channel show `disabled` | D48, D60 |
| **Plugin · MCP server** | A local MCP server (stdio; Node, Python via `uv`, or a binary; the payload *is* an MCPB tree, §4.4) or a remote one (Streamable HTTP, URL + auth) | Child process of the MCP client (2b) or a remote connection | Server stopped/started; agent tool lists change at the next turn | D17, D38, D46, D67 |
| **Plugin · bundle** | A named set of members of the kinds above, installed, enabled and updated together (the counterpart of a Claude Code plugin or an Anthropic "plugin" that carries skills plus MCP servers, §4.5) | Its members | Members together; a member can be switched off alone | ADR-008 (bundle import) |

**Proposed kind (2026-10-07, not yet in the schema): Agent Bridge connector.** The `agent-bridge` module (core spec §4.1) describes each external system it drives or attaches (ADR-011, `docs/host-adapters.md`) by a connector manifest; new connectors could ship as `.p1x` packages of a further plugin kind (working name `connector`), data only, loaded by the bridge. The manifest shape, its capability disclosure and its place in §5.2 are open and decided with the bridge's plan; until then, connectors ship with the module.

"Plugin" is the umbrella word for everything that is not a skill, because the UI already uses it that way (canvas `V2Plugins`: "MCP servers and bundles"; `V2Modules`: "Channels and add-ons use the same module contract … shows up under Plugins too"). "Extension" is the umbrella word for both skills and plugins in the code, the CLI's developer commands and this spec.

## 3. Non-goals

- **No sandbox in v1.** Modules and local MCP servers run as the owner's OS user; modules keep the full harness authority that `docs/module-guide.md` §9 already states. Declared capabilities are disclosed and partly enforced (§8.6), not sandboxed. A sandbox for untrusted plugins is §13 Q16.
- **No install hooks.** Installing never runs code from a package (no `postinstall`, no build step). Runtime dependencies are vendored in the payload or resolved by the harness's own pinned runtimes (D58 `uv`, the pinned Node) from a lockfile inside the package at first start.
- **No OpenClaw or Hermes plugin code is imported** (D9): their plugins are written against another host's API. The importer carries skills and MCP-server *configuration*, never plugin code (§7.3).
- **No paid listings, ratings, reviews, telemetry or accounts** in the catalogue. Search is client-side over the signed index.
- **No second update channel for the harness itself.** The harness product updates only through D78. Only extensions use the catalogue.
- **No commands, agents, hooks or LSP servers from Claude Code plugins.** Bundle import maps skills and MCP servers and reports everything else as skipped (§7.3).

## 4. Evidence (read 2026-09-27)

### 4.1 Microsoft Store policy (document version 7.20, published 2026-09-15, effective 2026-10-22)

`learn.microsoft.com/windows/apps/publish/store-policies`:

- **§10.1.5** allows, "with user consent and after initial download of the primary product", the acquisition of "add-ons or extensions, excluding non-Microsoft drivers or NT services, that enhance the functionality of the product." Extensions that a person chooses to install are therefore explicitly allowed.
- **§10.2.2**: "Your product must not attempt to fundamentally change or extend its described functionality or introduce features or functionality that are in violation of Store Policies through any form of dynamic inclusion of code. Your product should not, for example, download a remote script and subsequently execute that script in a manner that is not consistent with the described functionality." The Store listing must therefore **describe** skills and plugins as a feature, and extensions must stay within that description.
- **§10.2.3** forbids offering "secondary software that is not developed by you and does not enhance the functionality of your product". Extensions enhance the product; nothing else is offered.
- **§10.2.5** (installed and updated only through the Store) applies by its wording to game products and products offered on Xbox. The desktop spec §4.19 cites it for the app's own updater. That conclusion (no in-app self-updater in the Store build, DS32) still holds on §10.2.2 grounds, and this spec does not reopen it. It is noted here only so that nobody later reads §10.2.5 as a ban on extensions.

**Consequence (§10.5):** the Store build keeps the full extension feature, with consent at every install, and the listing names it. The MSIX package itself never downloads or runs extension code. All extension code runs inside the harness container (D77) or a native harness, which is not part of the MSIX package.

### 4.2 Flatpak / Flathub

The Flathub requirements (`docs.flathub.org/docs/for-app-authors/requirements`) say nothing about downloading add-ons at runtime. They ask for minimal static permissions and for portals where one exists. The Flatpak app is only the runtime controller (DS34). Extension files reach the harness through the harness API (§10.4, §10.6), and the Flatpak sandbox never holds or runs them.

### 4.3 Agent Skills specification (`agentskills.io/specification`)

A skill is a directory with `SKILL.md` plus optional `scripts/`, `references/`, `assets/`. Frontmatter:

- `name` (required): 1–64 chars, lowercase `a-z0-9` and `-`, no leading, trailing or double hyphen, and it **must match the parent directory name**.
- `description` (required): 1–1024 chars.
- `license`, `compatibility` (≤ 500 chars), `metadata` (a string→string map), and `allowed-tools` (experimental; "support … may vary") are optional.

Validation uses `skills-ref validate`. Progressive disclosure means the name and description are always loaded, the body on activation, and resources on demand. Anthropic's `skill-creator` packages a skill as a **`.skill` file: a ZIP whose root holds the skill folder** (`anthropics/skills`, `skills/skill-creator/scripts/package_skill.py`). The feature-rich Hermes frontmatter (`version`, `author`, `platforms`, `metadata.hermes.*`, `docs/import.md` §4) is a superset the importer keeps verbatim.

### 4.4 MCP Bundles and the MCP Registry

- **MCPB** (`github.com/modelcontextprotocol/mcpb`) is a ZIP with `manifest.json` at its root and a local server. `mcpb sign` appends a DER PKCS#7 signature after the ZIP between the markers `MCPB_SIG_V1`/`MCPB_SIG_END`, using X.509 certificates, self-signed or CA-issued (`CLI.md`). The appended bytes trip strict ZIP parsers (issue #278). The harness already imports MCPB/DXT (D46).
- **MCP Registry** (preview, `modelcontextprotocol.io/registry/package-types`): `server.json` (schema `…/schemas/2025-12-11/server.schema.json`) names servers `io.github.<user>/<name>` (reverse-DNS namespaces). `registryType: mcpb` packages are hosted on GitHub or GitLab Releases and **must carry `fileSha256`**, which "MCP clients do validate … before installation". OCI images must carry the `io.modelcontextprotocol.server.name` label.

### 4.5 Claude Code plugins and marketplaces (`code.claude.com/docs/en/plugin-marketplaces`, `…/plugins/manifest-reference`)

- A marketplace is `.claude-plugin/marketplace.json` (`name`, `owner`, `plugins[]` of `{ name, source, description, … }`). Sources are a relative path, `github`, `git-subdir`, `url`, `archive` (a zip over HTTPS), `npm` or `command`, with `ref`/`sha` pinning for git sources.
- A plugin is `.claude-plugin/plugin.json` (`name`, `version`, `description`, `author`, `license` as SPDX, `keywords`, `defaultEnabled`, `dependencies`, `userConfig`, component paths `skills`, `commands`, `agents`, `hooks`, `mcpServers` — which may name `.mcpb`/`.dxt` bundles — and `lspServers`).
- Neither the marketplace nor the plugin carries a signature. Trust is the git host plus the reserved official names.

We copy the vocabulary where it fits: `defaultEnabled`, `dependencies`, `userConfig` → secret slots and config, and bundles as "a plugin with skills plus MCP servers". We do not copy the unsigned trust model.

### 4.6 minisign

`jedisct1.github.io/minisign`: Ed25519 over the BLAKE2b-512 prehash of the file (algorithm `ED`, the default; legacy `Ed` can be refused). Keys have an 8-byte key id. The signature file is an untrusted comment, a signature line and a **trusted comment signed together with the signature** ("cannot be modified without the secret key"). The Rust verifier is `minisign-verify` (0.3.0, crates.io, updated 2026-09-25), which `tauri-plugin-updater` already depends on. The desktop updater uses minisign with per-channel keys (DS12).

## 5. The package format `.p1x`

### 5.1 Container

A `.p1x` file is a ZIP archive, media type `application/vnd.plur1bus.extension+zip`. It contains, at its root, exactly:

```
p1x.json            package manifest (§5.2), ≤ 1 MiB, UTF-8, no BOM
p1x.json.minisig    minisign signature over the exact bytes of p1x.json (optional: absent = unsigned)
payload/…           the item's files, and nothing outside payload/ besides the two files above
```

- **What the signature covers.** The signature covers `p1x.json`, and `p1x.json` lists the SHA-256 and the size of **every** payload file (`files`). The signature therefore binds the whole package without signing the ZIP bytes, and a re-zipped package with identical content still verifies. The trusted comment carries `p1x <id> <version> sha256(p1x.json)=<hex>`, so a signature cannot be moved onto another manifest.
- **Allowed ZIP features.** Entry methods are *stored* or *deflate* only. Not allowed: encryption, multi-disk, data before the first local header, bytes after the end-of-central-directory record, an archive comment, or a mismatch between a local header and its central-directory entry. The last three rule out appended-signature and parser-differential tricks (MCPB issue #278).
- **Payload per kind.**
  - `skill`: `payload/` *is* the skill folder, with `payload/SKILL.md`.
  - `module`, `channel`: `payload/` is the module directory, with `payload/module.json` (D14).
  - `mcp-server` (local): `payload/` is an MCPB tree, with `payload/manifest.json`.
  - `mcp-server` (remote): no payload beyond an optional `README.md`.
  - `bundle`: `payload/members/<name>.p1x`. Each member is a complete `.p1x`, verified by the same code. Nesting goes one level deep only.

### 5.2 Manifest `p1x.json` (schema `https://plur1bus.app/schema/p1x/1/p1x.schema.json`, draft 2020-12, closed, `x-stability: experimental`)

```jsonc
{
  "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
  "format": 1,
  "id": "plur1bus/zabbix-triage",           // <publisher>/<name>
  "name": "zabbix-triage",                   // local name: directory, module name, SKILL.md name
  "version": "1.2.0",                        // semver 2.0.0; independent of the harness version
  "kind": "skill",                           // skill | module | channel | mcp-server | bundle
  "title":   { "en": "Zabbix triage", "de": "Zabbix-Triage" },
  "summary": { "en": "…", "de": "…" },       // ≤ 280 chars each; shown before install
  "publisher": { "id": "plur1bus", "name": "PLUR1BUS", "url": "https://plur1bus.app" },
  "licence": "MIT",                          // SPDX expression; licence/NOTICE files must be in files
  "homepage": "https://…", "repository": "https://github.com/…",
  "compat": {
    "harness": ">=0.2.0 <1.0.0",             // semver range over the harness product version (D78)
    "moduleApi": ["1"],                      // module, channel: supported module apiVersion values (D14)
    "rpc": "^1.4",                           // RPC range the item calls, if any
    "platforms": ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64", "win32-arm64"],
    "container": true                        // works inside the D77 harness container
  },
  "requires": {                              // runtimes the harness supplies; never installed silently
    "runtime": { "type": "node", "range": ">=24" }   // | { "type": "python", "range": ">=3.12", "via": "uv", "lock": "payload/uv.lock" } | { "type": "binary" } | { "type": "none" }
  },
  "dependencies": [ { "id": "plur1bus/markitdown", "range": "^1.0" } ],
  "capabilities": {                          // §8.6: disclosed before install, enforced where stated
    "network":    { "mode": "none" },        // none | allowlist (+ "hosts") | any
    "filesystem": [ { "scope": "extension-data", "access": "read-write" } ],   // agent-workspace | extension-data | home | path (+ "path")
    "processes":  { "spawn": false },        // true (+ optional "commands")
    "secrets":    [ { "slot": "apiKey", "label": { "en": "API key", "de": "API-Schlüssel" }, "required": true } ],
    "hostBridge": [],                        // computer-use | notifications | file-pick | keychain (D77 host bridge)
    "harness":    { "authority": "none" },   // none | scoped (+ "rpc": [...]) | full  (modules today: full, §8.6)
    "tools":      [ { "name": "run_query", "effect": "read" } ],   // read | write | destructive (MCP servers, modules offering tools)
    "mcpApps":    false                      // MCP Apps ui:// resources (D17)
  },
  "remote": null,                            // mcp-server remote: { "url": "https://…", "auth": "oauth" | "header" | "none" }
  "members": null,                           // bundle: [ { "name": "…", "path": "payload/members/….p1x", "sha256": "…", "optional": false } ]
  "upstream": null,                          // e.g. { "mcpRegistry": "io.github.foo/bar", "skill": "github.com/…@<sha>" }
  "defaultEnabled": false,                   // honoured only for bundled items (§7.4)
  "scripts": ["payload/scripts/triage.py"],  // must equal the set the verifier derives (§8.4)
  "files": {
    "payload/SKILL.md":          { "sha256": "…", "size": 4210 },
    "payload/scripts/triage.py": { "sha256": "…", "size": 1880, "exec": true },
    "payload/LICENSE":           { "sha256": "…", "size": 1071 }
  },
  "notes": { "en": "…", "de": "…" },         // user-facing release notes for this version (D78 style, ≤ 1 200 chars)
  "created": "2026-10-01T12:00:00Z"
}
```

**Naming rules.**

- `publisher` matches `^[a-z][a-z0-9-]{0,31}(\.[a-z0-9-]{1,32})*$`. Examples: `plur1bus`, `io.github.jdoe`, `com.example`, the MCP Registry style.
- `name` matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` with at most 62 characters. This is the intersection of the D14 module-name pattern and the Agent Skills `name` rule, written without lookaround so that ajv and the Rust `regex` crate agree (ruling H3B-R11). The D14 reserved names are refused.
- The local name is unique per installation across all kinds, because it is a directory name, a module name and a skill name at once. Installing `a/foo` while `b/foo` is installed is refused with `name-taken`.
- **Kind-specific consistency is checked on the staged tree.** For a skill, the `SKILL.md` `name` equals `name`, and the frontmatter passes the Agent Skills rules. For a module or channel, the `module.json` `name` and `version` equal the manifest's, and every D14 install refusal applies, including `socket-path-too-long`. For a local MCP server, the MCPB `manifest.json` validates, and its `server.type` agrees with `requires.runtime`.

**`module.json` gains an optional `kind: "module" | "channel"`.** This is an additive property under module API 1, so D60's `kind: channel` becomes a real field and the closed D14 schema accepts it. The `.p1x` manifest stays the authority for the package kind; the `module.json` field exists so that `module list` can show the kind without the package.

### 5.3 Other inputs normalised into the same pipeline

All of these end in the same staged-tree checks and the same state record. The local `p1x.json` synthesised for an unsigned input records `source` and trust `unsigned`.

| Input | Accepted by | Becomes |
|---|---|---|
| `.p1x` | `skill install`, `plugin install`, UI, D1 file association | as declared |
| A skill folder with `SKILL.md`, a `.zip` or an Anthropic `.skill` holding one | `skill install` | `skill`, trust `unsigned` (the feat/import-detect contract, §7.3) |
| `.mcpb`, `.dxt` | `plugin install` (and D46's `mcp import`, now an alias) | `mcp-server`. An MCPB PKCS#7 signature is verified and shown ("signed by <subject>, not a PLUR1BUS key"), and the trust tier is `unknown-signer` (§8.2) |
| A Claude Code plugin directory or zip (`.claude-plugin/plugin.json`) | `plugin install` | `bundle` of its `skills/` and `mcpServers`; `commands`, `agents`, `hooks`, `lspServers`, `outputStyles` are listed as skipped |
| A module directory | `module install <dir>` (D14, unchanged) | `module`, trust `dev`, labelled *Developer install* everywhere |
| An MCP Registry entry (`server.json`, `registryType: mcpb`, with `fileSha256`) | catalogue only, as `upstream.mcpRegistry` | `mcp-server` whose package is the upstream MCPB, re-wrapped and signed by us after review |

## 6. Lifecycle

### 6.1 States

```
                 install (verified + confirmed)
 available ─────────────────────────────────▶ installed(disabled) ◀──── restore (from trash)
 (catalogue)                                   │      ▲
                                        enable │      │ disable
                                               ▼      │
                                             enabled ─┘
     installed / enabled ── update ──▶ updating ──▶ previous enable state (new version)
                                          └── health gate fails ──▶ rolled-back (old version, same enable state)
     installed / enabled ── uninstall ──▶ uninstalled (code in trash, data kept; purge also moves data)
```

- **Overlay conditions** are derived and shown instead of the plain state; they never silently change the configuration.
  - `needs-setup`: a required secret slot or runtime is missing.
  - `incompatible`: `compat` is no longer satisfied, for example after a harness update.
  - `revoked`: listed in the catalogue's revocation list (§8.5).
  - `tampered`: file hashes no longer match the recorded manifest (§8.7).
  - `error`: a module that `gave-up`, or an MCP server with `auth-required`.
  - An item under any of these is **not run**. Its enable flag is kept, so it resumes once the condition clears, except for `revoked` (§8.5).
- **Default after install.** A person's install from a file, the catalogue or the importer ends in **installed(disabled)**, exactly like the importer's "imported skills are disabled by default". The confirm dialog offers *Install* (primary) and *Install and enable for …* (one flow, two recorded transitions). Bundled items follow their `defaultEnabled` as decided per D-row (e.g. D62 `computer-use` off). §13 Q5.
- **Transitions are serialised per installation** by the supervisor, the way `module install` already is. A second mutation while one runs gets `E_CONFLICT reason=busy`.

### 6.2 One fact, one place

| Fact | Where | Owner |
|---|---|---|
| Package record: id, version, kind, source, trust tier, signer key id, package sha256, installedAt, previous version, pin/hold, skipped versions, auto-update choice | `extensions/state.json` (atomic write, schema-versioned) | supervisor |
| Original package bytes of the installed and the previous version | `extensions/cache/<sha256>.p1x` | supervisor |
| Skill files | `skills/<name>/` | supervisor (install), core (read) |
| Skill enabled flag and import provenance | `skills/index.json`, the feat/import-detect contract `{id, source, sourcePath, sha256, enabled, importedAt}` extended additively with `package: {id, version, trust} \| null` | supervisor writes, core reads |
| Per-agent skill selection | `agents.<id>.skills.blocked[]` / `pinned[]` in `config.json` (live; D69's pin/block) | supervisor (config) |
| Module and channel code | `modules/<name>/` (D14) | supervisor |
| Module and channel enabled | `modules.<name>.enabled` (restart class `module:<name>`, ADR-013) — **the only switch**, no second flag | supervisor (config) |
| MCP server code | `mcp/<name>/<version>/` (the D46 layout the canvas shows) | supervisor |
| MCP server enabled and per-agent lists | `mcp.servers.<name>.{enabled, agents}` (2b's namespace, live) | supervisor (config) |
| Extension data | `data/ext/<name>/`, passed to modules as `ctx.dataDir` (additive to `ModuleContext`) and to scripts and MCP servers as `P1X_DATA` | the extension |
| Secrets | secret store (ADR-005), refs `ext:<name>:<slot>`, leased at process start, never in config, logs, state or exports | core secret store |
| Catalogue cache | `extensions/catalog/{index.json, index.json.minisig, last-serial}` | supervisor |
| Trash | `extensions/trash/<name>-<version>-<utc>/` | supervisor |

`skills/index.json` and `extensions/state.json` overlap only in the skill's name and sha256. `1staid check extensions.consistency` reports any drift (an index entry without a package record is fine and means an imported or hand-placed skill; a package record without its files is `fail`).

### 6.3 Hot enable/disable

- **Skill.** The supervisor writes `skills/index.json` or the agent's `blocked` list and emits `ext.changed`. The core reloads its skill catalogue and applies it at the **next turn** of each agent; a running turn keeps its snapshot. D69 injection reads the new set. The skill name/description list sits in the prompt prefix, so a change costs one prompt-cache miss for that agent (ADR-010). This is accepted; `agents.<id>.skills.applyAt: next-turn | next-session` (default `next-turn`, `x-tier: advanced`) lets a person defer it. Until the 2c turn loop exists, the flag is honoured by every present consumer (the setup-copied skills, the 2b MCP server's skill resources, attached systems reading `skill list --json`).
- **Module and channel.** `modules.<name>.enabled` goes through the supervisor's existing apply sequence: stop within the grace budget, dependents become `needs-unavailable`; start, dependents resume (module-guide §3, §8). The UI and `plugin disable` show the dependents from `module.graph` **before** applying, as `config set` shows its restart plan (ADR-013 §4 step 2).
- **MCP server.** Disable closes the connection and stops the process; agents lose the tools at their next turn (one cache miss in zone 1). Enable connects lazily per ADR-008.
- **Bundle.** Toggles every non-optional member; a member toggled alone shows the bundle as `partially enabled`.

### 6.4 Uninstall, purge, restore

- **Uninstall.** Stop the item (for modules the existing `module.uninstall` path), then move its code directory and its cached package into `extensions/trash/`, and remove it from `skills/index.json` or mark it uninstalled in `state.json`.
- **What uninstall keeps.** Kept are `data/ext/<name>/`, its config section and its secrets, so a reinstall resumes. This matches D14's "`modules.<name>` stays in `config.json`".
- **Purge** (`--purge`, a separate confirmation naming what goes). It also moves `data/ext/<name>/` into the trash, deletes the config section, and **deletes the secrets**. Secrets are not recoverable, and the dialog says so.
- **Restore.** `plur1bus plugin restore <trash-id>` (or `skill restore`) within the retention window (default 14 days, `extensions.trashDays`, §13 Q14) brings back code, data and config as installed(disabled). Deleted secrets are asked for again.
- **Refusals.** Uninstall is refused with `E_CONFLICT reason=required-by` while an enabled item `needs` or depends on it, and the error lists the dependents. `--cascade` disables them first.
- **Bundled items** (§7.4) cannot be deleted, because the next release would bring them back. *Uninstall* hides them (`removed-by-user` in `state.json`) and a later release respects that.

## 7. Sources

### 7.1 From a file (first; X1)

- **CLI:** `plur1bus skill install <file|dir>` and `plur1bus plugin install <file|dir>` (§10.1).
- **Web UI:** a file picker and drag-and-drop on Skills › Library and Plugins › Installed.
- **D1:** the `.p1x` file association (§10.4).

Every path runs *inspect → show → confirm → install* (§9.2); nothing installs on inspect.

### 7.2 From the web: the signed catalogue (later; X4)

**URL decision: `https://extensions.plur1bus.app/v1/index.json`** (+ `index.json.minisig`), not `plur1bus.app/catalog/v1/…`. The reasoning follows the updates indirection (DS28):

- **The owner's domain carries only the small signed pointer.** The package bytes live on **GitHub Releases** (first-party: `Cyb3rb1ade/plur1bus-extensions`; third-party: the publisher's own releases), and each catalogue entry pins `url` + `sha256` + `size`. Moving packages to another org or host is a new signed index, never a client update.
- **A dedicated subdomain decouples hosting from the website.** `plur1bus.app` can become a marketing site on any stack; `extensions.` can be served by GitHub Pages from the extensions repository with a custom domain, or by any static host, and moved alone by a DNS change. It has its own TLS certificate and cookie scope; no session cookie of a website ever travels with catalogue requests.
- **`/v1/` names the index format**, so a future `v2` index is served beside `v1` while older harnesses keep working through their deprecation window (ADR-016 §5).
- **The key separation matches the host separation** (§8.1): `updates.plur1bus.app` ↔ updater keys; `extensions.plur1bus.app` ↔ extension keys.
- **Mirrors.** `extensions.catalogUrl` (`x-tier: advanced`) points a harness at a mirror or an internal copy. The index must still verify against the pinned keys, so a mirror can withhold packages but cannot inject any.

**Index format (`v1`):**

```jsonc
{
  "format": 1,
  "serial": 42,                                   // strictly increasing; clients refuse a lower one (rollback)
  "generatedAt": "2026-10-01T12:00:00Z",
  "expires": "2026-11-15T12:00:00Z",              // stale after this: no new installs or updates from it (§7.2.1)
  "keys": { "active": ["<keyid>", "<keyid>"], "retired": [] },          // §8.1 rotation
  "packages": [
    { "id": "plur1bus/zabbix-triage", "kind": "skill", "name": "zabbix-triage",
      "title": { "en": "…", "de": "…" }, "summary": { "en": "…", "de": "…" },
      "publisher": "plur1bus", "licence": "MIT", "homepage": "…", "tags": ["monitoring"],
      "versions": [
        { "version": "1.2.0", "url": "https://github.com/Cyb3rb1ade/plur1bus-extensions/releases/download/zabbix-triage-v1.2.0/zabbix-triage-1.2.0.p1x",
          "sha256": "…", "size": 18422, "signer": "<keyid>", "released": "2026-10-01",
          "compat": { "harness": ">=0.2.0 <1.0.0" }, "capabilities": { "network": { "mode": "none" } },
          "change": "patch", "security": false, "notes": { "en": "…", "de": "…" } } ] } ],
  "revocations": [ { "id": "io.github.jdoe/foo", "versions": "<=1.1.3", "action": "disable", "reason": { "en": "…", "de": "…" }, "advisory": "https://…" } ]
}
```

#### 7.2.1 Client rules

- **Fetches.** The catalogue is fetched at supervisor start and every 24 h (`extensions.catalog.refreshHours`, off switch `extensions.catalog.enabled`), and on demand. No identifiers are sent: no installation id, no installed list. HTTPS only.
- **Download hosts.** Hosts are allow-listed (`extensions.plur1bus.app`, `github.com/*/releases/download/*` and GitHub's release-asset redirect host). A redirect is followed only to an allow-listed host.
- **Egress.** The configured egress profile applies (D73).
- **Container mode.** In container mode the **harness container** fetches, never the desktop app (§10.5).
- **Verification.** The signature is verified with the pinned keys (§8.1). The index is refused if its `serial` is lower than `last-serial`.
- **Stale index.** After `expires` the cached index is `stale`: installed items keep running, search still shows cached entries marked stale, installs and updates from it are refused with `E_NOT_AVAILABLE reason=catalog-stale`, and revocations from it are **still applied**, because they only ever disable.
- **Offline.** Offline, everything installed keeps working, and file installs keep working.
- **Downloads.** A download streams into `extensions/cache/` with the `size` limit enforced while reading, then the sha256 is checked against the index, then the full §8.4 verification runs on the file as for any `.p1x`.
- **Two signatures.** A catalogue package therefore passes two checks: the index pins its hash, and its own `p1x.json.minisig` binds its content.

### 7.3 Imported from OpenClaw and Hermes (M7; detection on `feat/import-detect`)

- **Skills.** The importer on `feat/import-detect` writes `skills/<id>/SKILL.md` and `skills/index.json` `{id, source, sourcePath, sha256, enabled, importedAt}` with `enabled: false`. This spec **adopts that contract as-is**:
  - `id` is the local skill name.
  - `source` values `openclaw`, `hermes` stay, and this spec adds `file`, `catalog`, `bundled`, `mined` (D49 accepted proposals), `requested` (D71) and `dev`.
  - The only extension is the optional `package` field (§6.2).
  - Imported skills get trust `imported` (unsigned). The import wizard is the confirmation, and it lists every skill whose folder contains scripts (§8.4) before apply.
  - The conflict modes (`skip`/`rename`/`overwrite`, `docs/import.md` §5.3) apply unchanged, and `rename` must produce a valid Agent Skills name (with `SKILL.md` `name` rewritten to match, recorded in the report).
  - A skill folder whose name violates the Agent Skills rules is renamed by the same rule.
- **MCP servers configured in the source.** Their configuration is imported as `mcp-server` records (remote: URL + auth kind; stdio: command + args), disabled, with trust `imported`. Secrets move only through the importer's opt-in allowlist into the secret store (`docs/import.md`).
- **Plugins of OpenClaw (`extensions/`) and Hermes** are listed in the report as "not portable" with their names, and never copied (D9, §3).

### 7.4 Bundled (D57)

- **Where they come from.** Skills vendored in the release (`skills/third-party/…` with `CHECKSUMS`, plus first-party skills) are copied by `setup` into `skills/` with `source: bundled` and trust `release`, meaning covered by the release's own signature (D78), not by the extension key.
- **Updates.** They update only with a harness release; `update --check` reports upstream drift (D57), and the catalogue never overwrites a bundled item unless the owner moves that item into the catalogue (§13 Q15).
- **Channels.** First-party channel modules (D60) are bundled at the release's pinned version **and** published as `.p1x` in the catalogue. A harness release sets the floor; between product releases the catalogue may deliver newer compatible versions of them (patch and minor by default), which is the add-on half of conflict C6 (§9.4).

## 8. Trust model

### 8.1 Keys

- **A separate first-party extension key.** The key is minisign/Ed25519, separate from the updater's `dev`/`beta`/`stable` keys (DS12). A leaked updater key must not let anyone push add-ons to every installation, and a leaked extension key must not let anyone ship a harness build. The custody also differs: extension packages and the index are signed much more often.
- **Two public keys are pinned in the harness binary** (Rust constant, mirrored in `packages/module-api`'s constants for tooling):
  - **`ext-primary`**: its secret lives in the GitHub Environment `extensions-release`, with the owner as the required reviewer.
  - **`ext-backup`**: generated offline and kept in the owner's password manager; never in CI.
- **Rotation.** An index signed by a currently pinned key may add a key to `keys.active` and move one to `keys.retired`. The client adds a new key only if the index carrying it verifies with a key that was already trusted, and records the change. The next harness release pins the new set.
- **Loss of both keys** means one harness release with a new pinned set; installed items keep running.
- **Third-party publisher keys (later, §13 Q7).** v1 lists third-party packages only after review, **re-signed by `ext-primary`**: the catalogue is a curated list, and the `publisher` field records who wrote the package. A later v2 adds `publishers[]` to the index (publisher id, key id, allowed name prefix) signed by the first-party key, so a reviewed publisher can sign their own updates within their namespace. The format does not change for that; only the trust store grows.

### 8.2 Trust tiers (computed per install, shown everywhere, recorded in `state.json`)

| Tier | Meaning | Confirmation |
|---|---|---|
| `release` | Bundled with a signed harness release (§7.4) | none (part of the product) |
| `first-party` | `p1x.json.minisig` verifies with a pinned or index-delegated first-party key | normal confirm dialog |
| `publisher` | (v2) verifies with a publisher key the index delegates for that `id` prefix | normal confirm dialog |
| `unknown-signer` | A valid signature by a key we do not trust (minisign key id shown), or an MCPB X.509 signature (subject shown) | explicit acknowledgment `unknown-signer` |
| `unsigned` / `imported` | No signature; a folder, zip, `.skill`, unsigned `.mcpb` or importer output | explicit acknowledgment `unsigned` |
| `dev` | `module install <dir>` | the developer command itself; labelled *Developer install* |

- **Policy switches.** `extensions.allowUnsigned` (default `true`, `x-tier: advanced`) lets an admin forbid the last three tiers: `E_DENIED reason=policy-unsigned-disallowed`.
- **Who may act.** Under ADR-007, install, uninstall, update and purge need the Owner/Admin capability `extensions.manage`. Enable/disable for one agent needs `manage` on that agent. An agent (through the ops skill or MCP) may **propose** an install; a person confirms, never the agent (D71, D32's rejected auto-approval).

### 8.3 The acknowledgment for unsigned and unknown-signer packages

The confirm dialog, the CLI's inspection output and the `ext.inspect` result show, before any install:

- the trust tier and why, and the signer key id or certificate subject;
- the kind, id, version, publisher claim (marked *unverified* below `first-party`), licence and summary;
- **every capability** (§8.6) in plain language;
- **every script and executable file** by path, size and first line (the shebang) — a skill with `scripts/` says "contains 2 programs your agents can run";
- the runtime it needs, the secrets it will ask for, and whether it replaces an installed version (with the diff of capabilities).

The primary button reads *Install unsigned package* or *Install package from unknown signer* (canvas `V2Plugins` already draws the first). The CLI refuses without `--allow-unsigned` / `--allow-unknown-signer` plus `--yes` in a non-interactive shell (exit 2 with the inspection document, mirroring `config set`).

### 8.4 Verification before unpacking

The order is binding, and every step runs on the file before anything is written outside the staging directory:

1. **Size.** The file is no larger than `extensions.limits.packageBytes` (default 256 MiB; skills 16 MiB).
2. **Whole-file hash.** SHA-256 of the whole file, compared with the catalogue entry when the file came from the catalogue.
3. **Strict ZIP parse.** The central directory is parsed with the §5.1 rules. At most 20 000 entries. Every name is valid UTF-8 in NFC. Refused:
   - absolute paths, drive letters, backslashes, NUL or control characters, `.` or `..` segments, or an empty segment;
   - more than 16 segments or more than 240 bytes;
   - a Windows reserved device name or a trailing dot or space in any segment;
   - two names that differ only by case or Unicode normalisation;
   - symlinks and hard links (from the external attributes);
   - directories other than implied ones;
   - an entry whose declared uncompressed size exceeds 128 MiB or whose compression ratio exceeds 100:1.
4. **Read and verify the manifest.** `p1x.json` and `p1x.json.minisig` are read into memory (≤ 1 MiB each) and the signature is verified. The trusted comment must name the manifest's id, version and hash. This yields the trust tier.
5. **Validate the manifest** against the schema, then `compat` against this harness (version, module API window, platform, container mode).
6. **Entry set equals `files`, exactly.** No extra entry and no missing entry; sizes agree. The verifier derives the **script set** — files with the exec bit, a shebang, or under `scripts/` or `bin/`, and native binaries by magic number (ELF, Mach-O, PE) — and it must equal `scripts`. A mismatch is `package-invalid` for a signed package and a warning in the inspection for an unsigned one.
7. **Revocation check** against the cached revocation list, even offline (§8.5).
8. **Inspection returned** (§9.2); stop here unless the person confirms.
9. **Extract on confirm** into `extensions/staging/<name>.tmp-<pid>/`, streaming, re-hashing each file and comparing it with `files`, with no permissions beyond `0644`/`0755`, fsync, and the Windows ACL inherited from the state root.
10. **Kind checks on the staged tree** (§5.2).
11. **Commit by rename** with the D14 stage/commit/recovery pattern (`.tmp-<pid>`, `-old`, `-rm`, restored on failure, recovered at supervisor start). The package bytes are then stored in `extensions/cache/`.

Refusals map to `E_INVALID_PARAMS` with `reason` ∈ `package-invalid`, `signature-invalid`, `hash-mismatch`, `path-unsafe`, `too-large`, `zip-unsupported`, `scripts-mismatch`, `incompatible`, `name-taken`, `reserved-name`, `socket-path-too-long`. Any refusal leaves the tree byte-identical (the D14 guarantee, extended). The parser and verifier live in one Rust crate (`crates/plur1bus-ext`, on the `zip` crate in its strictest mode plus our own central-directory checks, and `minisign-verify`) and are fuzzed in CI (§12).

> **Amended by the X1 plan (X1-R4, X1-C18, X1-C19; shipped in RPC 1.4.0, `docs/extensions.md` §2, ADR-016).** The reasons above are not the shipped vocabulary, and not all of them are `E_INVALID_PARAMS`.
>
> | This section | Shipped `reason` | Code |
> |---|---|---|
> | `path-unsafe` (unsafe name, symlink, hard link, special or explicit directory entry) | `archive-unsafe-entry` | `E_INVALID_PARAMS` |
> | `zip-unsupported` | `archive-unsupported` | `E_INVALID_PARAMS` |
> | `too-large` (any size, count or ratio cap) | `download-too-large` | `E_INVALID_PARAMS` |
> | `hash-mismatch` (per-file, whole-file, CRC) | `digest-mismatch` | `E_INVALID_PARAMS` |
> | `package-invalid`, `signature-invalid`, `scripts-mismatch`, `reserved-name`, `socket-path-too-long` | unchanged | `E_INVALID_PARAMS` |
> | `incompatible` | unchanged | `E_NOT_AVAILABLE` |
> | `name-taken` | unchanged | `E_CONFLICT` |
> | (new) `kind-unsupported` | an `mcp-server` or `bundle` package, or an `.mcpb`/`.dxt`/Claude Code plugin input, before X2 | `E_NOT_AVAILABLE` |
> | (new) `revoked`, `policy-unsigned-disallowed` | at inspection and again at install | `E_DENIED` |
>
> The renames follow the frozen vocabulary of the installer (module-guide §12 point 2; no name is ever renamed, ADR-016 §2), which wins over this list. Reasons for a state the shipped enum has no value for reuse the nearest one: a missing code folder on enable is `tampered` (X1-C18). **Wherever this spec says `data.capabilities` or `data.dependents`, the shipped field is `error.data.ext.capabilities` and `error.data.ext.dependents`** (X1-C19: `ErrorObject.data` is closed and gained one optional `ext` object). §8.4's ordering also changed in one place (X1-R7): the audit streams every entry once at inspection, so a hash mismatch, a lying size and a deflate bomb are refused at inspection, not at extraction; extraction re-hashes.

### 8.5 Revocation

- **Listing.** An entry in `revocations` with `action: disable` matches installed items by `id` + semver range, whatever their source (a file-installed copy of a revoked catalogue package is revoked too, matched by id and version).
- **Effect.** A matching item is stopped and shown `revoked`, and it cannot be enabled. The person gets a notice with the reason and advisory link through `ext.changed`, `1staid check` (`extensions.revoked`: `fail`), a UI banner and channel delivery to the owner.
- **Override.** Re-enabling a revoked item needs `--force-revoked` plus a typed confirmation of the item name, and is audit-logged (§13 Q9).
- **`action: warn`** shows the notice without stopping the item.
- **Install-time check.** Revocation is also checked at install time from the cached list, so an offline file install of a known-bad version is refused (`E_DENIED reason=revoked`).

### 8.6 Capabilities: disclosure and enforcement

| Capability | Shown | Enforced in v1 |
|---|---|---|
| `secrets` | slots and labels, required or not | **Yes.** Only declared slots are created and leased; the process environment is scrubbed of everything else the harness knows; no ambient keys (ADR-005's fail-closed scoping) |
| `harness.authority` | none / scoped (RPC list) / full | **Modules: no** — every module has full authority today (module-guide §9), and the dialog says "full control of PLUR1BUS" for every module and channel. **Skills and MCP servers: yes** — they get no harness token at all; skill scripts act only through the agent's tools |
| `tools` (effect) | per tool: read / write / destructive | **Yes**, as the default approval mode per tool (D38): `write`/`destructive` start at *ask*; a server's own annotations never lower that |
| `processes`, `network`, `filesystem` | plain language | **Partly.** Skill scripts run only through the agent's shell/exec tool, so the existing approval policy and D38's "no auto-approve" gate every run; `allowed-tools` in `SKILL.md` is shown and **never** pre-approves anything unless the person pins it per agent. Modules and local MCP servers get their own cwd and `P1X_DATA`, but **no OS-level sandbox**: declared network and filesystem scopes are not enforced for them |
| `hostBridge` | named bridge capabilities | **Yes** in container mode: the host bridge only answers capabilities granted to that item (D77) |
| `mcpApps` | yes/no | **Yes**: `ui://` resources render sandboxed per D17 |

An update that **widens** capabilities (a new secret slot, network from `none` to anything, a new destructive tool, authority raised) is never applied automatically, not even a patch. It asks with the capability diff (§9.4).

### 8.7 Integrity at rest

- **When hashes are checked.** At supervisor start and every 24 h, the files of enabled skills, modules and local MCP servers are re-hashed against their recorded manifest. The cost is bounded by the size caps; large modules are hashed in the background.
- **On mismatch.** The item is `tampered` and not run, and `1staid check extensions.integrity` reports `fail` with the paths.
- **Repair.** `1staid repair` offers reinstalling from `extensions/cache/` (verified again) or keeping the local change as a new unsigned `dev` item.

### 8.8 What is NOT protected

- **A signed package is only as good as its review.** `first-party` means the owner's key signed it after the §11.3 checklist, not that it is harmless. A malicious or compromised upstream that passes review is installed as trusted until revoked.
- **Modules and channels run with full harness authority and the OS user's rights.** They can read `run/*.token`, call every RPC method, and read and write whatever that user can. Declared capabilities for them are disclosure, not a boundary.
- **Local MCP servers and skill scripts run as the OS user.** A script the person approves runs with that user's rights. The approval prompt is the only gate, and approval fatigue defeats it.
- **Skill text is instructions by nature.** A skill can steer the model (prompt injection by design). Showing `SKILL.md` before enabling, D69's per-agent block list and the approval policy for side effects limit the damage; nothing prevents a skill from giving bad advice.
- **Unsigned and unknown-signer installs rely entirely on the person** reading the dialog.
- **Key compromise.** Between a key compromise and the next index with a rotation or revocation, the attacker can sign packages that verify. The `expires` window (45 days by default, §13 Q11) bounds how long a withheld index stays authoritative, not how long a compromise goes unnoticed.
- **Local write access to the state root** can change installed files. §8.7 detects this after the fact at the next check; it does not prevent it, and an attacker who can also rewrite `extensions/state.json` defeats it.
- **Dependencies vendored inside a package** (e.g. `node_modules`) are reviewed at the pinned version only; their later CVEs reach users only through a new package version or a revocation.
- **The catalogue does not hide what you install from GitHub.** Downloads come from GitHub Releases, which sees the IP address and the asset requested.

## 9. Updates for extensions

### 9.1 Model

- **Independent versions.** Extension versions are independent of the harness product version, and each item updates alone. The semver meaning is D78's: patch = fixes only, no data migration; minor = features, forward migration of the item's own data allowed; major = breaking, with a migration note. The index marks each version with `change: patch|minor|major` and `security`.
- **Per-item choice.** Each item offers *Jetzt / Später / Überspringen* (skip records the version in `state.json`) and *Version halten* (pin; `ext.pin`). Notes are shown in de/en from the manifest before anything installs.
- **Automatic patch updates:** **on for `first-party` items, off for all other tiers** by default. Per item, the person can turn them on or off. Minor and major updates always ask. A capability-widening update always asks (§8.6). §13 Q8.
- **Checks** run with the catalogue refresh (§7.2.1), never more often. `plur1bus skill|plugin update --check` lists candidates.

### 9.2 Inspect-confirm, the same for install and update

`ext.inspect` returns an `inspectionId` bound to the package sha256 and valid for 10 minutes. `ext.install` / `ext.update` take that id, so what is installed is byte-for-byte what was shown. There is no time-of-check-to-time-of-use gap: the staged bytes are re-hashed at extraction.

### 9.3 Safe update sequence (per item; the D78 sequence scaled down)

1. **Download and verify** (§8.4) the new version into the cache.
2. **Pre-flight.** Check `compat`, dependencies, and whether the update widens capabilities (ask if it does).
3. **Snapshot** the item's code directory and `data/ext/<name>/` into `extensions/snapshots/<name>-<from>/` with a SHA-256 manifest.
4. **Stop** the item. A module or channel stops through the supervisor; its dependents go `needs-unavailable` for the duration.
5. **Swap** the directories with stage/commit.
6. **Start** the item, if it was enabled.
7. **Health gate:**
   - module or channel: `running`, `module.status` answers, and it stays up for the supervisor's stable-ready window;
   - MCP server: `initialize` + `tools/list` succeed within 15 s;
   - skill: the staged `SKILL.md` validates, and the core's reload of it succeeds;
   - bundle: every member passes its gate.
8. **Rollback on failure.** Automatic rollback to the snapshot and the previous code, with the same enable state; the person is told which step failed; state `rolled-back` until the next successful update.

The previous version's package and snapshot are kept until the next successful update of that item (as D78 keeps `-previous`). `plur1bus plugin update <name> --rollback` returns to it manually.

### 9.4 Relation to the harness product update (D78) and conflict C6

- **Harness releases.** A harness update stays one atomic product update with downtime between stop and health gate (D78, desktop spec §6.15.8).
- **Installed extensions in the harness pre-flight.** D78's pre-flight gains one check: every enabled extension's `compat.harness` and `compat.moduleApi` against the *new* version.
  - An extension that would become `incompatible` is listed in the update dialog ("will be switched off: zabbix-bridge 1.1.0 needs harness < 0.4") before *Jetzt*.
  - If the catalogue has a compatible version of it, the dialog offers to update that extension **first**, through §9.3.
  - After the harness update, extensions with a newer compatible version are offered as ordinary extension updates.
- **Resolution of conflict C6.** The canvas `V2Modules` card draws per-module targets ("session-store → 0.3.0, channel-telegram → 0.2.1"), rolling updates without downtime, and a 14-day rollback. The split resolves it:
  - **Harness units** (core, supervisor, first-party built-in modules such as session-store) move together as one D78 update. The card is redrawn as the product update (reading 1).
  - **Add-ons and channels** are extensions and update **one at a time, without harness downtime**, restarting only themselves (restart class `module:<name>`). That is reading 2, restricted to the units that can safely roll.
  - The 14-day figure becomes the trash retention (§6.4). Update snapshots are kept until the next successful update.

## 10. Surfaces

### 10.1 CLI (every leaf `[experimental]`, `--json` with `schema: "<command>/1"`, offline behaviour as `module`)

```
plur1bus skill  list [--agent <id>] [--source <s>] [--state <s>]
plur1bus skill  show <name>
plur1bus skill  install <file.p1x|file.skill|file.zip|dir|publisher/name[@version]> [--enable[=<agent,…>]] [--allow-unsigned|--allow-unknown-signer] [--dry-run] [--yes]
plur1bus skill  uninstall <name> [--purge] [--cascade] [--yes]
plur1bus skill  restore <trash-id>
plur1bus skill  enable|disable <name> [--agent <id>…]          # no --agent = installation-wide flag
plur1bus skill  update [<name>|--all] [--check] [--version <v>] [--rollback] [--yes]
plur1bus skill  pin|unpin <name> [--version <v>] ; skill skip <name> <version>
plur1bus skill  search <query>                                   # catalogue, kind=skill
plur1bus skill  proposals list|show|accept|reject                # D49, unchanged
plur1bus plugin list|show|install|uninstall|restore|enable|disable|update|pin|unpin|skip|search   # same shapes; install also takes .mcpb/.dxt and Claude Code plugin dirs; --kind module|channel|mcp-server|bundle filters
plur1bus ext    inspect <file|dir|publisher/name[@version]>      # verification + inspection document, installs nothing
plur1bus ext    catalog refresh|show
plur1bus ext    pack <dir> [-o file.p1x] ; ext verify <file.p1x> ; ext lint <dir|file>   # developer/publisher tools, offline, no supervisor needed
```

- **`install --dry-run`** is `ext inspect`. `install` without `--yes` in a non-interactive shell exits 2 with the inspection document (as `config set`).
- **Supervisor use.** Every mutating verb goes through the supervisor when one answers. Offline, it takes `run/supervisor.lock` and acts on disk, like `module install` (module-guide §9). Catalogue verbs need network, not a supervisor.
- **Container mode.** The host `plur1bus` forwards (ADR-012 §11). For a host **file** argument it streams the bytes over the runtime's `exec -i` into `plur1bus ext inspect --stdin` inside the container, so a host path never has to be visible in the container.
- **`module install <dir>`** stays the developer path (trust `dev`). `mcp import <file>` (D46) becomes an alias of `plugin install`.

### 10.2 RPC (`x-server: "supervisor"`, `x-stability: "experimental"`, `x-since` = the next RPC minor after 2a-H3b-b — 1.4.0 if nothing else claims it first; the X1 plan fixes the number)

Params are closed (`additionalProperties: false`) and the error codes are the existing `ErrorCode` enum. No new code is needed; `reason` carries the case.

| Method | Params | Result | Errors (`reason`) |
|---|---|---|---|
| `ext.list` | `{ kind?: Kind[], state?: State[], agent?: AgentId }` | `{ items: ExtItem[] }` (name, id, kind, version, source, trust, state, overlays[], enabled, agents, update?: {version, kind, security}) | — |
| `ext.show` | `{ name }` | `ExtDetail` (manifest, capabilities, scripts, trust, signer, files summary, dependents, snapshots, trash entries) | `E_NOT_FOUND extension-unknown` |
| `ext.inspect` | `{ source: { path } \| { upload } \| { catalog: { id, version? } } }` | `{ inspectionId, expiresAt, sha256, manifest, trust: { tier, keyId?, subject? }, checks: [{ id, status: pass\|warn\|fail, detail }], capabilities, scripts, requires, replaces?: { version, capabilityDiff } }` | `E_INVALID_PARAMS` (§8.4 reasons), `E_DENIED revoked\|policy-unsigned-disallowed`, `E_NOT_AVAILABLE catalog-unreachable\|catalog-stale` |
| `ext.install` | `{ inspectionId, acknowledge?: ("unsigned"\|"unknown-signer"\|"downgrade"\|"capabilities")[], enable?: { agents: "all" \| AgentId[] }, config?: object, secrets?: { [slot]: SecretRef } }` | `{ name, version, kind, replaced, state }` | `E_NOT_FOUND inspection-expired`, `E_APPROVAL_REQUIRED acknowledge-unsigned\|acknowledge-unknown-signer\|acknowledge-downgrade\|acknowledge-capabilities`, `E_CONFLICT busy\|name-taken\|dependency-missing`, `E_DENIED revoked\|policy-unsigned-disallowed`, `E_INVALID_PARAMS` |
| `ext.uninstall` | `{ name, purge?: boolean, cascade?: boolean }` | `{ name, removed: true, trashId, purged }` | `E_NOT_FOUND`, `E_CONFLICT required-by\|busy`, `E_DENIED bundled` (for purge of a bundled item) |
| `ext.restore` | `{ trashId }` | `{ name, version, state }` | `E_NOT_FOUND trash-expired`, `E_CONFLICT name-taken` |
| `ext.enable` / `ext.disable` | `{ name, agents?: "all" \| AgentId[] }` | `{ name, state, restart: { modules: string[] }, heldBack: string[] }` | `E_NOT_FOUND`, `E_NOT_AVAILABLE needs-setup\|incompatible\|tampered`, `E_DENIED revoked` |
| `ext.update` | `{ name?, all?: boolean, check?: boolean, version?, rollback?: boolean, inspectionId? }` | check: `{ candidates: [...] }`; apply: `{ results: [{ name, from, to, outcome: updated\|rolled-back\|skipped, failedStep? }] }` | `E_APPROVAL_REQUIRED acknowledge-capabilities`, `E_NOT_AVAILABLE catalog-stale`, `E_CONFLICT busy\|pinned` |
| `ext.pin` / `ext.unpin` / `ext.skip` | `{ name, version? }` | `{ name, pin: string\|null, skipped: string[] }` | `E_NOT_FOUND` |
| `ext.catalog.refresh` | `{}` | `{ serial, fetchedAt, expires, stale, packages: integer, revokedNow: string[] }` | `E_NOT_AVAILABLE catalog-unreachable\|catalog-disabled`, `E_INVALID_PARAMS signature-invalid\|serial-rollback` |
| `ext.search` | `{ query, kind?: Kind[] }` | `{ entries: CatalogEntry[], stale }` | `E_NOT_AVAILABLE catalog-empty` |

- **Notification.** `ext.changed { name, kind, state, version, overlays }` (`x-server: "supervisor"`). The core subscribes, to reload skills and MCP sets; the UI subscribes, for live rows.
- **Uploads.** `upload` in `ext.inspect` is the id of a file the M3 HTTP API received (`POST /api/v1/extensions/upload`, size-capped, stored in `run/uploads/`, deleted after 10 minutes). It is the only way a remote client or the desktop app hands a file to a container harness.
- **Existing methods.** `module.install|uninstall` stay, for dev installs and internal use by `ext.*`.
- **WebMCP.** `ext.install`, `ext.uninstall`, `ext.update` and `ext.enable` are added to the WebMCP deny list (D55/B15 pattern: an agent may call `ext.inspect`, `ext.list`, `ext.search`, never a mutation).

### 10.3 Web UI (M3; boards of the design canvas)

| Board | Becomes | Changes against the canvas |
|---|---|---|
| `V2SkillsLibrary` (Skills › Library) | The skills list: *Included with PLUR1BUS* (bundled), *Yours* (file, mined, requested, imported), *From the catalogue*; per-skill detail with trust badge, source, licence & notice, *Agents using it* switches (the per-agent `blocked` list), *Open SKILL.md* | Add an installation-wide enable switch in the detail header, a trust/source badge row, *Update available* in the footer, *Uninstall* in an overflow menu. *Import skill* opens the install panel (file, folder, `.skill`, `.p1x`) with a second tab *From OpenClaw/Hermes* that starts the M7 importer. A new tab *Catalog* (skills filter of §10.3's shared catalogue view) |
| `V2Skills` (Skills › Proposals) | D49 unchanged; an accepted proposal lands as a `mined` skill, **disabled** until switched on unless `skillMiner.autoApply` | none |
| `V2Plugins` (Plugins › Installed) | Rows for every plugin kind, with a kind chip, trust badge, enable switch per row, overflow menu (Update, Pin version, Uninstall, Details). The drawn *Import MCP bundle* side panel becomes the generic **install panel** for `.p1x`/`.mcpb`/`.dxt`/plugin folders: checks list (signature and trust tier, compatibility, runtime found, capabilities), declared tools with allow/ask, configuration (secret slots marked "goes to the secret store"), *Enable for* agents, footer with the install target and the tier-specific primary button | Title "Install from file"; checks gain the trust line and the scripts list; the canvas's "Installs to ~/.plur1bus/mcp/…" footer stays |
| (none) Plugins › Catalog | The shared catalogue view: search, kind filter, entry detail (summary, capabilities, publisher, licence, versions, notes), *Install* → install panel with catalogue source | **Gap D-X1**: no board exists; derived from `V2Plugins` rows + install panel |
| `V2Modules` (Settings › Modules & Updates) | Harness units and extensions in one table with the Kind column as drawn (Supervisor, Core, Module, Add-on, Channel). The top card shows only the **harness product update** (D78). Add-on and channel rows carry their own *Update* action and version arrow | Per C6 (§9.4): the card's "Updates roll through modules one by one" text moves to the add-on/channel rows; "Rollback … kept for 14 days" becomes the uninstall trash retention; *Install add-on* opens the install panel |
| `V2PluginsServer` | Unchanged (the harness as an MCP server, not an extension) | — |
| `V2McpApp` | MCP Apps of installed MCP servers render per D17; the install panel shows `mcpApps` as a capability | — |

**Further gaps with no board:** the per-extension update dialog (D-X2; reuse the D78 dialog layout per item), the revocation banner (D-X3), the uninstall/purge dialog (D-X4), and the unknown-signer/unsigned acknowledgment state of the install panel (D-X5; the canvas draws only the unsigned MCPB button).

### 10.4 D1 desktop app

- **File association `.p1x`** (Windows ProgID, macOS UTI `app.plur1bus.extension` conforming to `public.zip-archive`, Linux shared-mime-info `application/vnd.plur1bus.extension+zip`).
  - Opening a `.p1x` brings up the app, which uploads the bytes to the active connection's harness API (§10.2 `upload`) and opens the SPA route `/extensions/confirm?inspection=<id>` in the app window, with the connection's origin shown prominently.
  - The app never installs anything itself, and never installs without the confirm page's button.
  - `.mcpb`/`.dxt` are not claimed as associations: they belong to their own ecosystem. They work through *Open with* and drag-and-drop.
- **Deep link `plur1bus://install?id=<publisher>/<name>[&version=<semver>]`** joins the DS7/§6.9 deep-link allow-list. It resolves the id **in the signed catalogue only** and opens the same confirm page.
  - **URLs are never accepted** as a deep-link source, so a web page cannot drive a download of arbitrary bytes into a confirm dialog (§13 Q10).
  - Unknown parameters are ignored and logged without values.
  - With several connections, the person picks the target harness first.
- **Allow-list.** The app's IPC allow-list gains no command that takes a path or URL from the page: upload runs from a native file dialog or the OS open-file event in Rust, as bind mounts already do (desktop spec §6.9).

### 10.5 Microsoft Store build (MSIX, DS32)

The extension feature is **identical** in the Store build:

- **Allowed.** Store policy §10.1.5 explicitly allows add-ons and extensions acquired with user consent after the initial download. Every install passes the §8.3 dialog.
- **Described.** §10.2.2 is met because the Store listing and in-app text describe skills and plugins as a core feature, and nothing is installed without the person's action.
- **Not in the package.** The MSIX package never receives or executes extension code; the harness container does (D77). The package contents stay exactly what was certified.
- **Fallback.** If certification objects anyway, a Store-only build setting `extensions.thirdParty: false` (catalogue `first-party` only, no unsigned file installs) is the prepared fallback (§13 Q13).

### 10.6 Flatpak (DS34)

- **Desktop file.** It declares `MimeType=application/vnd.plur1bus.extension+zip;x-scheme-handler/plur1bus;`, and the manifest ships the shared-mime-info XML.
- **File access.** A file opened from the file manager arrives through the document portal, so no new `--filesystem` hole is needed.
- **Handoff.** The app streams the file to the harness API as in §10.4. No extension file is ever stored or run in the Flatpak sandbox, and no permission is added for this feature.

## 11. Publishing side (X5)

### 11.1 Repository layout (`Cyb3rb1ade/plur1bus-extensions`, public, MIT unless a package says otherwise)

```
packages/<name>/
  p1x.template.json        manifest without files/scripts/created (filled by `ext pack`)
  payload/…                the item (skill folder, module build output, MCPB tree)
  src/…                    sources for built payloads (modules, MCP servers); payload built from here in CI
  tests/…                  kind-specific tests (skill: skills-ref + example prompts; module: conformance kit; MCP: MCP SDK smoke)
  CHANGELOG.md, README.md, NOTES.de.md, NOTES.en.md
catalog/
  catalog.config.json      which packages/versions are listed, revocations, key set
  third-party/<id>.json    reviewed third-party entries: upstream URL, pinned sha256, review record
site/                      generated: v1/index.json + index.json.minisig (published to GitHub Pages, CNAME extensions.plur1bus.app)
.github/workflows/         lint.yml, release.yml, catalog.yml, resign.yml
REVIEW.md                  the checklist of §11.3
```

The first-party channel modules stay in their own repositories (D60). Their release workflow produces a `.p1x` with the same `ext pack` and hands it to `catalog.yml` by a signed-off PR in this repository.

### 11.2 CI

- **`lint.yml` (every PR).**
  - `plur1bus ext lint` on every changed package: schema, naming, `files` completeness, derived script set.
  - Kind tests: `skills-ref validate`, module conformance (ADR-016 kit), MCPB `manifest.json` validation plus an MCP `initialize`/`tools/list` smoke.
  - Licence check (SPDX, `LICENSE`/`NOTICE` present), `npm audit`/`pip-audit` on vendored lockfiles, and a hidden-text scan of Markdown (Unicode tag characters, zero-width, bidi controls).
  - Size caps.
- **`release.yml` (tag `<name>-v<semver>`).**
  - Build the payload from `src/` at the tag (reproducible: pinned toolchains, `SOURCE_DATE_EPOCH`), then `ext pack`.
  - Sign `p1x.json` with `ext-primary` in the Environment `extensions-release`; the owner approves each run as required reviewer.
  - Create the GitHub Release with `<name>-<version>.p1x` and `.sha256`, then open a PR on `catalog/` adding the version.
- **`catalog.yml` (merge to `main` touching `catalog/`).** Generate `site/v1/index.json` (serial + 1, `expires` = now + 45 days), sign it (same Environment and reviewer), and deploy to Pages.
- **`resign.yml` (monthly schedule).** Re-sign the unchanged index with a fresh `expires`, after owner approval, so the index never goes stale while nothing changes (§13 Q11).
- **Revocation** is a `catalog/` change like any other and goes out through `catalog.yml` immediately.

### 11.3 Review checklist (`REVIEW.md`; required for every first-party and every third-party listing)

1. **Licence.** Redistributable; SPDX in the manifest matches `LICENSE`; upstream `NOTICE` kept; no licence-less gist (D56/D57 rule).
2. **Provenance.** The source repository and commit are recorded. Third-party: the upstream release asset's sha256 is pinned, and our re-signed package is byte-identical in payload.
3. **Capabilities match the code.** Checked by grepping network, filesystem, child-process, `eval`/dynamic import and native binaries against the declared `capabilities` and `scripts`.
4. **No obfuscation.** Minified or bundled code only with the source in the repository and a reproducible build.
5. **No install hooks.** No self-update, no download-and-execute at runtime outside the declared runtime resolution (§3), no telemetry.
6. **Secrets** only through declared slots; no hard-coded keys; nothing that logs secrets.
7. **Skill text** reviewed for hidden instructions, instruction-override phrasing and exfiltration prompts; the description is truthful (D69 uses it as a trigger).
8. **Tools.** Each has the right `effect`; destructive ones cannot be made auto-approve by the package.
9. **Tests.** Pass on the platforms listed in `compat.platforms`, and in container mode if `compat.container`.
10. **Metadata.** Name not impersonating (no `plur1bus-*` names for third parties, no vendor names they do not own); de/en notes present and within length.
11. **Record.** The review is written into `catalog/third-party/<id>.json` or the release PR: reviewer, date, commit, findings.

### 11.4 The owner's first packages (recommended, §13 Q12)

1. **A skill without scripts**, e.g. `zabbix-triage` (the canvas shows it among the owner's own skills). It proves the skill path, catalogue and updates with the smallest risk.
2. **`channel-telegram`** as a `channel` `.p1x`. It proves module packaging, `modules.<name>.enabled` hot switching and the C6 add-on update without harness downtime.
3. **One local MCP server**, e.g. MarkItDown's official MCP server (D58, MIT) wrapped as an MCPB tree. It proves the `uv` runtime path and tool-effect defaults.

## 12. Milestones (track X) and acceptance

| M | Content | Depends on | Effort (ad) | In the v0.1.0 total |
|---|---|---|---|---|
| **X1** — directly after 2a-H3b-b, before 2b | `crates/plur1bus-ext` (strict ZIP, verifier, minisign trust store with the two pinned keys, script derivation); `p1x` and `state.json` schemas; `ext.*` RPC (all verbs except catalogue/search/update-from-catalogue) + `ext.changed`; CLI `skill`/`plugin`/`ext` (§10.1) with offline mode; skill kind incl. folder/`.zip`/`.skill` and the `feat/import-detect` index contract; module and channel kinds wrapping D14 install; enable/disable hot, uninstall/purge/restore, trash; `ext pack|verify|lint`; `1staid` checks `extensions.integrity|consistency|revoked`; fuzzing of the ZIP parser; docs (`docs/extensions.md`, module-guide addendum) | 2a-H3b-b (setup copies bundled skills; supervisor install serialisation exists since 2a-H3b-a) | **7–10** | yes |
| **X2** — with 2b | `mcp-server` kind: local (MCPB tree, `.mcpb`/`.dxt` via `plugin install`, D46 folded in), remote (URL + D67 auth); tool-effect defaults; `bundle` kind + Claude Code plugin import; per-agent MCP enable lists | X1; 2b MCP client (D38) | **3–5** | yes |
| **X3** — with M3 (+ D1 hook) | Web UI per §10.3 (replaces M6's "skills + plugins UI 4–6" line, which moves here), the upload endpoint, confirm route, WebMCP deny list; D1 `.p1x` association and `plur1bus://install` (1 ad, done in track D's D1/D2 window) | X1, X2; M3 | **5–7** (4–6 moved from M6, +1 new) | yes |
| **X4** — after M3; target v0.2 unless pulled forward (§13 Q13 (a)) | Catalogue client (§7.2.1): fetch, verify, serial/expires, host allow-list, egress, mirror; search; install from catalogue; per-item updates (§9) with health gate, snapshot and rollback; pin/skip/auto-patch; revocation; harness-update pre-flight of extensions (§9.4); key rotation handling | X1–X3; D78 pre-flight (M8/D1) | **5–8** | no |
| **X5** — any time after X1 freezes the format; before X4 ships | `plur1bus-extensions` repository, the four workflows, `REVIEW.md`, GitHub Pages + DNS for `extensions.plur1bus.app` (owner), first 1–3 packages | X1 (format), owner keys and DNS | **3–5** (+0.5–2 per package) | no |

**Net effect on the v0.1.0 total:** +11–16 ad (X1 7–10, X2 3–5, the new ad in X3; the moved M6 line is not counted twice).

**Acceptance for X1** (each a test):

1. A signed `.p1x` skill installs from a file, shows as installed(disabled), enables for one agent only, and disables again. `skills/index.json` stays readable by the importer's schema.
2. A tampered package fails with the exact reason and leaves `skills/`, `modules/`, `extensions/` byte-identical. The package variants are: a changed payload byte, an extra entry, a `../` entry, a symlink entry, a case-collision pair, a 101:1 bomb, a manifest signed for another id, and bytes appended after the EOCD.
3. An unsigned folder skill needs `--allow-unsigned`; without it a non-interactive run exits 2 with the inspection document listing its scripts.
4. A module `.p1x` installs, `plugin disable` stops it and marks its dependent `needs-unavailable`, `plugin enable` restarts both, and the restart plan is shown before applying.
5. Uninstall keeps `data/ext/<name>/` and the config section; `--purge` removes them after its own confirmation; `restore` within the window brings the item back disabled.
6. Integrity: editing an installed skill file marks it `tampered` at the next check, and `1staid check` reports `fail`.
7. A revoked id+version from a locally supplied revocation list (test seam) is refused at install and disables an installed copy.
8. The fuzz target runs 10 minutes in CI without a crash or an out-of-staging write.

## 13. Owner decisions (with the default the design runs on)

1. **File extension and media type.** Recommended: `.p1x`, `application/vnd.plur1bus.extension+zip`.
2. **Catalogue URL.** Recommended: `https://extensions.plur1bus.app/v1/index.json` (§7.2), not `plur1bus.app/catalog/v1/`.
3. **Catalogue hosting.** Recommended: GitHub Pages of `Cyb3rb1ade/plur1bus-extensions` with the custom domain (free, versioned, same CI). Owner action: DNS `CNAME extensions → cyb3rb1ade.github.io`.
4. **Key custody.** Recommended: `ext-primary` in the GitHub Environment `extensions-release` (owner as required reviewer), `ext-backup` offline in the password manager, both separate from the updater keys. Owner action: generate both with `minisign -G`.
5. **State after a person's install.** Recommended: installed(disabled), with a one-click *Install and enable* in the dialog (consistent with the importer).
6. **Unsigned and unknown-signer file installs.** Recommended: allowed with the explicit acknowledgment of §8.3; `extensions.allowUnsigned` lets an admin forbid them.
7. **Third-party packages in the catalogue.** Recommended for v1: only after review, re-signed by `ext-primary`; publisher keys (v2) when a second regular publisher appears.
8. **Automatic extension patch updates.** Recommended: on for `first-party`, off for every other tier; never for capability-widening updates.
9. **Revoked packages.** Recommended: stopped and locked; re-enable only with `--force-revoked` + typed name, audit-logged.
10. **Deep links.** Recommended: `plur1bus://install` accepts catalogue ids only, never URLs.
11. **Index freshness.** Recommended: `expires` 45 days after signing, with a monthly re-sign approval.
12. **First packages.** Recommended: one script-free skill (e.g. `zabbix-triage`), `channel-telegram`, and one MCP server (MarkItDown MCP). Names and choice are the owner's.
13. **Scope and timing.**
    - (a) Recommended: file install, enable/disable and UI (X1–X3) are in v0.1.0; the web catalogue (X4) ships in v0.2, or earlier if the first packages exist before M8.
    - (b) Store build: recommended same feature set as every other build, with `extensions.thirdParty: false` prepared as the certification fallback.
14. **Uninstall retention.** Recommended: 14 days in the trash, restorable (the canvas's "kept for 14 days").
15. **First-party channels and bundled skills via the catalogue between releases.** Recommended: channels yes (patch and minor within the release's compatible range); bundled third-party skills (D57) no, they stay release-pinned.
16. **Sandbox for untrusted plugins.** Recommended: not in v1 (§8.8 states it). Revisit after v0.1 with a per-plugin sidecar container (D77 makes that cheap) or OS sandboxes (bubblewrap, `sandbox-exec`, AppContainer).
17. **Repository shape for first-party packages.** Recommended: one `plur1bus-extensions` monorepo; channel modules keep their own repositories per D60.

## 14. Risks

| Risk | Mitigation |
|---|---|
| ZIP parser differentials or path tricks lead to an out-of-tree write | Strict parser rules (§5.1, §8.4), extraction only into staging, fuzzing, the D14 byte-identity test extended to every refusal |
| Two sources of truth (`state.json` ↔ `skills/index.json`) drift, especially with the importer writing the index | §6.2 assigns each fact one owner; `1staid check extensions.consistency`; the importer writes through `ext.*` once X1 exists, directly only before |
| Approval fatigue makes the unsigned dialog a click-through | Tier-specific button text, the scripts list up front, an admin policy switch, and an installed(disabled) default so a second deliberate step is needed to run anything |
| Store certification reads extensions as §10.2.2 dynamic code | Listing text, consent flow, extension code outside the package, and the prepared `thirdParty: false` fallback |
| The catalogue key is used rarely and the owner-approval step blocks urgent revocations | Revocation is a small `catalog/` change with the same one-click approval; the backup key can sign an emergency index offline |
| Skills listed in the cached prompt prefix make every toggle a cache miss | `applyAt: next-session` option; D69 keeps injected bodies out of the prefix; only names/descriptions are affected |
| `module.json` `kind` and the manifest `kind` disagree | Install refuses a mismatch (`package-invalid`); the `.p1x` manifest is the authority |
| D-number collision with parallel branches | D79–D85 were free on `main` and every local branch at writing time; the merge re-checks |

## 15. Sources (all read 2026-09-27)

- Microsoft Store Policies, version 7.20 (published 2026-09-15, effective 2026-10-22) — https://learn.microsoft.com/en-us/windows/apps/publish/store-policies (§10.1.5, §10.2.2, §10.2.3, §10.2.5, §10.2.9)
- Flathub requirements — https://docs.flathub.org/docs/for-app-authors/requirements
- Agent Skills specification — https://agentskills.io/specification
- Anthropic `skill-creator` packaging (`.skill` ZIP) — https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/package_skill.py
- MCP Bundles CLI (sign/verify) — https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md ; issue #278 — https://github.com/modelcontextprotocol/mcpb/issues/278
- MCP Registry package types — https://modelcontextprotocol.io/registry/package-types
- Claude Code plugin marketplaces — https://code.claude.com/docs/en/plugin-marketplaces ; plugin manifest reference — https://code.claude.com/docs/en/plugins/manifest-reference
- minisign — https://jedisct1.github.io/minisign/ ; `minisign-verify` crate — https://crates.io/crates/minisign-verify

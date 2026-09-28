# Module guide

How a PLUR1BUS module is written, packaged, installed, configured and run. This is a hand-written
companion to the generated `docs/rpc.md` (the `module.*` RPC surface) and `docs/config.md` (the
`modules.<name>` configuration namespace) — re-read it whenever the manifest schema, the module
runtime (`@plur1bus/module-api`), or the supervisor's module handling change underneath it, since
`docs:check` does not cover this file. It records spec §5 and owner decision D14 as built by plan
2a-H3b-a, plus §12's installer paths (⟂EXT) built by plan 2a-H3b-b; the architectural background (why
modules are separate processes at all) is ADR-012 §1 (§10.13 for the installer), and the
config-ownership and restart-class rules a module's configuration follows are ADR-013.

## 1. What a module is

A module is a separate OS process, spawned or adopted by the supervisor exactly like the core is
(ADR-012 §10.12), that is a client of the core (and optionally of other modules) over
`@plur1bus/module-api`. It ships:

- a **manifest**, `module.json`, at the root of its installed directory (§2 below);
- an **entry script** the manifest names, built to run under `node <entry>` with no bundler-specific
  assumptions beyond what `@plur1bus/module-api`'s `runModule` provides;
- its own `README.md`, following the "Module README convention" in the top-level `AGENTS.md` —
  `packages/module-fixture/README.md` is the reference example, being the one module this repository
  ships (for tests only; it is never published).

Everything else — starting, stopping, backing off after a crash, being adopted after a supervisor
restart, reporting its status, being reconfigured live — is `runModule`'s job (§4), not something a
module author writes by hand.

## 2. The manifest (`module.json`)

One JSON Schema is the source of truth for both languages:
`packages/module-api/schema/manifest.schema.json` (draft 2020-12, closed —
`additionalProperties: false`, `x-stability: "experimental"`). TypeScript validates with it directly
(`@plur1bus/module-api`'s `validateManifest`); Rust embeds the same file with `include_str!`
(`crates/plur1bus/src/modules/manifest.rs`) and validates with the `jsonschema` crate, so the two
languages can never drift on what a manifest may contain (ruling H3B-R11).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string, `^[a-z][a-z0-9-]{0,62}$` | yes | The module's name; **must equal its directory name** under `modules/`. Reserved names below are rejected. |
| `version` | string, semver 2.0.0 | yes | The module's own release version — independent of `apiVersion`. |
| `apiVersion` | string, `^[1-9][0-9]*$` | yes | The module API major this module is written against, as a decimal string with no leading zeros (e.g. `"1"`, never `"01"` or the JSON number `1`). See §7. |
| `entry` | string, `/`-separated, ≤ 255 chars | yes | The entry script, relative to the module's own directory (§2.1). |
| `needs` | string[], unique, `^[a-z][a-z0-9.-]{0,63}$` | no (default `[]`) | Modules (or `"core"`) that must be running before this one starts. |
| `provides` | string[], same pattern | no (default `[]`) | Capability names this module offers to others (graph-only today; nothing dispatches through them — see extension points below). |
| `consumes` | string[], same pattern | no (default `[]`) | Capabilities this module uses — from the core (e.g. `"memory"`) or from another module's `provides`. |
| `implements` | string[], same pattern | no (default `[]`) | Interfaces this module implements. |
| `extensionPoints` | object, keys matching the capability pattern, values `"chain"` or `"collect"` | no (default `{}`) | Extension points this module offers. **Validated and graphed, never dispatched, in 2a** (ruling B11) — declaring one documents an intent for a future plan to wire up, not a call the supervisor or the core will make today. |
| `scope` | `"installation"` \| `"agent"` | yes | `installation`: one instance for the whole install. `agent`: one instance per agent — **not started in 2a** (ruling B10); a module with `scope: "agent"` is listed and reported `stopped` with reason `scope-agent-unsupported`, never spawned. |
| `restart` | `"on-failure"` \| `"always"` \| `"never"` | no (default `"on-failure"`) | The restart policy applied to this module's own exits (§6). |
| `lifeline` | boolean | no (default `true`) | Whether the module is started with `--lifeline stdin` and exits when that pipe closes and its grace expires (§5). `false` omits the flag entirely — the module runs with no lifeline at all, and only `module.shutdown`/a signal stops it. |
| `priority` | integer, 0–999 | yes | Start order and priority band (§2.2). |
| `configSchema` | object (a JSON Schema) | no | Schema for this module's own `modules.<name>` configuration section (§6 of ADR-013, §8 below). |

### 2.1 Reserved names and the entry-path rule

`name` may not be `"core"` or `"supervisor"` (the two names the harness itself reserves), nor any of
the Windows reserved device names — case-insensitively, and this schema check runs on every
platform, not only Windows, so a manifest that would break on a Windows install is rejected
everywhere: `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` (`com10` and above are fine —
Windows itself only reserves `com1`–`com9`/`lpt1`–`lpt9`). This list lives in one place, the
manifest schema's `not.enum`, and `crates/plur1bus/src/modules/manifest.rs`'s `RESERVED_NAMES`
constant is tested to match it exactly (`reserved_names_match_the_schema`) so the two can never
silently diverge.

`entry` is a `/`-separated sequence of segments, none of which may start with a dot — this single,
lookaround-free pattern (chosen so ajv and the Rust `regex` crate agree byte-for-byte, ruling
H3B-R11) is what rules out, all at once: an absolute path (`/abs.js`), a Windows drive letter
(`C:/x.js`), a backslash, an empty segment, and any `.`/`..` segment (`../x.js`, `dist/../../x.js`,
`./x.js`). A manifest cannot express an entry that leaves its own module directory. `module install`
re-checks this on the *staged* copy of the manifest (not only the schema pattern) and additionally
confirms the entry file actually exists in the staged tree before committing (§9).

### 2.2 Priority bands (D14)

`priority` is an integer 0–999, banded 100-wide:

| Band | Range | Purpose |
|---|---|---|
| Foundation | 0–99 | Lowest-level services other modules build on. |
| Core services | 100–199 | Services close to the core's own responsibilities. |
| Services | 200–299 | General-purpose services. |
| Aggregators | 300–399 | Modules that combine other modules' capabilities. |
| Orchestration | 400–499 | Coordination across several modules. |
| Add-ons | 500–999 | Everything else — the default band for a first module (the fixture uses `500`). |

`module graph`'s human output renders modules grouped by band, in start order within each band; `module.graph`'s JSON result carries `band` on every valid node (`null` for the core node and for an invalid module, since neither has a meaningful position in the tree).

## 3. The dependency graph and start order

`module.graph` (`module graph` on the CLI) reports, for the whole installation:

- **Nodes**: the core (always first, `version: null`, `priority: null`, `band: null`,
  `scope: "installation"`, `extensionPoints: {}`, `valid: true`), then one node per module found
  under `modules/` — `valid: false` with every field `null` for a module whose manifest failed to
  parse or validate.
- **Edges**: `needs` (must start before) and `consumes` (uses a capability from). A `needs` entry
  resolves to `"core"` or to another valid module; a `consumes` entry resolves to `"core"` when the
  capability is one the core itself provides (`memory`, `agent`, `jobs`, `events`), or to every valid
  module that `provides` it.
- **Unresolved entries**: a `needs`/`consumes` naming something that does not resolve — a missing
  module, or a capability nothing provides — is listed as `{ from, kind: "needs"|"consumes", name |
  capability }`, never silently dropped.
- **Cycles**: the strongly connected components of the `needs` graph among valid modules (a
  self-need counts as a one-member cycle), each reported with its members sorted.

**`start_order`** is computed from this graph: it starts from the valid modules, drops every module
in a cycle, then repeatedly drops any module whose `needs` names something neither `"core"` nor
still in the remaining set (so a dependent of an excluded module is excluded too, however many links
away), and finally runs a stable topological sort (Kahn's algorithm, ready set ordered by
`(priority, name)`) over what's left. A module left out of `start_order` for any of these reasons —
an invalid manifest, a cycle, an unresolved `needs` chain — is never spawned on its own; it is shown
`crashed` with reason `manifest-invalid`, with the reason logged to `logs/supervisor.log` as
`"module not started"` alongside the specific error, and it stays that way until the underlying
problem (a bad manifest, a missing dependency) is fixed and the module is reinstalled or the
supervisor restarted.

Two further reasons keep an otherwise-valid, in-order module from actually starting, both distinct
from being excluded from `start_order` and both re-evaluated on every reconcile (a config change, an
install, an explicit `start`/`stop`):

- **`disabled`**: `modules.<name>.enabled == false` (§8). Shown `stopped`, reason `disabled`.
- **`scope-agent-unsupported`**: `scope: "agent"` (§2, ruling B10). Shown `stopped`, reason
  `scope-agent-unsupported`.
- **`api-version-unsupported`**: the manifest's `apiVersion` is outside the window the supervisor
  currently supports (§7). Shown `crashed`, reason `api-version-unsupported`.
- **`needs-unavailable`**: a module whose `needs` names a module that is itself disabled,
  agent-scoped, unsupported, manifest-invalid, or held back for the same reason (propagated
  transitively in one pass over the already-topological `start_order`, rulings H3B-R25-4/H3B-R28).
  Shown `stopped`, reason `needs-unavailable`, with an `errors` entry naming the chain. **Also
  applies when the need was stopped by a person** (`module stop <name>`, ruling H3B-R28): a
  dependent of a module stopped by request becomes `needs-unavailable` until that module is started
  again, even though nothing about its manifest or configuration changed.

## 4. `runModule` and `ModuleContext`

`@plur1bus/module-api`'s `runModule(def, argv?)` is the whole entry point a module author writes
against — everything from the manifest read through the stop sequence below is its job, not the
module's. A module's `src/index.ts` (or equivalent) looks like:

```ts
import { runModule } from "@plur1bus/module-api";

await runModule({
  start(ctx) {
    // ctx.config() — the modules.<name> section, {} when absent
    // ctx.core() — a client of the core, if `needs` includes "core"
    // ctx.logger — a logger writing logs/module-<name>.log
    // ctx.onConfig(fn) — fires only when modules.<name> actually changes
    // ctx.signal — aborted when the module begins stopping
    return {
      async stop({ budgetMs }) {
        // clean up within budgetMs; a throw here still exits 1 (see below)
      },
    };
  },
});
```

`runModule` accepts `--home --module [--lifeline stdin] [--instance <uuid>]` on `argv` (a bad flag
exits 2). Its start sequence:

1. Read `modules/<name>/module.json` and validate it; the manifest's `name` must equal `--module`.
   Any failure exits 2. **The runtime never checks its own `apiVersion` against what the supervisor
   supports** — that check is the supervisor's alone (§7), so a module written against an older
   `apiVersion` still runs unmodified when the supervisor probes or spawns it, and can be told apart
   from a genuinely broken manifest.
2. Take `run/module-<name>.lock` (an exclusive lock, the same kind the core takes on
   `state/core.lock`). Held by another instance → exit 3 (retryable — the supervisor backs off and
   tries again, the same as a core that finds `E_LOCKED`). Any other failure to open the lock file
   (a bad path, a permissions problem) → exit 1 (not retryable the same way — a broken lock file
   does not fix itself on a retry).
3. **Configuration** (§8): with `--lifeline stdin`, watch the supervisor's `config.watch` (falling
   back to reading `config.json` directly, and re-watching with backoff, if no supervisor answers or
   the watch is lost); without a lifeline, read `config.json` once. `ctx.config()` is always the
   `modules.<name>` section (or `{}`); `ctx.onConfig` fires only when that section's *value* actually
   changes. `logs.maxBytes`/`logs.keep` and `supervisor.graceMs` apply live, exactly as they do for
   the core (ADR-013 §6).
4. Open the log (`logs/module-<name>.log`, JSON lines, rotated by `logs.*`); secure the run
   directory (`securePath(0700)`, the Windows ACL equivalent on that platform).
5. Call `def.start(ctx)`. A throw here logs it, releases what the module holds, and exits 1.
6. Write `run/module-<name>.token` (32 random bytes, hex) and `run/module-<name>.pid`
   (`<pid> <instanceId>`), both mode 0600 plus `securePath`.
7. Listen on the module's own control address (§5). A listen failure runs the normal stop and exits
   1.
8. If `--lifeline stdin` was given, watch stdin through the orphan watch (§5).

If `ctx.core()` is used (the manifest's `needs` includes `"core"`), the runtime keeps a reconnecting
client of the core in the background — reading `run/core.token` fresh on every reconnect attempt,
backing off 250 ms doubling to 5 s, reset on success. `module.status.core` reports `"connected"` or
`"reconnecting"` accordingly, or `"not-needed"` for a module that never asked for a core connection.

## 5. The module lifecycle: lock, run files, control endpoint, lifeline, grace, adoption

A module's control endpoint is `run/module-<name>.sock` (POSIX) or the
`\\.\pipe\plur1bus-<hash16>-module-<name>` named pipe (Windows) — the same address-derivation rule
the core's own `run/core.sock`/pipe uses, just keyed on the module's name as well as the home
(`@plur1bus/module-api`'s `paths.ts` `moduleAddress`, mirrored by the Rust supervisor's
`Layout::endpoints`). A fresh `run/module-<name>.token` (32 random hex bytes) authenticates it,
exactly like the core's token authenticates `run/core.sock`.

**Lifeline.** With `--lifeline stdin` (the default the supervisor always passes, unless the
manifest sets `lifeline: false`, ruling H3B-R25-3), the module's lifeline is its stdin pipe, held
open by the supervisor's `Monitor` — the same mechanism that holds the core's stdin lifeline open
(ADR-012 §10.1). Losing it (EOF, or the pipe erroring) orphans the module: its `process.state`
becomes `"orphaned"`, it keeps running, and a `supervisor.graceMs` timer starts. If the grace expires
with no adoption, the module stops itself and exits 0. If a `module.adopt` call authenticates first
(the same nonce check `core.adopt` uses, against `run/supervisor.token`), that connection becomes
the new lifeline and the grace timer is cancelled — closing the connection orphans the module again,
grace restarting from zero.

**Adoption** on the supervisor side works identically to the core's (ADR-012 §10.2): a fresh
supervisor probes for an already-running module at the module's control address before deciding to
spawn a new one. `module.auth`'s result carries `{ module: { name, version, apiVersion } }`; if it
mismatches the on-disk manifest (**B12, the identity check**), the found process is `Foreign` and
terminated through its own pinned peer (`module.shutdown`, then a signal) rather than adopted — this
is exactly how a stale process from an uninstalled or replaced module version is cleaned up rather
than silently kept running and mistaken for the new one. The same identity check runs on the spawn
path too: a freshly spawned module whose hello mismatches its own manifest is killed and counted as
a `manifest-invalid` crash (a build or packaging bug, not a transient failure worth retrying without
intervention).

**Stop** (`module.shutdown`, SIGTERM, SIGINT, or grace expiry — one code path for all four):

1. State becomes `"stopping"`; the orphan watch is disposed; `ctx.signal` is aborted.
2. `handle.stop({ budgetMs })` (the module's own return value from `def.start`) runs, raced against
   what remains of the budget (default 10 s if `module.shutdown` gave none). A synchronous throw
   counts as a failure.
3. The core link, the config watch and the control server all close, racing the remaining time
   together (a peer that never reads is not allowed to hold the whole grace, unlike the supervisor's
   own standing write-deadline limit, ADR-012 §10.12).
4. The token and pid files are removed, the lock is released.
5. The log is closed and the process exits 0 — or 1 if the module's own `stop` threw or the listen
   step (step 7 above) had failed.

**`module stop`** (the supervisor operation, not the RPC-level `module.shutdown` a running module
answers) additionally records the module as `stopped`, reason `stopped-by-request` — it stays that
way, never auto-restarted, until `module start`, `module restart`, or a supervisor restart brings it
back (ruling B13); its dependents see `needs-unavailable` for as long as it stays stopped (§3).

## 6. Restart policy and crash reasons

A module's `restart` field (§2) decides what happens to a *clean, unrequested* exit:

| `restart` | Exit 0 (unrequested) | A retryable non-zero exit |
|---|---|---|
| `on-failure` (default) | `stopped`, no reason, never restarted | Restarted with backoff, same as the core |
| `always` | Restarted with backoff | Restarted with backoff |
| `never` | `stopped`, no reason, never restarted | `crashed`, no reason, never restarted |

A restart the *supervisor itself* requested (a config-driven restart, `module restart`, a
reinstall) never counts toward the five-exits-in-ten-minutes give-up rule, exactly like the core's
own restart-requested exits (ADR-012 §10.3/§10.12). When a module does give up after repeated
unrequested crashes, `process.reason` is `"gave-up"` (`CrashReason::GaveUp`, ruling H3B-R26) — a
give-up is now visibly distinguished from an ordinary single crash in `module list`, `daemon
status` and `1staid check`, on both the core's slot and a module's.

**Exit-code classification differs from the core's in exactly one place** (ruling H3B-R13/P13): a
module's exit code 2 is `manifest-invalid`, never `config-invalid` — the core's own exit 2 keeps its
long-standing "invalid `config.json`" meaning, and a module has no `config.json` of its own to be
invalid, so exit 2 was free to mean "this module's manifest, or its identity check, failed" instead.
Exit 3 and everything else follow the same rules the core's own exit classification already uses
(ADR-012 §10.3).

## 7. The API-version policy (B12, ADR-016 G3)

`apiVersion` in the manifest names the module API major a module is written against, as a decimal
string. The supervisor supports the *current* module API major and the one immediately before it,
side by side — `current_api_version()` is `MODULE_API_VERSION` from `@plur1bus/module-api`/`crates/
plur1bus/src/modules/manifest.rs` (kept in step by a shared constant, checked by a fixture test in
both languages), overridable only for tests via `PLUR1BUS_MODULE_API_CURRENT` (requires
`PLUR1BUS_ALLOW_TEST_INTERNALS=1`). A manifest whose `apiVersion` is outside that two-value window
is never spawned: it is shown `crashed`, reason `api-version-unsupported`, and the check re-runs on
every respawn (not only once at supervisor start), so an in-place edit to a running module's
manifest, or a reinstall that changes its declared `apiVersion`, is caught the next time that module
is spawned or probed.

## 8. Configuration: `modules.<name>` (ADR-013 §2, §8; ruling B13)

Every installed module gets an entry under the config schema's `modules` namespace:
`modules.<name>` is an open object, default `{}`, whose declared `enabled` (boolean, default `true`)
and every other declared key resolve to restart class `module:<name>` — a change under a module's
own section restarts *that module only*, never the core (criterion 4). Two things constrain what may
actually go into a module's section:

- **The harness's own config schema** governs the shape of `modules` as a namespace (§2 of
  ADR-013) — the `enabled` key, and the fact that `additionalProperties` under a module's entry is
  open (a module may declare whatever configuration keys it needs).
- **The module's own `configSchema`** (its manifest) is checked in addition, whenever a section that
  changed is being applied (`config set`, or a hand edit the watcher picks up) — `enabled` is
  stripped before this check runs (so flipping only `enabled` never re-validates the rest of a
  section against a schema that might otherwise reject it), and a section that did *not* change is
  never re-checked, so installing or reconfiguring one module can never retroactively invalidate an
  unrelated `config.set` of another module's section.

**`enabled: false`** is what `module` stop/start looks like as *configuration* rather than a
one-off operation: setting it stops the module (reason `disabled`, §3) and holds its dependents
`needs-unavailable`; setting it back to `true` (or removing the key) starts the module again, along
with any dependent that was only held back by it. Both directions work whether the change arrives
through `config set` or a hand edit of `config.json`.

## 9. The `module` commands

All six are `x-server: "supervisor"` RPC methods with a CLI leaf of the same name
(`crates/plur1bus/src/commands/module.rs`); every leaf's `--help` starts with `[experimental] `, and
`--json` output carries `"schema": "module.<verb>/1"`. Every verb runs **offline** (no supervisor
answering) as well as against a running one, except `start`/`stop`/`restart`, which need a
supervisor to have anything to act on:

| Command | Offline | Through a supervisor |
|---|---|---|
| `module list` | Reads `modules/` and the config directly (the defaults when `config.json` is missing, which it never creates); `child` is always `null` | Adds live `child` status (pid, process state, `detail` — the module's last polled `module.status.detail`) |
| `module graph` | Computed from the manifests on disk | Same computation, same result |
| `module install <path>` | Stages and commits directly on disk | Routed to the supervisor, which serialises installs one at a time |
| `module uninstall <name>` | Removes the directory directly | Routed; stops the module first if it is running |
| `module start\|stop\|restart <name>` | `E_NOT_AVAILABLE reason=supervisor-not-running`, exit 1 | The only way these three verbs work |

**Install refusals** (`InstallError`, `crates/plur1bus/src/modules/install.rs`) — every one of these
is checked *before* anything is copied, so a refused install always leaves `modules/` byte-for-byte
unchanged:

- **`NotADirectory`**: the source does not exist, or is not a directory.
- **`Symlink(path)`**: the source itself, or anything inside its tree, is a symlink.
- **`SpecialFile(path)`**: the source tree contains something that is neither a regular file, a
  directory, nor (already excluded above) a symlink — a FIFO, a device node, a Windows junction.
- **`Reserved`**: the manifest's raw `name` is `"core"`, `"supervisor"`, or one of the Windows
  reserved device names (§2.1) — checked before schema validation, so the *reason* reported is
  specific even though the schema would refuse it too.
- **`EntryOutside`**: the manifest's raw `entry` is absolute, uses a drive letter, a backslash, or a
  `..` segment — likewise checked ahead of the schema for a specific reason.
- **`Manifest(errors)`**: the manifest fails schema validation, its `configSchema` does not compile as
  a JSON Schema (for example `{"type": 5}`; refused here rather than breaking every later
  `config set modules.<name>.*`), or its `entry` file does not exist in the staged copy.
- **`SocketPathTooLong`**: `run/module-<name>.sock` under this home would not fit a Unix socket
  address (`sun_path` is 104 bytes on macOS and the BSDs and 108 on Linux, the terminating NUL
  included). The module would install and then crash-loop, unable to listen, so a shorter name (or
  home) is required. Not checked on Windows, where modules listen on named pipes.

A refusal maps to `E_INVALID_PARAMS` with a `reason` naming the case above (`not-a-directory`,
`symlink`, `not-a-regular-file`, `reserved-name`, `entry-outside`, `manifest-invalid`,
`socket-path-too-long`); an I/O
failure (a permissions problem, a full disk) maps to `E_INTERNAL` instead, since it says nothing
about the module being installed.

**Trust: an installed module runs with the owner's full harness authority.** A module is a process
of the same OS user as the supervisor and the core. It reads `run/supervisor.token` (the module API's
`config.watch` connects with it) and can read `run/core.token`, so it can call anything the owner
can: `config.set`, `module.install`, `daemon.stop`, `admin.*`, every `memory.*` method. There is no
sandbox, signature or catalog in 2a. The install refusals above are **path hygiene** (no symlink,
special file, escaping entry or reserved name ends up under `modules/`), not a security boundary:
install only modules whose code you would run yourself.

**Install and uninstall are staged, not in-place**, so a failure midway never leaves a half-written
module: a new install copies into `modules/<name>.tmp-<pid>` and only renames it into place once
every check has passed; a reinstall first moves the existing directory aside to
`modules/<name>.tmp-<pid>-old` before the rename, restoring it if the rename fails (on Windows each rename is retried for about 2 s while it fails
with a transient access-denied or sharing violation, as Defender or the indexer can briefly hold a
handle on a freshly copied tree); uninstall renames
to `modules/<name>.tmp-<pid>-rm` before removing it. A crash between these steps leaves a
`.tmp-<pid>[-old|-rm]` directory that the supervisor recovers automatically at its next start (an
`-old` whose target directory is missing is renamed back; everything else stale is removed) and
before every subsequent `stage` call.

**Offline install/uninstall hold `run/supervisor.lock`** for the whole staged mutation — the same
exclusive lock file the supervisor itself takes before probing its own address at start (ADR-012
§10.5/§10.12) — so an offline module change and a starting-or-stopping supervisor can never race
each other over the same module directory: whichever loses the lock is refused (the CLI with
`E_NOT_AVAILABLE reason=supervisor-running`, exit 1) rather than corrupting the module tree. A
supervisor that finds the lock held probes its address for up to 3 s: if another supervisor answers,
it exits 3 (the "already running" refusal, mapped to 0 under launchd); if nobody answers, it tries
the lock once more and continues as the supervisor when it wins, and otherwise exits 1 — a
transient failure that launchd's `KeepAlive{SuccessfulExit:false}` retries, so a supervisor started
while an offline install held the lock is restarted instead of staying down.

## 10. `dist/package.json`: `{"type":"module"}` (ruling H3B-R23)

A module's build must emit `dist/package.json` containing exactly `{"type":"module"}` alongside its
built entry, so Node treats the installed `.js` file as an ES module regardless of what package.json
(if any) happens to sit above the module's installed directory in the filesystem — without it, a
home whose ancestor `package.json` says `"type":"commonjs"` would make the module's entry fail to
load with no obvious cause. `packages/module-fixture/build.mjs` is the reference implementation
(`pnpm --filter @plur1bus/module-fixture build` writes `dist/{index.js,module.json,README.md,
package.json}`); `module install`/the supervisor's own install path copy the whole built tree
verbatim, so this file travels with the module through install, reinstall and uninstall without any
module-specific code in the installer needing to know about it.

## 11. Running a module in isolation

Every module's own `README.md` documents this for that specific module (§1); the shape is always the
same, using the fixture as the concrete example:

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/module-fixture build     # writes dist/{index.js,module.json,README.md,package.json}
mkdir -p /tmp/p1b/modules/fixture
cp packages/module-fixture/dist/* /tmp/p1b/modules/fixture/
node /tmp/p1b/modules/fixture/index.js --home /tmp/p1b --module fixture
```

Without `--lifeline stdin`, the module reads `config.json` once and runs until SIGTERM or
`module.shutdown` — no supervisor, no lock contention with one, and no lifeline to lose. With
`--lifeline stdin`, it behaves exactly as it would under a real supervisor: it follows
`config.json`/a live `config.watch` if one answers, and stops on its own once stdin closes and
`supervisor.graceMs` passes with no adoption. `pnpm --filter <module-package> test` runs a module's
own tests against a freshly built `dist/`.

## 12. Install paths (2a-H3b-b) and the extensions-ecosystem seams (⟂EXT)

`plur1bus setup` and `1staid repair` (`crates/plur1bus/src/install/`, `docs/adr/ADR-012-process-model-and-languages.md`
§10.13) are how a module (or a skill) first gets onto disk in a real installation, as opposed to the
manual `cp`/`module install` path §11 covers for development. The `docs/extensions-ecosystem` spec
(not yet written) will add skill and plugin enable/disable/install on top of this; this plan fixed
five points so that spec extends this installer instead of building a second one. All five are
verified against the code on this branch, not merely asserted by the plan:

1. **One verified extractor.** Every package that arrives from outside the binary — the Node
   runtime archive, a core payload, a module package, a skill bundle — goes through
   `install::archive::verify_and_extract(archive, sha256, into, strip)` (`crates/plur1bus/src/install/archive.rs`):
   one SHA-256 check, one `.tar.gz` (`flate2` + `tar`) or `.zip` (`zip`) extractor, shared by every
   caller. A future ecosystem spec's plugin install must reuse this function rather than add a second
   download client or archive reader.
2. **The refusal vocabulary is stable, and additive only.** A module install already refuses with one
   of seven fixed reasons (`modules::install::InstallError::reason()`, §9 above): `not-a-directory`,
   `manifest-invalid`, `symlink`, `special-file`, `entry-outside`, `reserved-name`,
   `socket-path-too-long`. This plan's own installer adds four more, from `install::archive`/`fetch`:
   `digest-mismatch` (a downloaded or bundled package's hash does not match), `archive-unsafe-entry`
   and `archive-unsupported` (`ArchiveError::UnsafeEntry`/`Unsupported`, `install/archive.rs`), and
   `download-too-large` (`FetchError::TooLarge`/`ArchiveError::TooLarge`, `install/fetch.rs`,
   `install/archive.rs`). A later plugin install reports one of these eleven reasons, or a new one
   added the same additive way (ADR-016 §2) — none is ever renamed.
3. **One commit path for modules.** `setup`'s `modules.bundled` step and `1staid repair`'s runtime
   reinstall steps both install through the same `modules::install::{stage, commit}` §9 already
   describes: staging into `modules/<name>.tmp-<pid>`, the `run/supervisor.lock` rule for an offline
   install, supervisor-first when one answers. A plugin that turns out to be a module uses this exact
   path, not a parallel one.
4. **The install manifest has a slot per unit.** `<home>/manifest.json` (HB9,
   `crates/plur1bus/schema/install-manifest.schema.json`, `InstallManifest` in
   `crates/plur1bus/src/install/manifest.rs`) carries `modules: PackageUnit[]` and
   `skills: PackageUnit[]`, each entry `{ name, version, source, sha256 }` with `source` one of
   `"bundled"`, `"local"` or **`"catalog"`** — reserved for the ecosystem spec and written by nothing
   in this plan (`manifest.rs`'s own doc comment on `PackageUnit`).
5. **Skill layout.** Setup's `skills` step (HB13, `crates/plur1bus/src/install/skills.rs`) copies
   `<payload>/skills/<name>/` to `<home>/skills/<name>/`; a bundled third-party skill additionally
   lives under `skills/third-party/` and is checked against `skills/third-party/CHECKSUMS`
   (`sha256sum` format, paths relative to `third-party/`) before anything is copied — a mismatch,
   missing or unpinned file fails the step with `digest-mismatch` and copies nothing
   (`verify_checksums`). The bundled operations skill this plan ships, `skills/plur1bus-ops/`
   (`SKILL.md` plus `playbooks/{diagnose,configure,repair}.md`), is installed through this same path.
   Enable/disable of an installed skill is the ecosystem spec's job and must not move this directory
   layout.

**What `setup` installs, beyond modules and skills.** `setup` (spec §6.5, HB8–HB13) runs nine fixed
steps in order — `state-root`, `runtime.node`, `runtime.core`, `modules.bundled`, `config`, `skills`,
`service`, `start`, `check` (`STEP_IDS`, `crates/plur1bus/src/install/setup.rs`) — the first failure
stops the run and every later step is `skipped` with reason `after-failure`; a step whose result
already matches the install manifest is `skipped` with reason `already-installed`. The Node runtime
(HB8: version `24.21.0`, installed at `runtime/node-24.21.0/bin/node[.exe]`, `locate_node` preferring
`PLUR1BUS_NODE`, then the manifest, then any `runtime/node-*`, then `PATH`) and the core payload are
both fetched and verified through point 1 above. `config` asks only the `basic`-tier questions
(`agents`, `embedding.useClass`; ADR-013 §2a/§9) and gates the NC licence exactly as ADR-006 records.
`1staid repair`'s `runtime.node.reinstall`/`runtime.core.reinstall` steps (HB16, §7 of the
2a-H3b-b plan) re-run the same fetch-and-verify path when `1staid check`'s `runtime.node`/
`runtime.core` rows fail.

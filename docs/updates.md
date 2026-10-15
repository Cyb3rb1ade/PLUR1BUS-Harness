# Updating the harness

`plur1bus update` replaces the binary (and the core payload when the release changes it) with a signed release: it
verifies, stops the daemon, snapshots, swaps, starts, gates on `--version`, a ready core and `plur1bus 1staid check`,
and restores the snapshot on any failure after the first write. A killed update is settled by the next `update` or
`daemon start`. `update --rollback` goes back to the snapshot of the last update; `update status` says where the last
one stands. Design: `docs/superpowers/plans/2026-10-06-m8-update-snapshot-gate-rollback.md`, ADR-012 §10.13. This page
covers what surrounds that flow. Error reasons: [errors.md](errors.md#update-reasons-plur1bus-update).

```bash
plur1bus update --check                     # what would change; writes nothing
plur1bus update --plan                      # the whole plan in words (see below); writes nothing
plur1bus update --yes                       # apply (the plan is printed first; --yes is required without a terminal)
plur1bus update --from update.tar.zst --yes # apply an offline bundle
plur1bus update --rollback
```

## The plan

`update --plan` (and every normal `update`, before it asks) prints, from the signed release manifest:

- old to new version, channel, a security release and a downgrade marked;
- the notes grouped as **new / changed / fixed / needs attention**, breaking changes each with **what to do**;
- which components restart (the daemon always; the supervisor binary, the core, named modules when they change);
- migrations, each **reversible** (a rollback undoes it), **not reversible** or not stated (a not-reversible one is also
  listed under attention);
- every installed add-on with its verdict, and which would be disabled or re-enabled;
- the download size (the sum of the assets that say `size`, else "not stated"; for a bundle the file sizes), and what a
  rollback restores (binary, `config.json`, install manifest, core) and what it never touches (the memory store).

`--json` prints the same as `update.plan/1`; an applied update (`update.apply/1`) carries it as `plan`.

**Language.** The CLI has no message catalogue, so only the plan is localised: `--lang en|de`, else `LC_ALL`,
`LC_MESSAGES`, `LANG` (the first one set decides; a value starting with `de` is German, anything else English). Texts
from the manifest are shown in that language, else English, else the first one the release has.

**Release manifest fields read** (all optional; the top level of the manifest is open, D78). `L` is a string or
`{ "en": "…", "de": "…" }`.

```json
"notes": L,
"changes": { "new": [L], "changed": [L], "fixed": [L], "attention": [L] },
"breaking": [ { "summary": L, "action": L } ],
"migrations": [ { "id": "store-v3", "description": L, "reversible": true } ],
"native": {
  "binary": { "linux-x64": { "url": "…", "sha256": "…", "size": 12345678 } },
  "provides": { "moduleApi": ["1", "2"], "rpc": "1.5.0" }
}
```

`size` is enforced when present: the download may not exceed it and must equal it. `native.provides` is what the
release offers add-ons (below).

## Add-ons

Before anything is written, every installed skill, module and channel is judged against what the **target** release
offers.

- A package-installed add-on carries `compat` (`harness`, `moduleApi`, `rpc`, `platforms`, `container`, the same rules
  as `ext install`). They are checked with the release's version as `harness`, `native.provides.moduleApi` as the module
  APIs it speaks and `native.provides.rpc` (else `native.core.rpc`) as the RPC version. A module that came from no
  package is judged by its `module.json` `apiVersion` against `native.provides.moduleApi`.
- **compatible**, **incompatible**, or **unknown** (no cached manifest, or the release does not say which module API it
  speaks and the add-on depends on it). Unknown never blocks and never disables.
- An enabled **incompatible** add-on is **disabled for the new version** after the swap and before the daemon starts
  (the same switch as `plur1bus ext disable`), and recorded in `<home>/update/addons.json`. A rollback puts it back. A
  later update that finds a recorded add-on compatible again re-enables it once the new version is healthy (best
  effort: if the enable is refused it stays recorded and is listed in the result).
- An add-on marked **required** that would be incompatible aborts the update (`addon-incompatible`) unless `--force`.
  Mark with `--require-addon NAME` (repeatable; remembered in `addons.json` when an update is applied) and unmark with
  `--unrequire-addon NAME`.

Only skills, modules and channels have an enabled switch; other kinds (MCP servers, providers) are not judged.

## Offline bundle

`update --from <bundle>` takes a `.tar.zst` or `.zip` holding

```
manifest.json            the release manifest (what the feed serves as {channel}.json)
manifest.json.minisig    its minisign signature
artefacts/<name>         the files the manifest's asset URLs name (matched by the last path segment)
keys.json, keys.json.minisig   optional: a signed key list (rotation)
```

The manifest is verified exactly as the online one is (signature by the baked key or an accepted rotated key), every
artefact by the SHA-256 (and size, when stated) the **signed** manifest pins, then the same snapshot, swap, health gate
and rollback run. Extraction is defensive: only regular files and directories are created (a symlink, hard link,
device or similar is refused), names must be plain relative paths (no `..`, no absolute name, no drive or stream
prefix, no backslash), a name may not repeat, and the entry count and extracted size are capped. The bundle is
unpacked under `<home>/update/bundle/` and removed afterwards. A bundle for another channel than the installed one
is refused unless `--channel` names it. `--from` cannot be combined with `--manifest`, `--check` or `--rollback`.

## Downgrade, replay and key rotation

`<home>/update/guard.json` keeps the highest release version this install has accepted per channel (recorded once the
artefacts verified, before the swap; `--check` never writes it).

- A release **older than the installed version** is refused (`downgrade-refused`).
  "Older" follows SemVer precedence: `1.2.0-rc.1` is older than `1.2.0`, `rc.2` newer than `rc.1`, numeric
  identifiers compare numerically (`rc.2` < `rc.10`), and build metadata (`+build`) is ignored. The desktop updater
  orders versions the same way.
- The **stable channel never offers a pre-release**: `update --check` reports nothing available for it, and applying one
  is refused with `prerelease-on-stable` (pass `--channel beta` to follow pre-releases).
- A validly signed release **older than the highest accepted one** is a replay (`release-replay`): a stale manifest
  served again.
- `--allow-downgrade` lifts both, for a person who means it. The highest-seen version is never lowered.

**Key rotation.** The release key baked into the binary can vouch for a **key list** `{channel}.keys.json` (next to
the feed, with its own `.minisig`; `keys.json` in a bundle):

```json
{ "schemaVersion": 1, "channel": "stable",
  "keys": [ { "publicKey": "<base64 minisign key>", "expires": "2027-06-30T00:00:00Z" } ] }
```

It is fetched only when the manifest does not verify under a key already trusted. Its signature must verify under the
baked key or an already accepted key (so rotation chains); the keys in it that have not expired are remembered in
`guard.json` and sign releases until `expires` (`release-key-expired` afterwards). The baked key never expires. There
is no revocation list: a compromised baked key needs a new build.

## Corporate networks

Every download (feed, signatures, artefacts) uses one client:

- `HTTPS_PROXY`, else `ALL_PROXY` (either case); a value without a scheme is an `http://` proxy. `NO_PROXY` is
  comma separated, blanks ignored, case-insensitive: `*` is everything, `.corp.example` or `*.corp.example` match
  subdomains, a bare `corp.example` matches itself and its subdomains, a trailing `:port` is ignored. An unusable proxy
  value is an error, never a silent direct connection.
- `PLUR1BUS_CA_BUNDLE=<pem file>` or `update --ca-bundle <pem file>`: the PEM certificates are the **only** trust
  anchors for https (like `curl --cacert`; they replace the OS store), which is what a TLS-inspecting proxy needs. An
  unreadable file or one without a certificate is refused up front. Without it the OS trust store applies.

## Testabdeckung und bekannte Lücken

What the tests of `plur1bus update` cover (Rust core hardening pass, 2026-10-12). Nothing above is rewritten by this section.

- **Version comparison, `minFromVersion`, signatures, payloads** (`crates/plur1bus/tests/update_gaps.rs`, the tests added at its end):
  numeric `major.minor.patch` order and ignored build metadata (`update_check_compares_versions_numerically_and_ignores_build_metadata`),
  non-semver targets never applied, `min-from-version` for exactly the installs below the minimum with a hint that names the version to
  upgrade to and no override by `--allow-downgrade` or `--force`, eight kinds of damaged release signature, and signed releases whose
  core payload is a cut gzip stream, noise, empty, or holds `..`, absolute and symlink entries. Each leaves the binary, `config.json`, the
  install manifest, the core and the update state untouched.
- **Already covered elsewhere:** downgrade and replay refusal, key rotation, offline bundles, crash recovery and rollback
  (`update_apply.rs`, `update_gaps.rs`, `src/update/tests.rs`, `coverage_update.rs`).
- **Known gap:** a pre-release suffix is ignored when versions are compared (`is_newer`, `guard::compare`), so `1.2.3-rc.1` is neither
  older nor newer than `1.2.3`, and an install on a release candidate is told it is up to date when the final release appears. Test:
  `update_check_orders_pre_releases_below_their_release_as_semver_does` (ignored). The code states this rule in its comments; this page
  did not, and does not change it.
- **Not tested:** a network connection cut in the middle of a download. Every feed in the tests is a local file, so a signed payload that
  is a truncated archive stands in for it. The desktop update UI is outside this crate.

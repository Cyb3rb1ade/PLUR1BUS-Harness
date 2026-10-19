# Dependency policy

Which third-party licences the harness may depend on, and how that is checked. The check is
`node scripts/audit-deps.mjs` (`pnpm audit:deps`); it needs only Node and runs without network for the licence mode.

## Scope

| Ecosystem | Source of the dependency list | Id in `dependency-exceptions.json` |
|---|---|---|
| pnpm workspace (all `packages/*`, `apps/desktop`, `apps/desktop/ui`) | `pnpm licenses list --json` (needs `pnpm install`) | `pnpm` |
| Cargo workspace (`crates/*`) | `cargo metadata --format-version 1 --locked` | `cargo` |
| Cargo workspace `apps/desktop` (own `Cargo.lock`) | the same, with `--manifest-path apps/desktop/Cargo.toml` | `cargo-desktop` |
| Python: `clients/python/plur1bus-memory-client`, `hosts/hermes/plur1bus` | `pyproject.toml` / `plugin.yaml` declarations, resolved through installed package metadata (`importlib.metadata`) | `python` |

Direct and transitive dependencies are both checked. The harness's own workspace members are not dependencies and are
skipped. An ecosystem that cannot be collected (for example `pnpm install` not run) is reported as `INCOMPLETE`
and the script exits 3, never as a pass.

## Allowed licences

A dependency passes when its licence expression is satisfied by this list. The list below is read by the script; edit it
here, not in the code. SPDX expressions are evaluated: `A OR B` needs one allowed alternative, `A AND B` needs all,
`X WITH <exception>` is judged by `X`, and cargo's legacy `A/B` means `A OR B`.

<!-- audit-deps:allowed -->
- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- MPL-2.0
- Unicode-3.0
- Unicode-DFS-2016
- 0BSD
- CC0-1.0
<!-- /audit-deps:allowed -->

- **MPL-2.0 only unmodified.** File-level copyleft: the dependency may be used as published (including via a lockfile
  pin), never forked or patched in this repository. The script prints a note for every package that relies on it.
  A `patchedDependencies` entry for an MPL-2.0 package needs a review and an exception.
- **Forbidden:** GPL, AGPL, SSPL and other strong-copyleft or source-available licences, unless an `OR` alternative is
  allowed.
- **Unknown is an error:** a missing `license` field, `UNLICENSED`, `SEE LICENSE IN ...`, a custom text or an expression
  that does not parse. Anything else that is simply not on the list (for example `Zlib`) is reported as `NOT-LISTED`
  and also fails until the list is extended or an exception is recorded.

## Exceptions

Approved exceptions live in `docs/dependency-exceptions.json`, never in the script:

```json
{
  "exceptions": [
    {
      "ecosystem": "cargo",
      "name": "example-crate",
      "version": "1.2.3",
      "license": "LGPL-3.0-or-later OR custom",
      "reason": "Why this is acceptable, who approved it, and what would end the exception."
    }
  ]
}
```

- `ecosystem`, `name`, `license` and `reason` are required; `version` is optional (omitted or `"*"` covers every
  version).
- `license` must equal the licence string the package declares today. If the package's licence changes, the exception
  stops applying and the package fails again, so a relicensing cannot slip through.
- An exception that matches no dependency is printed as a stale-exception warning.

## Vulnerabilities

The release gate is `node scripts/release/audit-policy.mjs`, wired into `release-quality.yml`.
The owner selected this policy on 2026-10-15:

- Production **High and Critical** block; production Moderate/Low and development findings
  (including High/Critical) appear as warnings in the GitHub job summary.
- npm scope comes from separate `pnpm audit --prod --json` and full `pnpm audit --json` reports.
  A package reachable in both scopes remains production.
- Rust uses pinned `cargo-deny 0.20.2`, each of the root and desktop Cargo workspaces,
  all features and targets, and paired reports with/without `--exclude-dev`. This conservatively
  includes build dependencies used to produce the release; purely development dependencies warn.
  RustSec CVSS 3.0/3.1 base vectors determine severity. Unscored/unsupported vulnerability vectors
  and unsoundness advisories fail closed for production; unmaintained/yanked notices warn.
- Invalid reports, unavailable tools/databases/network, invalid policy and expired exceptions fail
  the job. The script still attempts each ecosystem and writes the summary on failure.
- Only `audit-allowlist.json` can exempt an advisory. It starts empty; no exceptions were added.
  Entries require `advisoryId` (GHSA/RUSTSEC), `reason`, `created` and `expires` (UTC `YYYY-MM-DD`).
  Expiry is exclusive at 00:00 UTC and must be at most 90 days after creation. An expired entry
  fails even if the advisory disappeared. No automatic renewal or package-wide exceptions.

### Active exceptions: zip 4.6.1 in the desktop lock (owner decision 2026-10-19)

`RUSTSEC-2026-0367`, `RUSTSEC-2026-0368` and `RUSTSEC-2026-0369` are allowed until 2027-01-17 for `zip 4.6.1`
in `apps/desktop/Cargo.lock`. It is pulled in only by `tauri-plugin-updater =2.13.0` (Windows target dependency,
feature `zip`); the fix starts at zip 9 and the plugin's successor exists only as `3.0.0-alpha`.
Rationale, verified in the plugin source: `Update::download` runs `verify_signature` (minisign) on the downloaded
bytes before returning them (`src/updater.rs:837`), and the Windows installer unpacks the archive only afterwards
in `extract_zip` (`src/updater.rs:1074`, via `install_inner`). The desktop app calls `update.download(...)` and
passes exactly those bytes to `update.install(...)` (`apps/desktop/src-tauri/src/update_commands.rs:416-423`).
Without the private release signing key, no manipulated archive reaches the vulnerable parser.
Remedy: upgrade to `tauri-plugin-updater` 3.x as soon as it is stable, then delete the three entries.

**KNOWN GAP:** exceptions are keyed by advisory ID only. They cannot be scoped to a package, version or lockfile,
so the three IDs above would also hide the same advisories for any other crate that carries them (for example a
`zip` added to the root workspace) until 2027-01-17. Scoping needs a new optional allowlist field, which is a schema
change and therefore an owner decision. The `todo` case `KNOWN GAP: an exception is not scoped to the package it was
approved for` in `scripts/release/test/audit-policy.test.mjs` turns green once that exists. Second, `Update::install`
is public API and does not verify its input; the guarantee above holds because the app only installs bytes returned by
`Update::download`. A change that installs bytes from any other source voids this exception.

Only the repository owner changes the allowlist. CODEOWNERS requests their review, and the
release gate rejects an allowlist change in a PR created by anyone else. The owner must enable
required `release-quality` checks and code-owner review in branch protection to enforce this
against merges/direct pushes; repository files cannot enable that protection themselves.
The enforcement script, workflow and CODEOWNERS are also owner-owned. The CI auditor uses an
isolated cargo-deny configuration with no ignored advisories or severity filter.

The following older, optional local advisory helper has different exit semantics and is **not**
the release gate:

`node scripts/audit-deps.mjs --advisories` runs `pnpm audit` and, when `cargo-audit` is installed, `cargo audit` on both
`Cargo.lock` files. A missing tool or no network is reported as `skipped` with the reason; the mode then still exits 0.
Only an advisory actually found exits 1. Python advisories are not wired.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | clean (advisories mode: nothing found; tools or network may have been skipped) |
| 1 | licence violation, or an advisory found |
| 2 | usage error, unreadable or malformed policy / exceptions file |
| 3 | an ecosystem could not be collected (`--allow-incomplete` turns this into a warning) |

## Optional legacy helper job (not the release gate)

The generic helper is not wired into CI. An optional informational job could look like this:

```yaml
audit-deps:
  runs-on: ubuntu-24.04
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24.21.0 }
    - run: pnpm install --frozen-lockfile
    - run: node scripts/audit-deps.mjs
    - run: node scripts/audit-deps.mjs --advisories   # weekly schedule is enough; do not block PRs on new advisories
```

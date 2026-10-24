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
- BSL-1.0 (OSI-approved and permissive, no attribution requirement for binaries; xxhash-rust via lance-encoding)
- Zlib (OSI-approved and permissive; foldhash, zlib-rs)
- MIT-0 (MIT without the attribution requirement; borrow-or-share via jsonschema)
- CDLA-Permissive-2.0 (permissive data licence of the Mozilla CA bundle; webpki-roots, webpki-root-certs via ureq)
<!-- /audit-deps:allowed -->

- **Added 2026-10-24** (PR #759, RE-00: the Rust engine's Lance closure): BSL-1.0, Zlib, MIT-0 and CDLA-Permissive-2.0,
  here and in `deny.toml`, which also gained 0BSD and a per-crate MPL-2.0 exception for `option-ext`. Controller
  recommendation, not objected to by the owner.
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

### Desktop updater archive policy

`tauri-plugin-updater` remains pinned to 2.13.0 with only `rustls-tls`; its optional `zip` feature is disabled.
The desktop lockfile contains no `zip` crate. Windows and Linux use raw v2 updater artifacts; macOS
continues to use `.app.tar.gz`. The feed publisher rejects Windows/Linux `.zip` and `.tar.gz` URLs,
including encoded extensions and URLs with query strings. Legacy v1-compatible updater artifacts are excluded.
The three former zip advisory exceptions have been removed. Signature verification in `Update::download`,
anti-rollback and the exclusive install slot remain unchanged; the app still installs only the bytes returned
by the verified download.

**KNOWN GAP:** exceptions are keyed by advisory ID only and cannot be scoped to a package, version or lockfile.
The existing TODO in `scripts/release/test/audit-policy.test.mjs` records this policy limitation; removing the
zip exceptions does not resolve it. `Update::install` itself does not verify input, so the application must
continue to use `Update::download` before installing.

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

## Advisory licence job (GP5 S4)

`.github/workflows/dependency-licenses.yml` runs a separate **non-blocking** job on dependency,
policy and auditor PR changes, every main push, weekly and manually. It is not a required check
and does not replace `release-quality` or change the existing advisory gate. No user-document-only
PR starts it. Every action uses an immutable commit SHA with its version comment.

The job performs a frozen workspace install, then runs `node scripts/audit-deps.mjs --json`.
The `dependency-licenses` artifact retains `licenses.json`, `errors.txt` and `exit-code.txt` for
14 days. Collection and upload run even after an earlier failure. A non-zero auditor exit is
preserved in the job and artifact; `continue-on-error` at job scope keeps the result advisory.
Missing ecosystems remain visible as incomplete; the job never passes `--allow-incomplete`.
Python packages are not installed by this job, so their missing licence metadata may be reported
as incomplete/unknown. Root and desktop Cargo metadata use the pinned Rust 1.95 toolchain.
No report contents are copied into an executable workflow command or used as an approval.

### Licence exception format

[dependency-exceptions.json](dependency-exceptions.json) is still empty. Its format is described by
[dependency-exceptions.schema.json](dependency-exceptions.schema.json). An owner-approved entry
requires `ecosystem`, `name`, `license`, a non-empty `reason` and `expires` (`YYYY-MM-DD` UTC);
`version` can narrow it to an exact dependency version. Expiry is exclusive at 00:00 UTC.
The CLI rejects malformed calendar dates and expired entries before collecting dependencies;
expiry is an error even when the dependency disappeared. No auto-renewal is provided. This file
is separate from the vulnerability exceptions in `audit-allowlist.json`.

Example shape only (not an approved exception):

```json
{
  "ecosystem": "pnpm",
  "name": "example-package",
  "version": "1.0.0",
  "license": "Example-License",
  "reason": "Owner decision and its reviewed distribution conditions",
  "expires": "2027-01-01"
}
```

### Open owner decisions

None of the following is approved or added to either exception file by S4.

| Case | Decision and recommendation |
|---|---|
| `@img/sharp-libvips-*` / `sharp-win32-*`, LGPL-3.0-or-later via `@huggingface/transformers` | Decide after checking the actual distributed native artifacts and applicable source/notice/relinking requirements. Recommendation: keep the finding visible and require a distribution review before approving a narrow, expiring exception or changing the dependency. This report alone does not establish compliance. |
| `nostr-tools`, Unlicense | Decide whether to include this licence in the approved policy or approve a package/version-specific exception. Recommendation: make that an explicit owner policy decision; do not silently broaden the allow-list. |
| Desktop `zbus_names`, `zvariant_derive`, unmaintained | These are maintenance advisories, not licence approvals. Recommendation: track the upstream zbus migration and its desktop compatibility separately; do not suppress them through the licence exception file. |
| Make licence CI blocking | Recommendation: keep it advisory until the above decisions, reproducible metadata on distributed targets and incomplete Python collection are resolved. Then enable a separate required check through an explicit owner decision. |

S4 does not change the existing `release-quality` merge requirements or any active security
exception. Licence-policy acceptance and native release qualification remain distinct checks.

### Local report used for S4

A prepared macOS arm64 checkout of main `1dae60f2ae` produced 1,313 licence rows,
14 policy findings and no incomplete ecosystem. This is a local-target snapshot, not the
Ubuntu workflow or an all-target release qualification. In addition to libvips and nostr-tools,
the current allow-list reports Python-2.0 (`argparse`), MIT-0 (`borrow-or-share`), Zlib
(`foldhash`, `zlib-rs`) and CDLA-Permissive-2.0 (`webpki-root-certs`, `webpki-roots`).
Several rows appear in both Cargo workspaces. These are unlisted-policy findings, not a claim
that each licence is forbidden. None was silently approved, suppressed or added as an exception.
The advisory job exposes the full target-specific report for the owner policy review.

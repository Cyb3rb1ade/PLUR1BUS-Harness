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

## Suggested CI job (not enabled)

The repository does not run this in CI yet. A job could look like this (not part of `.github/workflows` today):

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

# SH8 API account archive opt-in

Controller F1-L8 (2026-11-01) explicitly authorizes this separate package after SH7: `state/api/accounts.db` enters an ordinary backup only through opt-in. Base: published SH7 `9812846f93087ae0677ffddd4a4ea6a0e2001db7`, in its own worktree/branch. Normal commits/pushes only; the Controller merges after independent Claude review.

## Contract

- `backup create --include-api-accounts` is creation-only and defaults false. Preserve existing JSON/RPC/manifest shapes and old archive readability; no new dependency or Engine change.
- `CreateOpts { include_api_accounts: bool }`, false by default, selects `create_with_opts`; the existing `create` wrapper stays safe by default for uninstall. Preserve the existing note helper as the default wrapper and expose a selected-policy helper for CLI/archive disclosure.
- Use the same exact ASCII-insensitive `sqlite/api/accounts.db` predicate for SQLite units and both snapshot-completeness directions. All unrelated checks remain strict. The Core still makes consistent private SQLite snapshots; the archive omits the account unit and private staging is cleaned. Ordinary backup never reads the Secret Store.
- Do not add accounts to fixed/absent units. Default omission preserves destination accounts and all sidecars. Explicit inclusion restores the account unit with existing rollback semantics; an absent source leaves the destination unchanged even when inclusion was selected.
- Before publishing either option's archive, refuse configured store paths that overlap the account file through lexical or actual filesystem ancestry. Resolve directory symlinks/junctions and missing suffixes through the deepest existing ancestor, failing on permission/loop/dangling-alias errors. Compare components case-insensitively for ASCII, preserving sibling controls. Install validated stage cleanup before refusal. This is a creation boundary; old archives retain their restore acceptance.
- Both portable encrypted backup creation and the pre-restore rollback creation explicitly include accounts. Keep encryption, Vault recovery and restore order. A failed Vault import must restore distinct prior account/config/Vault state; forward archive inclusion and rollback inclusion must each be proven.

## Ownership and sequencing

Archive worker owns create/manifest/private guard and the narrow existing account-inclusion hardening test. CLI worker owns flag/plumbing/integration tests and optional restore test module only. Portable worker owns script/mock tests/real system tests and backup/portable/uninstall documentation. Root owns this plan, changelog, generated documentation, integration checks, actual Claude and publication. No worker stages or commits.

Archive worker gets the first Cargo slot to demonstrate default omission fails against the old create API. CLI edits external integration tests only until that RED is recorded and shared contracts land. Afterward Rust slices edit disjoint source; no Cargo builds while either mutates. Mock-only portable tests may run separately. Whole builds/generators and full suites wait for all source to freeze. Root serializes shared-target builds.

## Evidence and completion

- Meaningful default omission, opt-in payload/roundtrip, case aliases and siblings, unchanged unrelated snapshot mismatches, static store aliases and validated cleanup tests.
- Destination DB/WAL/SHM/journal preservation by default and source absence; explicit replacement/pre-restore preservation and before/after account-swap rollback tests.
- CLI help/flag scope, selected dry-run policy without Core/writes and unchanged output shape. Preserve existing legacy archive verification/restoration controls.
- Portable mock RED→GREEN plus real ordinary/portable Core recovery; runtime credentials only, no personal keychain or model acceptance.
- Follow coding-standard.md, run relevant focused checks, cargo fmt/clippy -D warnings/cargo test -p plur1bus, lint, generated docs/checks and actual Claude on the frozen final tree. Create one ready PR, normal push, attach/open it and report its exact head. No rebase or force-push.

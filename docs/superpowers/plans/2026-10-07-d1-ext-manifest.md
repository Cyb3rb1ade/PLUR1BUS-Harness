# D1 / X2: per-kind extension manifest and the install check

Spec: `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` §5.2, §8.4, §8.6. X1 (docs/extensions.md) already
ships the zip audit (traversal, symlinks, ratios, counts), per-file SHA-256, the atomic install into
`skills/` / `modules/` with per-step rollback, and uninstall for `skill`, `module` and `channel`. What is missing is
everything for `mcp-server` and `provider`: both are refused at inspection (`kind-unsupported`), and the manifest has no
per-kind rules.

## Scope (this PR; no network fetch, no RPC/CLI/supervisor change)

1. `plur1bus-ext`:
   - `Kind::Provider` (`"provider"`) and a closed `provider` block in `p1x.schema.json` (`api`, `baseUrl`).
   - `kinds.rs`: per-kind consistency of a schema-valid manifest (`skill`, `module`/`channel`, `mcp-server`, `provider`);
     `rights.rs`: the declared capabilities as a flat, ordered list of rights (what the extension asks for).
   - `verify.rs` runs the kind check at step 5 and accepts `mcp-server`/`provider`; `bundle` stays refused.
2. `plur1bus` (`ext/packages.rs`): installer for the two inert kinds into `<home>/extensions/packages/<name>/`
   (whole package tree + `record.json`): extract with the one verified extractor into a staging dir, re-check the tree
   against `files` (set, size, SHA-256, no symlinks, count/size caps), write the record, swap in by rename, roll back
   on any failure, `uninstall`, `recover` for leftovers. Nothing is enabled or run: these kinds have no runtime until X3.
3. Docs: `docs/extensions.md` §X2.

## Tests (test first)

Manifest per kind (accept/refuse), rights list, inspect accepts mcp-server/provider; installer: happy path and
replace, zip-slip, symlink in archive, checksum mismatch (tampered tree after extraction), file-count and size limits,
half install rolled back at each step (`PLUR1BUS_TEST_EXT_FAIL_AT`), kill leftovers recovered, uninstall.

## Rulings (fail closed)

Listed in the PR; marked `// RULING:` in code.

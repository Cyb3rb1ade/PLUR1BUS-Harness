# CX6 terminal dependency evidence — 2026-11-02

Native macOS arm64 verification, base CX4 `0ed1814433216331fd6b7c28b4c1b3d1948e56ab`.
The new renderer uses exact `ratatui = 0.30.2` with default features disabled and
`crossterm_0_29` plus `layout-cache`; the existing exact `crossterm = 0.29.0` is shared
with reedline. The default-on Cargo feature `tui` owns the optional ratatui dependency.
The line editor remains available. No npm or Engine dependency or pin changes.

## Lockfile and compatibility

- Fifteen new registry packages, each at least fourteen days old and not yanked in the
  official crates.io version metadata linked below. The age check compares exact timestamps
  with the UTC cutoff, not calendar dates. Declared Rust floors are at most 1.88.
- `lru` remains one version, **0.18.5**, identical to CX4; no 0.12 closure is added.
- `cargo check -p plur1bus --locked --all-features` passes with the pinned Rust 1.95.
- Compressed crate payloads total **957,761 bytes** on this host. Release binary size and
  help-startup delta are measured with the implemented renderer; no B1 performance claim.
- Cargo.lock SHA-256: `a5d620b98b17a257578876568d01913e72f4ec61be38ab4ca67064760b55907b`.

| Package | Version | Declared licence | Rust floor | Published (primary metadata) | Compressed bytes |
|---|---|---|---|---|---:|
| by_address | 1.2.1 | MIT OR Apache-2.0 | not declared | [2024-03-27](https://crates.io/api/v1/crates/by_address/1.2.1) | 8,437 |
| critical-section | 1.2.0 | MIT OR Apache-2.0 | not declared | [2024-10-16](https://crates.io/api/v1/crates/critical-section/1.2.0) | 19,133 |
| indoc | 2.0.8 | MIT OR Apache-2.0 | 1.71 | [2026-10-09](https://crates.io/api/v1/crates/indoc/2.0.8) | 17,682 |
| instability | 0.3.14 | MIT | 1.88 | [2026-09-22](https://crates.io/api/v1/crates/instability/0.3.14) | 14,825 |
| kasuari | 0.4.13 | MIT OR Apache-2.0 | 1.85 | [2026-10-15](https://crates.io/api/v1/crates/kasuari/0.4.13) | 32,886 |
| line-clipping | 0.3.8 | MIT OR Apache-2.0 | 1.85 | [2026-08-03](https://crates.io/api/v1/crates/line-clipping/0.3.8) | 19,377 |
| num_threads | 0.1.8 | MIT OR Apache-2.0 | not declared | [2026-10-17](https://crates.io/api/v1/crates/num_threads/0.1.8) | 8,156 |
| palette | 0.7.7 | MIT OR Apache-2.0 | 1.71.0 | [2026-08-02](https://crates.io/api/v1/crates/palette/0.7.7) | 272,608 |
| palette_derive | 0.7.7 | MIT OR Apache-2.0 | 1.71.0 | [2026-08-02](https://crates.io/api/v1/crates/palette_derive/0.7.7) | 18,136 |
| palette_math | 0.7.7 | MIT OR Apache-2.0 | 1.71.0 | [2026-08-02](https://crates.io/api/v1/crates/palette_math/0.7.7) | 15,423 |
| ratatui | 0.30.2 | MIT | 1.88.0 | [2026-06-19](https://crates.io/api/v1/crates/ratatui/0.30.2) | 72,412 |
| ratatui-core | 0.1.2 | MIT | 1.88.0 | [2026-06-19](https://crates.io/api/v1/crates/ratatui-core/0.1.2) | 191,181 |
| ratatui-crossterm | 0.1.2 | MIT | 1.88.0 | [2026-06-19](https://crates.io/api/v1/crates/ratatui-crossterm/0.1.2) | 18,836 |
| ratatui-widgets | 0.3.2 | MIT | 1.88.0 | [2026-06-19](https://crates.io/api/v1/crates/ratatui-widgets/0.3.2) | 230,487 |
| unicode-truncate | 2.0.1 | MIT OR Apache-2.0 | 1.66 | [2026-01-15](https://crates.io/api/v1/crates/unicode-truncate/2.0.1) | 18,182 |

## Licence, security and notices

`node scripts/audit-deps.mjs --json`: **1,799 rows, zero violations, no incomplete
ecosystems**. The existing policy and exceptions are unchanged. Every new package has
an attribution row and an actual licence-file reference in the regenerated notices.
`node scripts/release/third-party.mjs --reuse-npm` and its `--check` pass; npm reuse
verifies the unchanged pnpm lock and the native baseline texts before retaining them.

`cargo deny --workspace --all-features --locked check` (0.20.2) reports licences, bans and
sources as OK. Its overall command exits 1 for **RUSTSEC-2024-0436**, the existing
`paste 1.0.15` maintenance advisory through DataFusion/Lance/tokenizers. The same command
on untouched CX4 reproduces exactly that one error. None of the fifteen new packages
introduces it. This strict command is **not recorded as green**.

The owning security gate, `node scripts/release/audit-policy.mjs`, passes with
**zero blocking findings and zero collection/policy errors**, using fresh RustSec data,
all features/targets and the existing owner exception for `paste` through **2027-01-30**
in `audit-allowlist.json`. Existing npm Low/Moderate and desktop maintenance/yanked
warnings remain visible. No exception or severity filter was added or changed.

This evidence qualifies the dependency addition on the local target. It does not claim
five-target compilation, terminal acceptance, editor acceptance or the B1 benchmark.

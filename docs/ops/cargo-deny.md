# cargo-deny

The repository-root `deny.toml` defines the Rust dependency policy: approved licenses are allowed, advisories and unknown
sources are denied, and multiple versions are warnings. A license not on the allowlist needs review before it is added.

Install `cargo-deny` with the Rust toolchain, then run from the repository root:

```bash
cargo deny check
```

The command checks advisories, licenses, dependency bans, and sources. Review warnings about duplicate versions and resolve
them when practical; do not silence a finding or add a license exception without reviewing the dependency and its terms.

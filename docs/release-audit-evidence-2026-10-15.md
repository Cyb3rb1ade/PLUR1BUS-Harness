## Release dependency audit

Local macOS ARM, 2026-10-15: Node 24.21.0, pnpm 10.28.0, cargo-deny 0.20.2.
Command: `node scripts/release/audit-policy.mjs`; exit 1 with the unchanged root/desktop
lockfiles from phase-3 commit `3e6cac2a`. All features/platforms, paired production/full graphs.
The initial allowlist is empty. This snapshot is advisory evidence, not a CI success.

Production High/Critical (and unscored vulnerabilities) block. Dev findings and production Low/Moderate warn.

| Ecosystem | Advisory | Package | Scope | Severity | Result |
|---|---|---|---|---|---|
| npm | GHSA-xcpc-8h2w-3j85 | adm-zip | production | high | BLOCK |
| npm | GHSA-f88m-g3jw-g9cj | sharp | production | high | BLOCK |
| npm | GHSA-5xrq-8626-4rwp | vitest | dev | critical | warning |
| npm | GHSA-82fw-gwwq-j7x9 | vitest | dev | moderate | warning |
| npm | GHSA-82fw-gwwq-j7x9 | @vitest/mocker | dev | moderate | warning |
| npm | GHSA-rgj7-g3m4-5g8c | sharp | production | high | BLOCK |
| npm | GHSA-vwc7-r8mq-g2x9 | adm-zip | production | moderate | warning |
| npm | GHSA-7q85-xj36-vmfc | adm-zip | production | high | BLOCK |
| npm | GHSA-rcw4-f5rp-g42v | adm-zip | production | high | BLOCK |
| npm | GHSA-j5f4-cc29-5x44 | adm-zip | production | high | BLOCK |
| npm | GHSA-p634-w6r4-rjp2 | adm-zip | production | moderate | warning |
| npm | GHSA-c6fg-446q-cg94 | adm-zip | production | moderate | warning |
| npm | GHSA-8238-w5pm-2374 | adm-zip | production | high | BLOCK |
| npm | GHSA-hp3w-g68c-fv3c | sprintf-js | production | moderate | warning |
| npm | GHSA-wq5f-xc86-pv6w | sharp | production | high | BLOCK |
| Cargo.toml | RUSTSEC-2026-0344 | ruzstd@0.9.0 | production | high | BLOCK |
| Cargo.toml | RUSTSEC-2026-0346 | rustls@0.23.45 | production | moderate | warning |
| Cargo.toml | RUSTSEC-2026-0347 | rustls@0.23.45 | production | low | warning |
| Cargo.toml | RUSTSEC-2026-0348 | rustls@0.23.45 | production | low | warning |
| Cargo.toml | RUSTSEC-2026-0349 | rustls@0.23.45 | production | low | warning |
| Cargo.toml | yanked | yoke-derive 0.8.3 registry+https://github.com/rust-lang/crates.io-index | production | info | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2026-0346 | rustls@0.23.45 | production | moderate | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2026-0347 | rustls@0.23.45 | production | low | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2026-0348 | rustls@0.23.45 | production | low | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2026-0349 | rustls@0.23.45 | production | low | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2024-0370 | proc-macro-error@1.0.4 | production | info | warning |
| apps/desktop/Cargo.toml | RUSTSEC-2024-0429 | glib@0.18.5 | production | unknown | BLOCK |
| apps/desktop/Cargo.toml | RUSTSEC-2026-0097 | rand@0.9.2 | production | unknown | BLOCK |

11 blocking findings; 0 collection/policy errors.

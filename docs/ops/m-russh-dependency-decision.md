# SSH/SFTP dependency decision for work package M

Owner decision, 2026-10-28: use the audited `russh 0.64.1` / `russh-sftp 3.0.1` combination and develop the SSH/SFTP tests. This narrowly permits the additional version lines and publication ages of the exact dependency tree reviewed for M. It does not change licence or advisory policy, and it does not authorize subsequent dependency upgrades.

The client and in-process test server use the same libraries. `russh` has default features disabled and only `ring` enabled; `russh-sftp` has default features disabled. Tokio remains at the repository's existing 1.53.3. RustSec and all four Cargo Deny checks passed for the reviewed tree on 2026-10-28. Native SSH/SFTP tests must cover host-key trust before authentication or reads, read-only operations, time and size limits, cancellation and secret leakage.

The permitted additional lines are:

| Package | Existing line | Reviewed additional version |
|---|---|---|
| blake2 | 0.10 | 0.11.0 |
| block-buffer | 0.10 | 0.12.1 |
| cipher | 0.4 | 0.5.2 |
| crypto-common | 0.1 | 0.2.2 |
| digest | 0.10 | 0.11.3 |
| generic-array | 0.14 | 1.4.5 |
| hmac | 0.12 | 0.13.0 |
| inout | 0.1 | 0.2.5 |
| num-bigint | 0.4 | 0.5.1 |
| pbkdf2 | 0.12 | 0.13.0 |
| salsa20 | 0.10 | 0.11.0 |
| scrypt | 0.11 | 0.12.0 |
| sha2 | 0.10 | 0.11.1 |

The seven reviewed versions younger than fourteen days are `crypto-bigint 0.7.10`, `ctutils 0.4.6`, `der 0.8.3`, `elliptic-curve 0.14.3`, `inout 0.2.5`, `ml-kem 0.3.3` and `pageant 0.2.5`. The repaired `crypto-bigint` version is required to avoid RUSTSEC-2026-0387; reverting to a vulnerable mature version is not permitted.

The exact package versions and registry checksums remain pinned in `Cargo.lock`. The reviewed additional registry packages are recorded in [m-russh-reviewed-packages.json](m-russh-reviewed-packages.json) for comparison during dependency updates. Inactive optional lockfile packages are included in that inventory and receive no runtime authority from this decision.

## Workspace audit baseline

The complete workspace audit is not clean. An independent checkout of the pre-SSH commit and the merged SSH graph both report the same four existing RustSec findings: `paste 1.0.15` (RUSTSEC-2024-0436), `zstd 0.13.3` (RUSTSEC-2026-0391) and `zstd-safe 7.3.0` (RUSTSEC-2026-0398 and RUSTSEC-2026-0403), through the existing Rust Engine dependency graph. None of the new SSH packages adds an advisory. Cargo licence checks pass for both graphs; duplicate warnings increase by the thirteen reviewed lines.

The complete Node/Python/Cargo licence auditor also retains four existing pnpm policy findings: both Linux libvips packages (LGPL-3.0-or-later), `argparse 2.0.1` (Python-2.0) and `nostr-tools 2.25.2` (Unlicense). They are not covered by this decision. The task does not modify Engine code or expand licence/advisory exception files. These remaining repository-wide failures must be included in the PR validation results.

The rejected OpenSSL-backed candidate and the npm `tweetnacl` licence exception are not authorized by this decision. The repository's licence and advisory exception files remain unchanged.

# Release phase 3 — backup and quality (2026-10-15)

Builds on #524 / #522; no M8 acceptance or release claim.

## Inventory and decisions

- `scripts/release/portable-backup.mjs`: encrypted streaming envelope around the verified ordinary archive and owner-readable vault export. Export/import uses existing CLI `secret ls/get --reveal/set` (values only through stdin), covering both keyring and fallback backends without M2/engine edits. AES-256-GCM, fresh salt/nonce, scrypt; format header authenticated; plaintext vault stays in memory. Passphrase is supplied by a private regular file, never argv/environment. Full authentication and ordinary archive verification precede restore mutation.
- Restore into an installed/running target; an encrypted recovery artifact precedes mutation, and failures roll back state plus vault. This is not crash-atomic across the OS keyring/databases. Application writes must be quiesced. Native real-keyring/Windows ACL behavior still needs evidence. See `docs/portable-backup.md` for commands, limits and recovery.
- Full-state system test names real stores/config, vault, Identity/Admin users, `state/api/accounts.db` (#490), sessions and dream ledger; compares dry-run/real plans. Five-target functional workflow runs it. Ordinary archives still exclude secrets, preserving their existing security contract.
- Generated `THIRD_PARTY.md` and `THIRD_PARTY-LICENSES.txt`: installed production npm graph plus conservative full locked Cargo workspace/desktop graph, attribution and original available license/NOTICE files. Reproducible source drift check on macOS ARM; native payload runners regenerate their platform-specific npm notices. Core payload and distribution package include notices; core payload ships the portable backup tool. Python client runtime is stdlib-only. Buzz/Nostr/A2A SDKs are absent from this base's installed graph; do not invent attribution for unshipped dependencies. Adding those SDKs requires regenerated attribution and their Apache-2.0 notices.
- Strict inherited tsconfig checks also reject explicit false strict suboptions. Retired `--oc-*` theme bridge checked in web/desktop token files. Integrate into lint; no desktop workflow or theme edits.
- `release-quality.yml`: advisory gate at proposed `high`, notice drift, strict types/theme/lint and crypto regressions. Network/tool/audit failures do not count as clean. Threshold still requires owner agreement; no new runtime/build dependencies.

## Validation

Local macOS ARM / Node 24.21: full-state/vault E2E passes (1, no skips), 5 crypto/rollback/theme regressions pass; release .mjs suite 26/26; release .ts suite 23/23; attribution regeneration/check, strict/typecheck, hygiene and actionlint pass. Full lint outcomes recorded in PR. Local fallback tested, no real keyring read/write in tests. Source-wide TS test run also encountered existing Web UI failures (approvals focus, lazy pages, models detail, recurring), outside owned platform fixes; not repaired or hidden.

`pnpm audit --audit-level high` FAILS: 15 vulnerabilities, 6 moderate / 8 high / 1 critical. Critical Vitest via `packages/hostctl`; high adm-zip/sharp through pinned engine → transformers/onnxruntime. Engine and foreign-package changes are forbidden here; no resolution/override, suppression or lowered threshold. Audit is an actual remaining release blocker.

## Gates / owner questions / KNOWN-GAP

No existing gate promoted without three native green runs. New quality workflow fails normally; repository branch protection remains owner-controlled. Audit threshold proposed high (await owner), bwrap/tool installation permission and native runner availability remain questions. No CI polling, merge or tag.

Open: native five-target test outcomes; real-keyring round trip and Windows passphrase/scratch ACL review; crash/interruption recovery exercise for the portable wrapper; all dependency advisories; independent review of backup format/restore orchestration. Attribution is a generated inventory plus available upstream texts, not an independent legal-completeness approval. Conflicts: package lint script, core payload assembly, distribution packaging, release payload steps and the new functional smoke step. D1 desktop jobs and M3 Web-a11y job remain untouched.

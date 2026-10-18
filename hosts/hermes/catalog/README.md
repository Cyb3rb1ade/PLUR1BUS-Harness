# Hermes catalog submission preparation (HM4)

**Draft, not submitted.** `catalog-entry.draft.json` is preparation metadata, not a claim to match an unverified upstream catalog schema. `releaseCommit` and the artifact SHA stay null until the owner selects a stable release. Do not submit a moving branch or a placeholder hash.

The plugin manifest is [`../plur1bus/plugin.yaml`](../plur1bus/plugin.yaml); the existing deterministic provider build (`node scripts/build-hermes-provider.mjs --out /tmp/hermes-provider`) vendors the Python client, adds a per-file SHA-256 manifest and includes the license. The provider contains **no updater/downloader**. `bind --existing` only authenticates to an existing IPC endpoint. An absent/unapproved credential is a refusal, not an installation attempt.

Suggested listing description:

> PLUR1BUS gives Hermes persistent long-term memory through a local Harness. Recall and capture use one approved agent, one engine and the existing store. Existing full installations use a separate revocable client token; host-mode installations can upgrade in place. The catalog plugin does not update or install the Harness itself.

Owner checklist:

1. Accept and publish the first stable HM2/HM4 provider release; collect the three-OS tests and actual Hermes interoperability evidence.
2. Choose the catalog-compatible source layout for the **vendored** provider. The source directory alone lacks `_vendor`; the release tarball supplies it. This may need a packaging-only repository/change in **PLUR1BUS-Host-Addons**, which this package does not edit.
3. Pin the full 40-character release SHA and verify the provider artifact hash and MANIFEST.json against that release. Fill both null fields.
4. Check the current upstream catalog schema/rules, convert the draft metadata to that exact format, and submit as the owner. No submission is performed by this PR.
5. Keep all self-updating code out. Updates remain the Harness/owner's responsibility, separate from catalog installation.

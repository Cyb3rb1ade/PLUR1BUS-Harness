# M8a release pipeline

[CI and local checks](ci.md) · [Document map](../README.md#document-map) · [Legacy native feed](manual-release.md)

## Owner workflow

1. Merge the intended release commit. Set the Cargo workspace version before releasing; this pipeline does not rewrite source versions. Every tag must equal that version, including its suffix. `-rc`/`-beta` suffixes mark prereleases.
2. Push `v<VERSION>`. `release.yml` builds the exact tag commit; `SOURCE_DATE_EPOCH` is its Git commit timestamp, including for annotated tags.
3. Inspect the draft, release notes, artifact inventory, checksums, signatures and provenance. Publish manually after platform acceptance. The workflow never publishes a release or writes to package registries.
4. For a rehearsal, dispatch `release.yml` on the intended branch with an optional version. Dispatch always runs as a dry run: build/package/SBOM artifacts are retained, signing and draft creation are skipped. No OIDC token or write permission is granted to those jobs.

Existing `release.yml` was dispatch-only and called `harness-release.yml`. M8a supersedes that entry point. The optional `legacy-hm2` dispatch input exercises the existing Hermes/native workflow as a dry run. It does not produce an HM2 release. The signed minisign native-update feed and Hermes sidecar publication described in [manual-release.md](manual-release.md) remain separate owner steps; Sigstore signatures are not substitutes for that feed's minisign keys.

## Targets and reproducibility

| CLI target | Runner | Core payload |
| --- | --- | --- |
| aarch64-apple-darwin | macos-15 | native arm64 |
| x86_64-apple-darwin | macos-15-intel | native x64 |
| Universal macOS | macos-15, `lipo` | both Core payloads, select by architecture |
| x86_64-unknown-linux-gnu | ubuntu-24.04 | native x64 glibc |
| aarch64-unknown-linux-gnu | ubuntu-24.04-arm | native arm64 glibc |
| x86_64-unknown-linux-musl | ubuntu-24.04 + musl-tools | x64 glibc Core (see limitation below) |
| x86_64-pc-windows-msvc | windows-2025 | native x64 |

The toolchain comes from `rust-toolchain.toml`; Node is 24.21.0 and pnpm 10.28.0. Cargo uses `--locked`, pnpm uses `--frozen-lockfile`. Existing `pnpm gen`, `pnpm build`, and `assemble-payload.mjs` commands build the Core bundle. Install/fetch steps may access the network; tests do not.

Each native CLI is built twice in distinct target directories. Absolute workspace, Cargo home and output paths are remapped; incremental compilation is disabled; MSVC uses `/Brepro`. macOS passes `-Wl,-no_uuid`: a local double build demonstrated differences only in Mach-O UUID and its ad-hoc signature hash. Omitting that linker UUID removes the path-sensitive metadata; dedicated crash-symbolication/dSYM handling is a follow-up. The Universal `lipo` output is also compared twice. Each Core archive is assembled twice from independent deployments. A byte mismatch fails the build without retrying it. This is a per-run reproducibility gate, not proof that arbitrary OS/SDK/compiler updates yield identical binaries. Hosted image/SDK and system linker updates still require release review.

The dependency-free archive writer sorts entries, fixes uid/gid to zero, normalizes file modes, uses one `SOURCE_DATE_EPOCH`, and writes gzip without source filenames or wall-clock timestamps. ZIP uses sorted stored entries, a fixed DOS timestamp (1980-01-01), and no uid/host metadata. pnpm invocation metadata (`.modules.yaml` and workspace-state files) is excluded from payloads. The assembly code still validates dependency resolution with native addons installed on each host.

The musl CLI is static, but the existing Node native dependencies (including model/runtime libraries) are distributed for glibc. Its bundled Core therefore requires a glibc environment; this is **not an Alpine-compatible complete runtime**. Universal macOS similarly needs the Core payload matching the running Node architecture. Pure-musl Core support is a follow-up, not silently claimed by the CLI target name.

## Artifact layout and signatures

Each `plur1bus-<version>-<target>.tar.gz` (Windows: `.zip`) contains:

```text
bin/plur1bus[.exe]
runtime/core.tar.gz
licenses/LICENSE
README.txt
```

Extract Core into `runtime/core`, then set absolute `PLUR1BUS_CORE_JS` (its `core.js`) and `PLUR1BUS_NODE` (your Node 24.21.0 executable). Universal's outer Core archive contains `darwin-arm64.tar.gz` and `darwin-x64.tar.gz`; extract the appropriate inner archive. These portable bundles do not install services or change user state.

Other draft assets: per-target `core-*.tar.gz`, their hashes/metadata, `cargo.cdx.json`, `pnpm.cdx.json`, `packaging-templates.tar.gz`, `RELEASE_NOTES.md`, `SHA256SUMS`, `SHA256SUMS.sig`, `SHA256SUMS.pem`, `SHA256SUMS.sigstore.json`, and `provenance.intoto.jsonl`.

Syft **1.20.0**, installed using pinned release SHA256 values, scans Cargo and pnpm lockfiles independently into CycloneDX. These are dependency inventories (including development/optional dependencies), not claims that every listed component shipped for every target. Scan timestamps, random serial numbers, temporary source paths and their root reference are normalized while dependency references stay intact. `sbom.sh` itself never installs tools or downloads packages. Its output must be nonempty.

The `sign` job alone has `id-token: write` and `attestations: write`. Cosign **2.5.0** signs the complete checksum manifest with GitHub OIDC; the bundle includes transparency-log verification material. The SHA-pinned GitHub provenance action attests every prepared asset and the signature files. Only the subsequent `draft` job receives `contents: write`. Dispatch never reaches either job.

## Verify a downloaded release

Download all draft/release assets into one directory. Install trusted Cosign and GitHub CLI versions separately. Verify the manifest signature **before** trusting checksums:

```bash
cosign verify-blob release/SHA256SUMS \
  --bundle release/SHA256SUMS.sigstore.json \
  --certificate-identity 'https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/.github/workflows/release.yml@refs/tags/v0.1.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
node scripts/release/checksums.mjs --verify release

gh attestation verify release/plur1bus-0.1.0-linux-x64.tar.gz \
  --repo Cyb3rb1ade/PLUR1BUS-Harness \
  --bundle release/provenance.intoto.jsonl \
  --signer-workflow Cyb3rb1ade/PLUR1BUS-Harness/.github/workflows/release.yml \
  --source-ref refs/tags/v0.1.0

# Performs all three checks for every file listed in SHA256SUMS:
scripts/release/verify.sh release v0.1.0
```

Replace the example version consistently. The exact workflow/tag identity and OIDC issuer are mandatory. Legacy `.sig`/`.pem` are included for interoperability; the Sigstore bundle is the preferred verification input. See [Sigstore blob verification](https://docs.sigstore.dev/cosign/verifying/verify/) and [GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify).

## Packaging status

`packaging/` contains source templates. `node scripts/release/render.mjs VERSION SHA256SUMS OUT` requires real checksums for every referenced target and rejects invalid versions or unresolved placeholders. Outputs are archived as release assets, never submitted to a registry:

- Homebrew formula: macOS arm64/x64 and Linux arm64/x64; suitable for a future tap. Core extraction/environment setup remains manual.
- Winget version, installer and English locale manifests: portable Windows binary.
- Scoop manifest: Windows x64, including SHA256.
- nfpm configs: amd64/arm64 `.deb`/`.rpm`, CLI, Core archive, README and MIT license. Run nfpm from an extracted Linux portable archive. No manpage is generated by the current CLI; add one once available. Packages do not install Node or services automatically.

M8b owns notarization/Developer ID for these new macOS archives, Authenticode for Windows, service integration, installer/uninstaller UX, native-update feed integration and the required `cli.rs` changes. The legacy signing workflow is distinct and does not sign these M8a portable artifacts. Packaging recipes still require validation by their respective registries before publication.

## Local verification

```bash
pnpm install --frozen-lockfile
node packages/config-schema/src/gen-defaults.mjs --check
pnpm gen
pnpm gen
git diff --exit-code -- packages/config-schema/fixtures packages/rpc-schema/generated packages/log-schema/fixtures
pnpm lint
pnpm docs:check
pnpm --filter @plur1bus/config-schema test
node --test scripts/release/test/*.test.mjs
node --experimental-strip-types --test --test-timeout=120000 'scripts/release/test/*.test.ts'
actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml
```

Offline packaging rehearsal (use a Linux binary/Core payload, or synthetic input files to test only the packaging layer):

```bash
export SOURCE_DATE_EPOCH=1700000000
scripts/release/package.sh 0.1.0 linux-x64 /tmp/plur1bus /tmp/core.tar.gz /tmp/release/plur1bus-0.1.0-linux-x64.tar.gz
scripts/release/checksums.sh /tmp/release
scripts/release/checksums.sh --verify /tmp/release
# Setup operation, not a test; downloads a version/checksum-pinned tool:
scripts/release/install-syft.sh /tmp/release-tools
PATH=/tmp/release-tools:$PATH scripts/release/sbom.sh /tmp/release
scripts/release/checksums.sh /tmp/release
```

Local tests validate synthetic archives and contracts without fetching dependencies, minting identities or publishing. They do not establish native platform acceptance or a successful remote release run. Workflow validation uses actionlint locally; do not dispatch CI merely to test workflow edits.

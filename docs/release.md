# M8a release pipeline

[Release evidence checklist](release-checklist-v0.1.0.md) · [Known release gaps](release-known-issues-v0.1.0.md) · [Documentation inventory](release-documentation-audit.md) · [CI and local checks](ci.md) · [Document map](../README.md#document-map) · [Legacy native feed](manual-release.md)

## Owner workflow

1. Merge the intended release commit. Set the Cargo workspace version before releasing; this pipeline does not rewrite source versions. Every tag must equal that version, including its suffix. `-rc`/`-beta` suffixes mark prereleases.
2. Push `v<VERSION>`. `release.yml` builds the exact tag commit; `SOURCE_DATE_EPOCH` is its Git commit timestamp, including for annotated tags.
3. Inspect the draft, release notes, artifact inventory, checksums, signatures and provenance. Publish manually after platform acceptance. The workflow never publishes a release or writes to package registries.
4. For a rehearsal, dispatch `release.yml` on the intended branch with an optional version. Dispatch always runs as a dry run: build/package/SBOM artifacts are retained, release-manifest signing and draft creation are skipped. No OIDC token or write permission is granted to those jobs.

Existing `release.yml` was dispatch-only and called `harness-release.yml`. M8a supersedes that entry point. The optional `legacy-hm2` dispatch input exercises the existing Hermes/native workflow as a dry run. It does not produce an HM2 release. The signed minisign native-update feed and Hermes sidecar publication described in [manual-release.md](manual-release.md) remain separate owner steps; Sigstore signatures are not substitutes for that feed's minisign keys.

## Host tool-eval release gate

The `release-gate` job runs `scripts/eval/tool-eval-host.ts --recorded --require-release` against `packages/core/catalog/host-eval-recordings.json` and `config/shipped-models.json`. It runs at tags `v*` (and in the dry-run dispatch of this workflow), needs `meta`, and `attest` needs it, so a failure stops every later job. It fails closed while no reviewed recordings exist. Mandatory coverage is only the owner-confirmed pins in `config/shipped-models.json` (`approval: "owner_confirmed"`, currently `anthropic/claude-sonnet-5-5`); the pending candidates are advisory and only produce warnings until the owner confirms them (one-line `approval` change). The 7-day freshness rule applies here and only here: for a `v*` tag, every mandatory pin needs a genuine recording (`recordedAt`) at most 7 days old, so refresh it with a nightly capture shortly before tagging. Fabricated, synthetic or future-dated recordings never count. PR and main CI run only the fixture step (`host-tool-eval` in `ci.yml`, see `docs/host-tools.md`); the release gate is not run there (owner decision 2026-10-19). Nothing is relaxed: there is no `continue-on-error`.

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
bin/plur1bus-attest[.exe]
share/polkit-1/actions/org.plur1bus.approve.policy (Linux only)
completions/plur1bus.bash
completions/_plur1bus
completions/plur1bus.fish
completions/plur1bus.ps1
man/man1/*.1
runtime/core.tar.gz
licenses/LICENSE
README.txt
```

The packaging script generates completions for bash, zsh, fish and PowerShell, plus the CLI manpages, from a host-runnable
CLI. For a cross-compiled target it builds/uses the host CLI instead of executing the foreign release binary.

Extract Core into `runtime/core`, then set absolute `PLUR1BUS_CORE_JS` (its `core.js`) and `PLUR1BUS_NODE` (your Node 24.21.0 executable). Universal's outer Core archive contains `darwin-arm64.tar.gz` and `darwin-x64.tar.gz`; extract the appropriate inner archive. These portable bundles do not install services or change user state.

Other draft assets: per-target `core-*.tar.gz`, their hashes/metadata, `cargo.cdx.json`, `pnpm.cdx.json`, `packaging-templates.tar.gz`, `RELEASE_NOTES.md`, `SHA256SUMS`, `SHA256SUMS.sig`, `SHA256SUMS.pem`, `SHA256SUMS.sigstore.json`, and `provenance.intoto.jsonl`.

Syft **1.20.0**, installed using pinned release SHA256 values, scans Cargo and pnpm lockfiles independently into CycloneDX. These are dependency inventories (including development/optional dependencies), not claims that every listed component shipped for every target. Scan timestamps, random serial numbers, temporary source paths and their root reference are normalized while dependency references stay intact. `sbom.sh` itself never installs tools or downloads packages. Its output must be nonempty.

The `sign` job alone has `id-token: write` and `attestations: write`. Cosign **2.5.0** signs the complete checksum manifest with GitHub OIDC; the bundle includes transparency-log verification material. The SHA-pinned GitHub provenance action attests every prepared asset and the signature files. Only the subsequent `draft` job receives `contents: write`. Dispatch never reaches either job.

## Attestation helper delivery

The `attest` job builds `plur1bus-attest` before the CLI/Core jobs. On macOS it combines arm64 and x64 into
one Universal helper **before** signing; both thin CLIs pin those same final bytes, so the Universal CLI also
has the correct hash. Linux and Windows helpers match their archive target. `attest.mjs` hashes the final
signed file and writes public pin metadata; the build job verifies the downloaded helper against that hash
and sets `PLUR1BUS_ATTEST_SHA256` through `GITHUB_ENV` before `pnpm build` and both Cargo release builds.
The CLI passes its baked constants to the Core; the Core is not separately responsible for embedding them.

Optional repository **variables** are `PLUR1BUS_ATTEST_TEAM_ID` (macOS, ten uppercase letters/digits),
`PLUR1BUS_ATTEST_SIGN_IDENTITY` (the public codesign identity name), and `PLUR1BUS_ATTEST_WIN_THUMBPRINT`
(Windows, forty hexadecimal digits). A configured signer must already be provisioned in the runner's
keychain or `Cert:\CurrentUser\My` certificate store. This workflow does not import certificates or
private keys. With absent variables, it logs a warning and pins by SHA-256 and filesystem permissions;
macOS gets an ad-hoc signature for Apple Silicon execution, without a team pin. With configured variables,
a failed signing/verification operation fails the build. No real signer identifiers belong in source.
Helper signing precedes hashing in both tag and rehearsal builds; release-manifest signing remains tag-only.

Packaging requires the final helper beside the input CLI, with its canonical name `plur1bus-attest[.exe]`.
It copies it unchanged to `bin/` beside the CLI, normalizes POSIX mode to `0755`, and archives the containing
directory as `0755` with uid/gid zero. Extract as the Core's user or install as root; neither helper nor its
directory may be group/world-writable. Do not replace or re-sign a shipped helper without rebuilding the CLI
with its new hash. Homebrew installs both binaries in its bin directory; Scoop retains both in the version's
bin directory. nfpm installs the helper root-owned at `/usr/bin/plur1bus-attest` (`0755`) and the Linux policy
at `/usr/share/polkit-1/actions/org.plur1bus.approve.policy` (`0644`). For portable Linux/Homebrew installs,
install the bundled policy there as root and run a graphical polkit agent. No service is installed automatically.

A Cargo release build without `PLUR1BUS_ATTEST_SHA256` logs a build warning. Development builds remain
usable without the content pin. This delivery applies to these portable release archives and their packaging
templates; the legacy native `setup`/`update` feed still needs its own helper installation integration.

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
- nfpm configs: amd64/arm64 `.deb`/`.rpm`, CLI and helper, polkit policy, Core archive, README, MIT license, bash/zsh/fish completions and manpages. Run nfpm from an extracted Linux portable archive. Packages do not install Node or services automatically.

M8b owns notarization/Developer ID for the CLI archives, CLI Authenticode for Windows, service integration, installer/uninstaller UX, native-update feed integration and the required `cli.rs` changes. The legacy signing workflow is distinct and does not sign these M8a portable artifacts. Packaging recipes still require validation by their respective registries before publication.

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
# /tmp/plur1bus-attest must be the final helper whose hash the CLI pins.
scripts/release/package.sh 0.1.0 linux-x64 /tmp/plur1bus /tmp/core.tar.gz /tmp/release/plur1bus-0.1.0-linux-x64.tar.gz
scripts/release/checksums.sh /tmp/release
scripts/release/checksums.sh --verify /tmp/release
# Setup operation, not a test; downloads a version/checksum-pinned tool:
scripts/release/install-syft.sh /tmp/release-tools
PATH=/tmp/release-tools:$PATH scripts/release/sbom.sh /tmp/release
scripts/release/checksums.sh /tmp/release
```

Local tests validate synthetic archives and contracts without fetching dependencies, minting identities or publishing. They do not establish native platform acceptance or a successful remote release run. Workflow validation uses actionlint locally; do not dispatch CI merely to test workflow edits.

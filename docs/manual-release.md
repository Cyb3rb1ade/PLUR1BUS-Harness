# Manual release checklist (first packaged run)

The harness's native release artefacts come from `.github/workflows/harness-release.yml` (2a-H3b-b Task 10, HB7,
HB18). The workflow never runs on a push. D78's `release.yml` calls it (`workflow_call`), merges its
`release-native.json` into `release.json`, signs that and publishes. The first packaged run is done by hand, with this
checklist, before D78 automates it. Every value named here lives in GitHub settings or on the owner's machine, never
in this repository.

## 1. One-time setup (owner)

- [ ] **Release signing keys.** On the owner's machine (not in CI, not in this repository), generate one minisign key
      pair per channel: `minisign -G -p stable.pub -s stable.key` and the same for `beta`. Keep the secret keys offline
      or in D78's signing secret store. Only the public keys go anywhere near this repository.
- [ ] **Repository variables** (Settings → Secrets and variables → Actions → Variables; public values):
      `PLUR1BUS_RELEASE_PUBKEY_STABLE` and `PLUR1BUS_RELEASE_PUBKEY_BETA`, each the base64 key line of the `.pub` file
      (the second line, without the `untrusted comment:` line). Optional: `PLUR1BUS_RELEASE_BASE_URL` (default
      `https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/releases/download/v<version>`). The binaries bake these in, so
      changing one needs a new release.
- [ ] **Repository secret** `GH_ENGINE_READ_TOKEN`, as for `ci.yml` (only while the engine repository is private).
- [ ] **Environment `macos-signing`** (Settings → Environments) with **the owner as required reviewer** and deployment
      restricted to protected branches and `v*` tags. Environment secrets:
  - `MACOS_CERT_P12`: base64 of the "Developer ID Application" certificate exported with its private key as `.p12`
    (`base64 -i cert.p12 | pbcopy`).
  - `MACOS_CERT_PASSWORD`: the `.p12` export password.
  - `APPLE_API_KEY_P8`: base64 of the App Store Connect API key file `AuthKey_<id>.p8` (role Developer is enough).
  - `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: the key id and the issuer id from App Store Connect → Users and Access →
    Integrations.
  - Environment variable `MACOS_SIGNING_IDENTITY`: the certificate's common name,
    `Developer ID Application: <name> (<team id>)`.
  - When D78's `release.yml` in another repository calls this workflow, the environment must exist there too.

## 2. Dry run

- [ ] Actions → harness-release → Run workflow on the release branch with `dry-run` checked (the default).
- [ ] All five `payload` legs and all five `binary` legs are green; `sign-macos` is skipped; `native` is green and its
      job summary shows `release-native.json` with five `binary` and five `core.payload` entries.
- [ ] A warning about a missing `PLUR1BUS_RELEASE_PUBKEY_*` variable means the dry-run binaries cannot verify the
      feed; a real run refuses to build without both.

## 3. First real run

- [ ] Set the version in `Cargo.toml` (`[workspace.package] version`); the workflow refuses a release version that
      differs, because `setup` downloads `core-<binary version>-<target>.tar.gz`.
- [ ] Run the workflow with `dry-run` unchecked (or call it from D78's `release.yml` with `version` and `channel`).
- [ ] Approve the `macos-signing` deployment when asked. `sign-macos` signs with the hardened runtime and a timestamp,
      notarises (`notarytool --wait`) and uploads `signed-darwin-arm64`. A bare Mach-O cannot be stapled: Gatekeeper
      fetches the ticket online.
- [ ] Download the artefact `harness-release-<version>`: five `plur1bus-<target>[.exe]`, five
      `core-<version>-<target>.tar.gz` with `.sha256`, `release-native.json` and `SHA256SUMS`.

## 4. Checks before publishing

- [ ] `sha256sum -c SHA256SUMS` passes, and `release-native.json`'s hashes match it.
- [ ] macOS: `codesign --verify --strict --verbose=2 plur1bus-darwin-arm64` and
      `spctl --assess --type execute -vv plur1bus-darwin-arm64` (after downloading it through a browser, so it carries
      the quarantine attribute) both accept it.
- [ ] Merge `release-native.json` as the `native` key of `release.json`, sign that with the channel's secret key
      (`minisign -S -s stable.key -m stable.json`), and publish the binaries and payloads under the base URL and
      `stable.json` plus `stable.json.minisig` on the feed host.
- [ ] Publish `scripts/install/install.sh` and `scripts/install/install.ps1` next to the feed.

## 5. Smoke test on each OS (a fresh user account or VM)

- [ ] Linux and macOS: `curl -fsSL <host>/install.sh | sh -s -- --non-interactive --accept-nc-licence` (the licence
      flag only when the use class needs it). Windows:
      `& ([scriptblock]::Create((irm <host>/install.ps1))) --non-interactive`.
- [ ] The installer prints the verified hash, installs to `~/.local/bin/plur1bus` (`%LOCALAPPDATA%\PLUR1BUS\bin`),
      and `setup` ends with every step `done` or `skipped`.
- [ ] `plur1bus update --check --json` reports `verified: true` and `available: null`.
- [ ] `plur1bus 1staid check` shows `runtime.node`, `runtime.core` and `models.cache` without `fail`.
- [ ] Record the run URL and the results in the release notes.

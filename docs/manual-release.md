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
- [ ] **Workflow permissions for attestations (HM2 Task 7).** Real releases run through `.github/workflows/release.yml`,
      which calls `harness-release.yml` with `dry-run: false` and then runs its `attest` job: the only job that holds
      `id-token: write` and `attestations: write`, and attests the Hermes provider tarball and the client wheel and
      sdist (build provenance). `harness-release.yml` itself requests `contents: read` only, in every job: GitHub
      checks a called workflow's job permissions against the caller's grant when it creates the run, before any job
      condition, so one job asking for `id-token: write` would make every caller without that grant (dry runs
      included) fail at startup. Any other caller (D78's) must keep attestation in its own job the same way. For a
      private repository, artefact attestations need a plan that supports them.

## 2. Dry run

- [ ] Actions → harness-release → Run workflow on the release branch with `dry-run` checked (the default).
- [ ] All five `payload` legs and all five `binary` legs are green; `sign-macos` is skipped; `native` is green and its
      job summary shows `release-native.json` with five `binary` and five `core.payload` entries.
- [ ] A warning about a missing `PLUR1BUS_RELEASE_PUBKEY_*` variable means the dry-run binaries cannot verify the
      feed; a real run refuses to build without both.

## 3. First real run

- [ ] Set the version in `Cargo.toml` (`[workspace.package] version`); the workflow refuses a release version that
      differs, because `setup` downloads `core-<binary version>-<target>.tar.gz`.
- [ ] Actions → release → Run workflow with `version` and `channel`. It calls `harness-release` with `dry-run: false`
      and then attests the Hermes artefacts. `harness-release` dispatched directly with `dry-run` unchecked refuses to
      run: an unattested real run is not possible from there.
- [ ] Approve the `macos-signing` deployment when asked. `sign-macos` signs with the hardened runtime and a timestamp,
      notarises (`notarytool --wait`) and uploads `signed-darwin-arm64`. A bare Mach-O cannot be stapled: Gatekeeper
      fetches the ticket online.
- [ ] Download the artefact `harness-release-<version>`: five `plur1bus-<target>[.exe]`, five
      `core-<version>-<target>.tar.gz` with `.sha256`, `release-native.json`, `SHA256SUMS`, the Hermes provider
      `plur1bus-hermes-provider-<version>.tar.gz`, the client `plur1bus_memory_client-<version>-py3-none-any.whl` and
      `plur1bus_memory_client-<version>.tar.gz` (not uploaded to PyPI), and `hermes-sidecar.lock.json` (the seed of
      the plugin repository's lock).
- [ ] `gh attestation verify <file> --repo Cyb3rb1ade/PLUR1BUS-Harness` accepts each of the three Hermes files.

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
      `$s = (Invoke-WebRequest -UseBasicParsing <host>/install.ps1).Content; if ($s -is [byte[]]) { $s = [Text.Encoding]::UTF8.GetString($s) }; & ([scriptblock]::Create($s.TrimStart([char]0xFEFF))) --non-interactive`
      (a bare `irm` or `iwr ... .Content` returns `byte[]` under PowerShell 7 when the host serves the script with a
      content type it does not treat as text, and `[scriptblock]::Create` then receives the byte values; the form above
      yields text on Windows PowerShell 5.1 and 7 alike).
- [ ] The installer prints the verified hash, installs to `~/.local/bin/plur1bus` (`%LOCALAPPDATA%\PLUR1BUS\bin`),
      and `setup` ends with every step `done` or `skipped`.
- [ ] `plur1bus update --check --json` reports `verified: true` and `available: null`.
- [ ] `plur1bus 1staid check` shows `runtime.node`, `runtime.core` and `models.cache` without `fail`.
- [ ] Record the run URL and the results in the release notes.

## 6. Plugin feed and one-liners (HM1)

The OpenClaw plugin (`openclaw-plur1bus-memory`, plugin repository) is released by its own workflow,
`plugin-release.yml`. CI there holds no signing key and no npm token; everything below that signs or publishes is the
owner's. Release 7.17.0 is the first: OpenClaw minimum `2026.8.1`, latest tested `2026.9.6`.

### 6.1 One-time setup (owner, plugin repository)

- [ ] **Public keys (P4).** Repository variables `PLUR1BUS_RELEASE_PUBKEY_STABLE` and `PLUR1BUS_RELEASE_PUBKEY_BETA` of
      the plugin repository must equal this repository's variables of the same names (the base64 key line of the
      `.pub` file), because the plugin bootstraps and the installer bundle embed them. A dry run without them renders
      `TEST ONLY` bootstraps and warns; a real run without them fails, and so does a real run that would carry a
      `TEST ONLY` bootstrap.
- [ ] **npm publish (P5, optional, off by default).** Skip this and the release builds the feed with `--no-npm`,
      publishing nothing to npmjs.org. To enable it: (1) on npmjs.org configure a **trusted publisher** for the
      package (`@cyb3rb1ade/plur1bus-memory`; repository = the plugin repository, workflow `plugin-release.yml`,
      environment `npm-publish`); no npm token is stored anywhere. (2) Create the GitHub **environment `npm-publish`**
      in the plugin repository (owner as required reviewer is advised). (3) Set the repository variable
      **`PLUR1BUS_NPM_PUBLISH` to `yes`**; any other value or none means no npm publish. The job runs
      `npm publish --provenance --access public --tag <dist-tag>`: `latest` for the stable channel, `beta` for the
      beta channel, so a beta never becomes `latest`.
- [ ] **Where `plugin-release.yml` can run.** GitHub offers a `workflow_dispatch` workflow only once it is on the
      default branch of the plugin repository. Merge the HM1 branch first; before that, only the tag push trigger
      (`v*`, a real stable run) exists, so do the dry run after the merge.

### 6.2 Dry run

- [ ] Plugin repository → Actions → plugin-release → Run workflow on the default branch with `dry-run` checked (the
      default), channel `stable`. Green means: `check` (tag, `package.json`, manifest and lockfile versions agree),
      `dist` (the `plugin-dist.yml` install matrix and the full suite), `assemble` (bootstraps, unsigned feed,
      `SHA256SUMS`). A dry run creates no release, publishes nothing to npm and records no attestation.

### 6.3 Real run, ClawHub, signing

- [ ] Real run: push the tag `v7.17.0` (always the stable channel), or dispatch with `dry-run` unchecked (channel
      `beta` for a beta release, dispatched on the tag). The `github-release` job publishes the tarball,
      `plur1bus-plugin-installer.mjs`, `install-plugin.sh`, `install-plugin.ps1`, `SHA256SUMS` and the **unsigned** feed
      `plugin-<channel>.unsigned.json`; the tarball, installer and both bootstraps get build attestations; `npm-publish`
      runs only if 6.1 enabled it, then checks that the registry's integrity equals the feed's.
- [ ] Publish the package to ClawHub by hand (the workflow does not) and note the ClawPack sha256. If the feed should
      carry it (`clawpackDigest`, enables the ClawHub install source), dispatch again with the `clawpack-digest`
      input (64 hex) to rebuild the feed before signing; without a digest the bootstrap falls back to installing the
      feed's SHA-256-verified tarball.
- [ ] **Sign offline with the same per-channel secret key as `release.json`** (this repository's §1 keys): download
      `plugin-stable.unsigned.json`, rename it to `plugin-stable.json`, then
      `minisign -S -s stable.key -m plugin-stable.json` (beta: `beta.key`, `plugin-beta.json`). Verify with
      `minisign -V -p stable.pub -m plugin-stable.json`.
- [ ] Publish `plugin-stable.json` and `plugin-stable.json.minisig` at
      `https://updates.plur1bus.app/plugin/stable.json` and `.../stable.json.minisig` (beta: `beta.json`), beside the
      harness feed's own paths. Publish `install-plugin.sh` and `install-plugin.ps1` **from the plugin release** (not
      rebuilt) at `https://plur1bus.app/`, beside `install.sh` and `install.ps1`. The files' bytes must equal the
      release's `SHA256SUMS` and the feed's `bootstrap` hashes.
- [ ] Promotion beta to stable re-signs **identical bytes**: publish the same feed content under the stable name and
      sign it with the stable key; never edit it.
- [ ] Trust model: the plugin bootstrap verifies the feed's minisign signature itself, with Node, before it trusts any
      URL or hash in the feed (HM1-R3). The harness one-liner (`install.sh`/`install.ps1`) still does not (HB19); it
      relies on HTTPS plus SHA-256 and `plur1bus update --check` verifies the signature afterwards.

### 6.4 Smoke test (fresh user account or VM, OpenClaw installed)

- [ ] Linux and macOS: `curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --non-interactive`
      (`--accept-nc-licence` only when the use class needs it). Windows PowerShell 5.1 or 7, a text-safe form:
      `$s = (Invoke-WebRequest -UseBasicParsing https://plur1bus.app/install-plugin.ps1).Content; if ($s -is [byte[]]) { $s = [Text.Encoding]::UTF8.GetString($s) }; & ([scriptblock]::Create($s.TrimStart([char]0xFEFF))) --non-interactive`.
      The plugin repository's docs show the shorter `irm` form; it is fine only where the host serves the script as
      text, so check `curl -sI https://plur1bus.app/install-plugin.ps1` for a `text/*` content type and use the form
      above when it is not.
- [ ] The installer verifies the feed signature, installs through OpenClaw's own `plugins install`, and its
      `openclaw plur1bus selftest` step passes; `--update --check` on the same machine reports the published version.
- [ ] Record the run URL and the results in the release notes.

## 7. Hermes host mode (HM2)

The Hermes adapter spans both repositories. This repository's release (sections 1 to 4) builds the sidecar binaries, the
provider tarball `plur1bus-hermes-provider-<version>.tar.gz`, the client wheel and sdist, and `hermes-sidecar.lock.json`;
the plugin repository's installer (`install-plugin.sh --host hermes`, `install-plugin.ps1 -Host hermes`, plugin PR #204,
release 7.18.0 planned) installs them. The plugin feed's `hosts.hermes` section is **not** written by hand: it is generated
from the plugin repository's `scripts/dist/hermes-sidecar.lock.json`, so the harness release has to come first.

- [ ] Harness release done and its Hermes artefacts attested (section 3). The release's `hermes-sidecar.lock.json` lists the
      sidecar binary per target and the provider tarball with URL and SHA-256.
- [ ] **Set the tested Hermes version.** The feed's `minHermesVersion` and `testedHermesVersion` are read from the lock
      file itself. The release job (`harness-release.yml`) has no input for it and does not pass `--tested-hermes`, so the
      lock it produces says `testedHermesVersion: "0.21.4"`, the same as the minimum. Raise it by hand to the latest Hermes
      version you actually ran the `hermes-host.yml` legs against: either regenerate the lock from the downloaded
      artefacts with `node scripts/build-hermes-provider.mjs lock --artifacts <dir> --base-url <url> --out <file> --tested-hermes <version>`,
      or edit `testedHermesVersion` in the copy before committing it. Check that `minHermesVersion` is `0.21.4` (HM2-R22).
- [ ] **Bump the lock.** Copy that file to `scripts/dist/hermes-sidecar.lock.json` in the plugin repository, review the diff
      (versions, URLs, hashes against this release's `SHA256SUMS`, the two Hermes versions above), and commit it.
- [ ] **Then release the plugin** as in section 6 (dry run, tag `v7.18.0`, sign offline, publish). The installer bundle's
      pinned Node (24.21.0, `scripts/dist/node-pins.json`) must still equal the harness's Node pin (`pins.rs`); the plugin's
      `node-pins` CI check compares it with nodejs.org `SHASUMS256.txt`.
- [ ] Native Windows stays labelled beta (feed `hosts.hermes.windowsNativeBeta: true`) until the Windows legs of
      `hermes-host.yml` and the plugin's `plugin-dist.yml` have been green for four weeks (plan Q7). The feed builder only
      carries the previous feed's value forward (`true` for the first feed); no option flips it yet, so ending the beta
      label needs a change to the feed builder, and re-signing alone does nothing.
- [ ] **Before the first real release:** the `real-hermes` Windows leg of `hermes-host.yml` is `continue-on-error` until its
      first green run, and the plugin's Hermes legs stay non-blocking until a harness pre-release carrying the sidecar
      binaries exists (plan P4, Q8: cut it on the `beta` channel, signed offline as above).
- [ ] Smoke test on a machine with Hermes installed: `curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --host hermes --non-interactive`
      (`--accept-nc-licence` only when the use class needs it; `--replace-provider` only to replace another memory
      provider). Then `hermes memory status` names `plur1bus`, `hermes plur1bus selftest` passes, a second run reports
      `up-to-date`, and `--uninstall` restores the previous `memory.provider` and leaves the store. Record the run URL in
      the release notes.
- [ ] Nothing is uploaded to PyPI (plan Q2); `plur1bus-memory-client` exists only as the wheel and sdist attached to the
      release and as the copy vendored into the provider.

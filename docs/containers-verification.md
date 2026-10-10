# AK container distribution verification

Local acceptance: 2026-10-10, Apple Silicon, macOS 27.2. Docker Engine 29.4.0
(OrbStack) and Apple Container 1.5.0. CI and publication are separate; no CI checks
were polled and no images were published during this implementation.

## Inventory against origin/main

Base: `433ca5b30cfc6b54f4b3d659578839bb3395cee9`.

| Area | Already on main | Completed in AK |
| --- | --- | --- |
| Image | M8 root Dockerfile, hardened compose, healthcheck, existing container workflow | Independent digest-pinned distribution image, Docker/Apple build helper, required commit metadata |
| Runtime | In-image `container-managed` refusals, desktop test seam | Docker Engine API (Unix/TLS/named pipe), Apple CLI, diagnosed selection and activation |
| Stack | Native supervisor lifecycle | Ownership checks, persistent volumes, health-gated up/down/image replacement and rollback |
| Sidecars | No host sidecar controller | Bundled/remote/off, remote HTTP/TLS and Valkey health, private generated settings, dependency IP resolution |
| Installer | Native setup | Host install/setup container mode, plan, runtime licence/download consent, sidecar selection and offline load |
| Updates | Signed native feed, key rotation/replay guard, binary snapshots | Host-image dispatch using the same guard, digest pin, store-schema refusal, pending recovery and manual rollback |

The unfinished prototype was audited rather than copied wholesale. Ajv strict-schema
errors, default/placeholder OCI metadata, Apple minimum memory, directory-only binds,
custom-network DNS and interface routing, optional-tag digest normalisation, registry
authentication, Docker chunked load and log error handling were corrected.
Existing workflows, core implementation, desktop apps and channel/voice packages were
not changed. The CLI Cargo manifest adds the runtime library/HTTP dependencies needed
for installer wiring; the workspace already includes `crates/*`.

## Offline checks

- `cargo fmt --all -- --check`
- `cargo clippy --workspace -- -D warnings`
- `cargo test -p plur1bus-containers -p plur1bus`
- `pnpm --filter @plur1bus/config-schema test` (34 tests)
- `node --experimental-strip-types --test tests/container-distribution-assets.test.ts` (3 tests)
- `pnpm typecheck`, `pnpm docs:check`, `node scripts/lint-hygiene.mjs`
- `hadolint containers/harness/Dockerfile`
- `actionlint .github/workflows/containers.yml`

New tests use a Unix-socket Docker API, an isolated fake Apple CLI, generated minisign
keys, synthetic registry credentials, injected remote health failures and scratch homes.
They cover explicit/automatic runtime choice, detection, binding, offline archives,
stack ownership, rollback, JSON commands, signed-image refusals and private sidecar
settings even in a pre-existing shared home. Native tests are opt-in; their ordinary
no-op executions do not constitute native acceptance.

## Native macOS results

Both `docker buildx build` and independent `container build` completed successfully.
The Apple helper preloads pinned base indexes and copies a stable context; it does not
call Docker. Native arm64 builds were exercised locally; the workflow builds both
arm64 and amd64, with SBOM/provenance and an informational Trivy report.

Both real runtime tests passed with `PLUR1BUS_IT_CONTAINERS=1`: stack up, a second up,
healthy status, `plur1bus --version`, down and retained state volumes. In addition,
the real host installer on each runtime loaded its native archive and brought up the
harness, bundled Valkey and bundled SearXNG. Repeated up stayed healthy; a SearXNG client
successfully pinged its Valkey over the shared private network. The native remote
Valkey probe also passed against the scratch Valkey address.

Application processes were checked: harness UID 10001, Valkey UID 999, SearXNG UID 977;
`CapEff=0000000000000000` and `NoNewPrivs=1`. Apple's VM init precedes the hardened
application entrypoint, so the application's process (rather than VM init) was inspected.
No harness/sidecar host ports were published. Scratch containers are removed with the
same host `container down`; persistent state survives that operation.

## Acceptance boundaries

Windows named-pipe transport has no native Windows acceptance result from this Mac.
The host native updater remains unchanged. Store-schema migrations are deliberately
refused by the image-only updater because old images cannot undo a data migration.
The current core exposes authenticated Unix RPC; adding an HTTP listener is outside AK.

Release integration uses the workflow's `container-release-fragment`: the release
producer must incorporate its digest/store-schema offer before signing the channel feed.
GHCR stays private before release; visibility is changed by the release operator.
No CI, merge, image publication or public release result is claimed here.

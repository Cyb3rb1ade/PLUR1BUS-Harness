# Container distribution (AK)

The host CLI controls a stack through Docker's Engine API or Apple Container 1.5.0.
This is additive to the existing M8 image and native installer. Images contain the Rust
supervisor/CLI and the pinned TypeScript core, run as 10001:10001 with a read-only root,
no capabilities, no new privileges, resource limits and a readiness health check.
Persistent data lives in a runtime volume. Do not use macOS virtiofs binds for SQLite state.

## Build on macOS

```sh
containers/build.sh apple plur1bus-harness:local
containers/build.sh docker plur1bus-harness:local
```

The Apple path uses `container build` directly and needs no Docker daemon or executable.
The Apple helper preloads the pinned base-image indexes before building. Both builds supply `SOURCE_DATE_EPOCH`, the actual Git revision and commit timestamp;
the Dockerfile refuses missing/placeholder metadata. Base images are pinned to multi-arch
index digests. Set `PLUR1BUS_BUILD_PLATFORM=linux/amd64` for an amd64 build; the workflow
builds both architectures. For private engine access, provide `GH_ENGINE_READ_TOKEN` as
an environment variable; it is passed as a BuildKit secret, never an ARG, ENV or layer file.
The helper copies a stable context into a temporary directory to avoid concurrent build races.

## Install on the host

```sh
plur1bus install --container --container-plan
plur1bus install --container --non-interactive
# Same installer through setup:
plur1bus setup --container --image <digest-pinned-image> --non-interactive
# Offline image loading (the archive must contain this image reference):
plur1bus install --container --runtime apple --image plur1bus-harness:local --image-from harness.tar --non-interactive
```

An interactive install offers off/bundled/remote search, displays the plan and asks before applying it. `--container-plan`
detects runtimes and shows sidecar choices without installation. `--runtime` overrides
`containers.runtime` in config; automatic selection prefers supported Apple Containers on
macOS ARM, including activation of a stopped Apple service, then Docker. An explicit
unavailable runtime is refused. Apple requires macOS 26+ and the tested CLI version 1.5.0.
Docker detection covers `DOCKER_HOST`, Docker contexts (Desktop, OrbStack, Colima),
rootless Podman-compatible sockets and the Windows `docker_engine` named pipe. Remote
Docker requires TLS; certificate paths come from `DOCKER_CERT_PATH` and are not saved. Private GHCR pulls use
Docker's existing login config/credential helper (via a temporary private header file)
or Apple's existing registry login. Helper failures fall back to anonymous pulls; private
registries still reject unauthenticated requests.

When a runtime is missing, the plan displays the official download location and licence.
Runtime downloads require separate `--accept-runtime-download` consent. On macOS ARM
this downloads Apple's signed installer; Windows and Intel macOS use Docker's vendor
installer. Complete its OS installation and retry. Linux downloads Docker's official convenience installer after consent. Complete the
vendor installation and retry; the harness downloader does not execute installers.
Docker Engine licence: https://github.com/moby/moby/blob/master/LICENSE .
Docker Desktop terms: https://www.docker.com/legal/docker-subscription-service-agreement/ .
Apple licence and releases: https://github.com/apple/container/releases/tag/1.5.0 .

`container-install.json` records the host stack, runtime, version and health budget.
Host mutations take an OS file lock. `container up` is idempotent and refuses containers
or networks without the installation's ownership label. `down` keeps state volumes.

```sh
plur1bus --json container status
plur1bus --json container up
plur1bus --json container down
plur1bus container logs
plur1bus --json container logs plur1bus-harness
```

The output schemas are `container.install/1`, `container.status/1`, `container.up/1`,
`container.down/1` and `container.logs/1`. Logs follow the service and produce one JSON
document per line; Docker's stream framing is removed. Interrupting logs kills/reaps only
the transport process. Runtime and command failures use the CLI's normal JSON errors.

## API binding and sidecars

The current core uses authenticated Unix RPC inside the container. The distribution
publishes **no API port**. No host API defaults to `0.0.0.0`; runtime service validation
rejects wildcard/public addresses. `compose.api.yaml` is a loopback-only example for a
future installed HTTP listener; adding it cannot create an HTTP API in this core.
See [sidecars.md](sidecars.md) for bundled/remote/off selection.

## Signed host image updates

Inside the image, `setup` and `update` retain `container-managed` refusals. On a host
with `container-install.json`, `update` uses the image updater instead of swapping the
host binary. Native homes continue through the unchanged native updater.

The signed channel manifest includes an additive top-level offer:

```json
{
  "version": "0.2.0", "channel": "stable", "minFromVersion": "0.1.0",
  "containers": {
    "image": "ghcr.io/cyb3rb1ade/plur1bus-harness-distribution@sha256:<64 lowercase hex>",
    "storeSchema": 1
  }
}
```

This uses the existing release parser and update guard (exact-byte minisign verification,
key rotation, expiry, highest-seen version and explicit downgrade acceptance). Development
builds without a trusted release key cannot apply images. A tag or an offer changing the
store schema is refused. The release producer must include the workflow's container
fragment **before signing** its feed; an unsigned registry tag is never an update authority.

```sh
plur1bus update --plan --manifest stable.json
plur1bus update --yes --manifest stable.json
plur1bus update status
plur1bus update --rollback
```

The updater pulls the digest before stopping the healthy old container, retains its state
volume and service definition, and gates the replacement. Failure recreates and gates the
old image. A pending record is saved before replacement; the next mutating host command
restores the previous stack after interruption. `--check`/`--plan` do not start recovery or
change host state. Offline `update --from` verifies the existing signed bundle format;
its pinned image must already be available to the runtime (offline installer loads archives).
The container path does not alter native add-on requirements. Store-schema migrations need
an explicit backup/migration orchestrator and cannot be made safe by an image-only rollback.

## Publication and verification

`.github/workflows/containers.yml` is independent of the existing workflow. PRs build OCI
archives; only pushes to main or version tags push to GHCR. Actions use commit SHA pins;
publication has package-write permission only in its job. Builds include SBOM and maximum
provenance. Trivy's JSON report is informational and uploaded as an artifact. New packages
are private; release publication may switch visibility to public. Registry visibility is
checked before main publication. Creating a PR is not evidence of a CI build or publication.

```sh
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test -p plur1bus-containers -p plur1bus
hadolint containers/harness/Dockerfile
actionlint .github/workflows/containers.yml
pnpm docs:check
PLUR1BUS_IT_CONTAINERS=1 cargo test -p plur1bus-containers --test integration -- --nocapture
```

Default tests use a Unix-socket fake Docker API, a fake Apple CLI, generated signing keys
and injected health probes. Real runtimes are contacted only with `PLUR1BUS_IT_CONTAINERS=1`.
Integration uses uniquely named containers/networks/volumes; volumes survive `down` and
are reported for explicit cleanup. Windows named-pipe code requires native Windows
acceptance in addition to these macOS results.

Without an image override, installation resolves the digest from the signed stable
channel feed; `--channel beta` selects beta. `--container-manifest <file-or-url>`
selects another signed feed. Planning verifies metadata without starting containers.

# The harness container image

`plur1bus-harness` is the harness (supervisor, core, the Rust CLI) as one hardened OCI image, for a VPS, a homelab or the
desktop app's runtime controller (desktop spec `docs/superpowers/specs/2026-09-27-desktop-app-design.md` §6.15, DS15–DS19;
`docs/milestones.md` M8). The native installer (`plur1bus setup`) remains the developer path; inside the image `setup` and
`update` answer `E_NOT_AVAILABLE reason=container-managed` (`PLUR1BUS_CONTAINER=1`).

## Build

```bash
docker buildx build --secret id=engine_token,env=GH_ENGINE_READ_TOKEN -t plur1bus-harness:local .
```

- `Dockerfile` has three stages: `rust-build` (`cargo build --release --locked -p plur1bus`), `node-build` (`pnpm install
  --frozen-lockfile`, build, then `pnpm deploy --legacy --prod` of `@plur1bus/core`: a self-contained production tree) and
  `runtime` (Node 24 Debian slim, glibc: LanceDB and onnxruntime prebuilds).
- **Base images are pinned by digest** (`rust:1.95-slim-bookworm`, `node:24.21.0-bookworm-slim`, the multi-arch index digest).
  Bump tag and digest together (`docker buildx imagetools inspect <tag>`). `scripts/release/test/container-files.test.ts`
  fails an unpinned `FROM`.
- **The engine token is a BuildKit secret, nothing else.** The engine (`@cyb3rb1ade/plur1bus-memory`) is a pinned git
  dependency; if its repository is private, supply `--secret id=engine_token,env=GH_ENGINE_READ_TOKEN`. It is mounted for the
  two RUNs that fetch dependencies, handed to git through that RUN's environment, and is in no ARG, ENV, COPY or layer. The
  secret is optional (`required=false`): a public engine builds without it.
- **Reproducibility.** Frozen lockfiles, `--locked`, digests, `SOURCE_DATE_EPOCH` and `rewrite-timestamp=true`. CI rebuilds
  without cache and compares image ids (informational until it has been green; see the workflow).
- `.dockerignore` keeps `.git`, `target/`, `node_modules/`, `dist/`, env files, keys and `.npmrc`/`.netrc` out of the context.
- No models in the image: they download into the models volume on first use (about 600 MB, with the existing licence gate).
- arm64: `linux/arm64` is built natively (`workflow_dispatch` with `arm64: true` on `ubuntu-24.04-arm`), never under QEMU.

## Run

```bash
PLUR1BUS_IMAGE=plur1bus-harness:local docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps          # health: starting → healthy
docker compose -f deploy/compose.yaml exec harness plur1bus --version
docker compose -f deploy/compose.yaml exec harness plur1bus daemon status
docker compose -f deploy/compose.yaml exec harness plur1bus 1staid check
```

Use a digest (`ghcr.io/cyb3rb1ade/plur1bus-harness@sha256:…`) in production, never a tag. The same flags as a plain `docker run`:

```bash
docker run -d --name plur1bus-harness --init --read-only --tmpfs /tmp:size=64m,mode=1777,noexec,nosuid \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 1024 --memory 3g --stop-timeout 150 \
  -v plur1bus-state:/var/lib/plur1bus -v plur1bus-models:/var/lib/plur1bus/models --restart unless-stopped \
  plur1bus-harness:local
```

## What is in the image

| | |
|---|---|
| User | `10001:10001` (`plur1bus`), no login shell, no sudo |
| Entrypoint | `plur1bus supervise` (the supervisor, which spawns and monitors the core; ADR-012 §10) |
| Environment | `PLUR1BUS_CONTAINER=1`, `PLUR1BUS_HOME=/var/lib/plur1bus`, `PLUR1BUS_CORE_JS=/opt/plur1bus/core/dist/core.js`, `PLUR1BUS_NODE=/usr/local/bin/node` |
| State volume | `/var/lib/plur1bus`: `config.json`, stores, LanceDB, journal, `run/`, logs, installed modules (survive image upgrades) |
| Models volume | `/var/lib/plur1bus/models`: the engine's model cache is `<home>/models` (`packages/core/src/paths.ts`) |
| Removed | npm, npx, corepack, yarn: nothing installs packages at run time |
| Ports | none published (the HTTP API is M3; compose gets `127.0.0.1:18700:18700` then) |

Hardening (compose and the smoke test assert it): non-root, read-only root file system with `tmpfs /tmp`, all capabilities
dropped, `no-new-privileges`, `pids_limit 1024`, memory 3 GiB. No runtime socket, no `--privileged`, no host network, no
home-directory mount, no secrets in the image or in `deploy/compose.yaml`.

## Health

`HEALTHCHECK` (and the compose healthcheck) runs `node /opt/plur1bus/healthcheck.mjs`, which calls `plur1bus --json daemon
status` (read-only) and is healthy when the supervisor answers and its core child is `ready`. `start_period` is 90 s: the
first start loads the engine. Model warm-up does not gate health (`core.status` reports `models-warming` separately; run
`plur1bus 1staid check` for the models row).

## Stop and restart

`stop_grace_period: 150s` (`--stop-timeout 150`): the supervisor stops the modules and then the core inside its 120 s budget on
SIGTERM and exits 0. `restart: unless-stopped` restarts a dead container; inside it the supervisor restarts the core with
backoff.

## Size

CI measures every build and writes the table to the job summary (`container.yml`, step "size"). Target (spec §6.15.9): ≤ 350 MB
compressed per architecture, gated at +10 % by the release pipeline (D1). The first CI measurements are recorded here:

| Build | Uncompressed | gzip of `docker save` |
|---|---|---|
| amd64 (`container.yml`, PR run) | _recorded from the first green run_ | _recorded from the first green run_ |

## CI

`.github/workflows/container.yml` builds the image (no push), runs `scripts/container-smoke.sh` (starts under the hardened
flags, waits for `healthy`, `plur1bus --version`, non-root and read-only checks, no engine token in the image metadata, clean
stop), reports the size, runs trivy and grype as **informational** scans, and does the reproducibility rebuild. Run the smoke
test locally: `scripts/container-smoke.sh plur1bus-harness:local`.

## Not here yet

- `plur1bus init` as PID 1 (DS19): compose uses `init: true` (tini) meanwhile; the entrypoint becomes `plur1bus init` when it lands.
- The HTTP API port and an HTTP health probe (M3).
- Signing (cosign), SBOM attestation, provenance, GHCR publication, the offline tarball and the size gate: the release pipeline (D1).
- `quadlet` units for Podman, the `browser` and `searxng` profiles (D3, D75).
- The bundled operations skill (`skills/plur1bus-ops`) is installed by `setup`, which is container-managed here; shipping it in the image is an open point.

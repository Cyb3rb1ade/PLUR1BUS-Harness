# M8 — harness container image and `deploy/compose.yaml` (plan, 2026-10-06)

Sources: `docs/milestones.md` M8 ("the harness container image … published with `deploy/compose.yaml`"), desktop spec
`2026-09-27-desktop-app-design.md` DS15–DS19, §6.15.5–§6.15.7, §6.15.9, §6.15.11.

## Goal

A reproducible, hardened `plur1bus-harness` image (linux/amd64; arm64 via buildx if cheap), a compose file for a VPS or
the desktop controller, `docs/container.md`, and a CI workflow that builds it and smoke-tests it. Build only; no registry push,
no signing (the release pipeline, desktop D1, owns those).

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | `rust-build` → `node-build` → `runtime`. Base images pinned by digest. Non-root `10001:10001`. State in `/var/lib/plur1bus`. `HEALTHCHECK`. |
| `.dockerignore` | keeps the context small and keeps `.git`, `target/`, `node_modules/`, `apps/`, local env files out of it. |
| `deploy/container/healthcheck.mjs` | health probe run by `HEALTHCHECK` and compose: asks `plur1bus daemon status --json`, healthy only if the core child is `ready`. |
| `deploy/compose.yaml` | volumes, healthcheck, restart policy, hardening (§6.15.11 shape). |
| `docs/container.md` | build, run, volumes, hardening, health, size, supply chain, what is not here yet. |
| `.github/workflows/container.yml` | new workflow (task exception): build (`docker/build-push-action`, `push: false`, `load: true`), smoke test, size report, informational trivy/grype scan, optional arm64 build. |
| `scripts/container-smoke.sh` | the smoke test, usable locally and in CI. |
| `scripts/test/container-files.test.mjs`-style hygiene test | static checks of the Dockerfile and compose (digest pins, USER, no secret ARG/ENV, HEALTHCHECK, read_only, cap_drop). |

## Tasks

1. Plan (this file). 
2. Static test first: Dockerfile/compose invariants (fails until the files exist).
3. `Dockerfile`, `.dockerignore`, `healthcheck.mjs`.
4. `deploy/compose.yaml`.
5. Smoke script + `container.yml`.
6. `docs/container.md`; AGENTS.md pointer; hygiene pass.
7. CI: fix to green (≤ 3 extra pushes).

## Design notes and rulings

- **Engine access.** The engine is a pinned git dependency. The build takes an optional BuildKit **secret** `engine_token`
  (never an `ARG`/`ENV`, never in a layer); git is configured through `GIT_CONFIG_*` environment variables of that one `RUN`.
- **Reproducibility.** Base images by digest, `pnpm install --frozen-lockfile`, `cargo build --release --locked`, apt not used in the runtime stage, `SOURCE_DATE_EPOCH`
  fixed from the commit date in CI and `rewrite-timestamp=true` on the image exporter.
- **Entrypoint.** `plur1bus init` (DS19) does not exist yet, so RULING R1: the entrypoint is `plur1bus supervise` and compose sets
  `init: true` (Docker's tini) for zombie reaping/signal forwarding until `init` lands; the supervisor's SIGTERM path is the clean stop. Compose `stop_grace_period: 150s`.
- **Health.** The HTTP API (`/api/v1/meta`, M3) does not exist yet, so RULING R2: health is the supervisor's `daemon.status` (core `ready`), not HTTP.
  No port is published until M3.
- **Read-only root.** `read_only: true` + `tmpfs /tmp`; everything that writes lives on the two volumes.
- **Models** are not in the image (DS18/§6.15.9). RULING R3: the smoke test starts the real core and gates on `ready` only; model warm-up is reported separately by `core.status` and does not gate health.
- **Models volume path.** RULING R4: the spec's `/var/lib/plur1bus-models` does not match the engine, whose cache is `<home>/models` (`packages/core/src/paths.ts`); the second volume mounts at `/var/lib/plur1bus/models`.
- **Toolchain.** RULING R5: the Rust stage deletes `rust-toolchain.toml`; the digest-pinned `rust:1.95-slim-bookworm` is the pin (otherwise rustup downloads "1.95" again under another name).
- **arm64.** RULING R6: native arm64 only through `workflow_dispatch` (`ubuntu-24.04-arm`), not on PRs: that runner is not available to every repository and a queued job must not hold a PR; never QEMU.
- **Reproducibility** is an informational job until one green run shows a stable image id.

## Acceptance → test

| Acceptance | Test |
|---|---|
| Builds reproducibly | CI builds twice with `SOURCE_DATE_EPOCH` and compares image digests (informational if the base differs). |
| Container starts, health green, `plur1bus --version` | `scripts/container-smoke.sh` in `container.yml`. |
| Non-root, read-only, caps dropped, no secrets in layers | static test + `docker inspect` / `docker history` assertions in the smoke script. |
| Base images pinned by digest | static test. |
| Scan informational | trivy + grype steps with `continue-on-error`. |
| Image size documented | CI summary + `docs/container.md` table. |

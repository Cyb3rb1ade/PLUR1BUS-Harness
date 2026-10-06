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
- **Models** are not in the image (DS18/§6.15.9): the smoke test uses the `flat-embedder` seam only through an explicit env opt-in? — RULING R3: smoke starts the real core; if the core needs models for `ready`, the
  smoke test sets `PLUR1BUS_ALLOW_TEST_INTERNALS=1` seam via the supervisor's environment (to be confirmed while implementing; recorded in the PR).

## Acceptance → test

| Acceptance | Test |
|---|---|
| Builds reproducibly | CI builds twice with `SOURCE_DATE_EPOCH` and compares image digests (informational if the base differs). |
| Container starts, health green, `plur1bus --version` | `scripts/container-smoke.sh` in `container.yml`. |
| Non-root, read-only, caps dropped, no secrets in layers | static test + `docker inspect` / `docker history` assertions in the smoke script. |
| Base images pinned by digest | static test. |
| Scan informational | trivy + grype steps with `continue-on-error`. |
| Image size documented | CI summary + `docs/container.md` table. |

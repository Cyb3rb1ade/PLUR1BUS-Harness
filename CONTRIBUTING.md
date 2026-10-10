# Contributing to PLUR1BUS Harness

This page covers what you need to build, test and submit a change. CI details are in [docs/ci.md](docs/ci.md).

## Prerequisites

- **Node.js**: `>=24.16.0 <25 || >=26.1.0` (`engines.node` in [package.json](package.json))
- **pnpm**: `pnpm@10.28.0` (`packageManager` in [package.json](package.json))
- **Rust**: toolchain `1.95` with `clippy` and `rustfmt`, pinned in [rust-toolchain.toml](rust-toolchain.toml)

`node scripts/check-toolchain.mjs` (or `pnpm check`) verifies the installed versions against these floors.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm prep    # runs `pnpm gen`, then `pnpm build`
```

`pnpm gen` regenerates `packages/rpc-schema/generated/*` and `packages/config-schema/fixtures/*`.

## Tests and checks

These are the commands CI runs (see [.github/workflows/ci.yml](.github/workflows/ci.yml)):

```bash
node packages/config-schema/src/gen-defaults.mjs --check   # generated fixtures must not drift
pnpm lint
pnpm test
pnpm docs:check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm typecheck` (and so `pnpm lint`) and `pnpm test` run `pnpm prep` first through their pre-hooks.

For CI layout, job gates and timings, read [docs/ci.md](docs/ci.md). Testing notes are in [docs/testing/](docs/testing/); fuzzing is described in [docs/fuzzing.md](docs/fuzzing.md).

## Generated files

Do not edit these by hand. Regenerate them:

- `packages/config-schema/fixtures/*`, `packages/rpc-schema/generated/*`: `pnpm gen`
- `docs/config.md`, `docs/cli.md`, `docs/rpc.md`, `docs/log-schema.md`, `docs/config-engine-keys.md`, `docs/openapi.json`: `pnpm docs:gen`

`pnpm docs:check` fails when a committed generated doc differs from what the schemas and the CLI produce.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope, for example `feat(cli): ...`, `fix(core): ...`, `docs: ...`, `test(core/a2a): ...`, `chore: ...`, `ci: ...`.
- Commit under the repository owner's identity. Do not add AI authorship trailers or identities.

## Pull requests

- One pull request per work package, with a clear file scope. Write or update tests first.
- Do not force-push, rebase or amend a branch that has an open pull request.
- Do not poll CI in a loop (`gh pr checks`, `gh run`). The maintainer watches CI and merges.
- Known non-blocking jobs: the `reproducible` job in `container.yml` (`continue-on-error`) and the informational `python-host` matrix entries. The `wsl` job is a required, blocking job; see [docs/ci.md](docs/ci.md) for its setup retries.

## Security

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md) and use GitHub Security Advisories.

## Code of Conduct

Participation is expected to follow the [Contributor Covenant, version 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

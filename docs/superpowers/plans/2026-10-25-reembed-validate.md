# Re-embedding migration end to end: the engine's `validate` (engine + Harness)

**Goal.** A memory store with data moves to another embedding model end to end. `plur1bus memory reembed --run` and
`plur1bus config set engine.embedding…` (which starts the same migration, in the foreground or with `--background`) reach
`switched`, and the core restarts on the new generation. Today every run stops in `validating` with
`engine-validate-unavailable`, and the old model stays active.

**Status.** Planned (owner, 2026-10-25: "bitte einplanen"). Two packages, the engine first.

## Why the run stops today

- The engine's coordinator has the step: `validate({ id })` in `lib/reembedding/coordinator.js` checks the source versions,
  validates the target generation (`backend.validateGeneration`), runs the semantic recall probes and moves the record from
  `validating` to `ready_to_switch`.
- The engine's public facade does not pass it on: `adminOps.reembedding` in `engine/create-engine.js` (about line 3745) has
  `plan`, `apply`, `resume`, `status`, `rollback` and `switch`, but no `validate`, and the contract type
  `Engine.admin.reembedding` in `types/engine.d.ts` has none either.
- The Harness is ready for it. `createEnginePort` (`packages/core/src/embedding-migrate/engine-port.ts`) wires `validate` as
  soon as `typeof admin.validate === "function"`; the driver then validates and makes the Harness-owned switch
  (`createConfigSwitchPort`: one `config.set` of `engine.embedding` and `engine.reembedding`). `admin.embedding.check` reports
  `canSwitch` from the same capability, and `plur1bus config set` says before the copy when the run cannot switch.
- No newer engine has it: the pinned commit `98dfe2f0` (7.18.4) is the head of `main` of
  `Cyb3rb1ade/openclaw-plur1bus-memory` (checked 2026-10-25).

## Package E-V1: the engine exposes `validate` (repository `openclaw-plur1bus-memory`)

1. `engine/create-engine.js`: `validate: (...args) => internals.reembeddingCoordinator.validate(...args)` in
   `adminOps.reembedding`, beside `resume`.
2. `types/engine.d.ts`: `validate()` on `Engine.admin.reembedding`, the contract version raised by one minor, the engine
   CHANGELOG entry.
3. Engine tests: the facade reaches the coordinator; plan → apply/resume → validate → `ready_to_switch` with the flat test
   provider; a failed probe leaves the record in `validating` with its reason and never in `ready_to_switch`.
4. Out of scope: the engine's own `switch`/`rollback` (they need a host config-mutation capability; the Harness owns its
   switch) and the post-switch `completed` transition.

## Package H-V1: the Harness takes the new engine (this repository, after E-V1)

1. Pin bump: the commit in `packages/core/package.json` and `pnpm-lock.yaml` through `pnpm install` (never by hand, never a
   range or `link:`), `pnpm docs:gen` for `docs/config-engine-keys.md` if the plugin manifest changed. Check the contract
   range the core accepts.
2. Tests that change from "stops at validating" to "switches": `packages/core/test/embedding-migrate/core-stack.test.ts`
   (real engine, flat embedder; `admin.embedding.check` answers `canSwitch: true`), `engine-port.test.ts`, and an end-to-end
   system test (`tests/system/reembed.test.ts`): `plur1bus config set engine.embedding.local.model google/embeddinggemma-2
   --yes` on a store with data reaches `switched`, the core restarts, `memory recall` answers from the new generation, the
   old generation stays on disk; the same with `--background` and `memory reembed --status`.
3. Docs: the open points in `docs/embedding-migration.md` ("What is not done"), `docs/user/{en,de}/reembed.md` (the
   availability note), `docs/user/{en,de}/memories.md`, CHANGELOG.

## Acceptance

- A store with data moves to another pinned local model with one `plur1bus config set`, foreground or `--background`.
- No mixed vector space at any point; until the switch every recall is answered by the old generation.
- A failed validation leaves the old model active, with the engine's reason in `memory reembed --status`.
- `admin.embedding.check` reports `canSwitch: true`, and the CLI no longer warns before the copy.

## Risks

- The validation probes embed with the target provider: a local target downloads its model during the run (first use), a
  cloud target spends tokens on the probe texts as well.
- A contract bump the core does not accept would stop the core at start: H-V1 checks the accepted range first.

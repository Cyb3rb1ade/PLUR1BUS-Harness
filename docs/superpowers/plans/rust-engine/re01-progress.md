# RE-01 progress and controller decisions

Baseline: harness `05a50d88` (#790), engine
`9f34008c143c5da87b2194b5a28442b407ff8ba7`, A1
`9b935ce1f970bd92a931aa99a58c620669c8085f`. Node reference: 24.21.0.

## Controller decisions, 2026-10-27

- One PR for T1–T4; the controller merges. No CI polling, rebasing, force pushes,
  engine pin changes, or dependency version changes.
- Runtime behavior at the pin is the oracle. The recorder calls
  `validatePluginConfig` from `lib/setup/config-contract.js`, the validation
  used by `resolveEffectiveConfig` on engine startup. Error paths are relative
  to the engine config. Record 30 accepted and 30 rejected configurations.
- An empty `reranker` object is accepted. Use genuinely rejected field values
  for its invalid vectors. The engine has no `recall.hardBudgetMs`; replace the
  proposed budget relation vector with a rejected engine recall field.
- Preserve the pinned config schema's keys, constraints, defaults, and
  `x-contract`. The original package's hygiene exception permits neutralizing
  host-specific descriptions only; `SOURCES.md` lists every changed pointer.
  Runtime differences belong in a separate, tested drift ledger.
- Accept boolean `runtime.traceRegistrations` additively. Its drift test must
  fail when a later pin includes the key in its own engine schema.
- Record schema default `runtime.deferPostTurnLlm = false` and effective Node
  default `true`. A test pins both values so a pin change requires review.
- `RecallTiming.namespacePhases[].namespace` accepts strings and null. Null
  must serialize as null. Track the narrower upstream declaration as drift.
- The three deviations above are engine issues, not reasons to change pins.
  Apply the same tested ledger pattern to further runtime-only keys, default
  discrepancies, or broader values. Stop for removals, renames, incompatible
  type changes, changed recall/capture meaning, or contract/wire changes.
- Try `python3 -m pip install --user cmake`; it succeeded. Include
  `~/.local/bin` on PATH. A blocked build is never reported as green.
- Lockfile clarification: reuse existing packages and versions through workspace
  dependencies. Only lines in the `plur1bus-engine` dependency list may change;
  no package, version, source, or checksum change. A parsed comparison verified
  this restriction. The final PR includes the complete lockfile diff.

## Execution

- Preparatory commit `9bd58d82`: AST contract drift checker and 15 tests.
  The tests failed before the implementation existed, then all passed under
  Node 24.21.0.
- `pnpm test:prep`: passed with the pinned engine installed.
- T1 contract recorder: five raw outputs, reproduced byte for byte on two
  runs. Fixed host clock and recording-process time/random sources; no output
  normalization or manual fixture changes.
- Initial Rust attempt stopped in dependency preparation because cmake was
  missing. After installation the real crate verification was restarted;
  this is not yet a passing result.

## Implementation rulings

- Preserve the Node `StoreAdoptRequest` argument of `StoreOps::adopt`, including
  identity and dry-run fields. The brief's `path, expected_schema` comment was
  shorthand, not a defined trait signature. `AdoptReport` remains the Rust
  alias of the generated result type.
- `embedding.local` belongs to engine configuration. The runtime embedding
  service exposes embed, rerank, probe, identities, and serve; no additional
  runtime `local` method is invented.

Task completion, final verification, module dispositions, and remaining owner
questions are recorded here as they are resolved.

## T1 completion

- Actual crate RED: `cargo test --locked -p plur1bus-engine --test
  contract_roundtrip` failed with missing `plur1bus_engine::contract` after the
  dependency build completed.
- GREEN: all 10 contract tests pass, including five Node payload roundtrips,
  a valid closed input plus an extra key, nullable/empty presence, config wire
  aliases, omitted defaults, and constant booleans.
- `cargo test --locked -p plur1bus-engine`: 57 tests passed, zero failures.
- Drift checker against the installed pin exits 0; its 15 Node tests pass.
- Input limits: all 17 constants and 46 Node vectors recorded and tested;
  `MemoryRow.vector` generates `Vec<f32>`.
- Attribution regenerated with `--reuse-npm`; check uses
  `--reuse-npm --check` to preserve the verified native npm baseline.

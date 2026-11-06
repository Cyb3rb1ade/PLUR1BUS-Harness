# AF2 local validation (PS11)

AF2 extends the existing Core, configuration, discovery and web packages on the corrected AF1 branch. The supervisor slot is a trusted in-process snapshot port: without that port, an enabled flag does not invent a ready sidecar. AF3 supplies its production source and owns sidecar startup and preconditions.

## Implemented boundary

- One Core-owned, keyless adapter and fixed Layout descriptor serve all managed aliases. The reserved provider `apple-fm` is synthesized only while enabled on macOS with a recognized supervisor slot. Inference and discovery additionally require `ready`. `appleFm.enabled` defaults to false, is live, advanced, and writable by owner/admin.
- The guard checks every connection: no symlink in the path, a real parent directory owned by the effective uid with mode 0700, and a real socket of the same uid. A socket mode of 0755 is allowed inside that directory. Refusals never repair the directory or choose another destination. Rust and TypeScript consume the same Layout vectors.
- Discovery uses the same managed Unix boundary and never a credential, proxy, DNS or egress path. It filters `pcc` and unknown IDs before reconciliation, reports `filtered_by_policy` with a count, and preserves the last good catalog under R6 when the eligible list is empty. The anchored `apple` / `^system$` metadata rule fixes context policy at 4096 with tools and structured output; catalog overrides cannot increase it or create managed IDs. Legacy `pcc` catalog rows are hidden.
- Locality uses the exact pair `apple-fm/system`. The model rule is used by chat options, routing, role checks and model probes. All aliases share the AF1 single-inference slot and its existing cross-billing fence.
- Known windows below `MIN_CONTEXT_AGENT_ROLE` (16384) cannot serve agent chat, reasoning, capture or dream work. Configuration checks cover direct references, named profiles and fallbacks, implicit defaults, agent models, and foreground task-class profiles. The existing CLI and supervisor configuration transactions also check saved catalog facts for non-Apple models. Both web chat selection and the older `session.model.set` RPC refuse a small context with its window and floor.
- Allowed decision and summarize calls measure serialized messages and tool schemas using the AF0-derived UTF-16 /3 policy and reserve `maxTokens ?? 512`. Overflow is typed `context_overflow` before transport. The internal small decision role reserves 512 output tokens. Apple summaries send their complete input once; overflow retains rule-triage / deterministic-digest fallback. Live profile getters allow enable/disable after composition without constructing another managed adapter.
- `core.status.providers.apple-fm.transport.unix` contains numeric `ok` and fixed refusal counters only. `ok` counts successful header exchanges, including an HTTP error response; it is a transport counter, not model-quality acceptance. Counters contain no paths, credentials, content or user-supplied labels.

## Checks

An empty live candidate table is rejected before persisting a foreground turn, preserving the existing no-provider behavior.

The focused tests exercise a real Core against the Unix fake, CLI model selection, policy override refusal, disappearing/empty lists, role fallbacks and live enablement. Socket tests cover symlinks, parent modes 0755/0770, a foreign socket uid through the identity seam, a regular file, Windows refusal without filesystem access, and shared path vectors. The German and English fit cases include tools, default and explicit reserves, and the exact bound.

Two source mutations were rejected by the tests: allowing chunked Apple summaries and freezing a disabled role's candidate table. Both sources were restored before the package runs.

Commands use Node 24.21.0, pnpm 10.28.0 and Rust 1.95, with the repository's source-condition runner and resource-limited Cargo profiles:

```sh
pnpm test:prep
pnpm --filter @plur1bus/config-schema test
pnpm --filter @plur1bus/rpc-schema test
pnpm --filter @plur1bus/providers test
pnpm --filter @plur1bus/core test
pnpm lint
pnpm docs:gen
pnpm docs:check
cargo test -p plur1bus-config
cargo test -p plur1bus --bin plur1bus apple_fm_layout_matches_shared_vectors
cargo fmt --all -- --check
cargo clippy -p plur1bus-config --all-targets -- -D warnings
cargo clippy -p plur1bus --bin plur1bus -- -D warnings
node --experimental-strip-types --conditions=source --test --test-concurrency=1 \
  packages/web/test/chat-model-switch.test.ts packages/web/test/models-states.test.ts \
  packages/web/test/models-names.test.ts packages/web/test/models-b20.test.ts
```

Native socket cases use the fake server on POSIX; platform refusal and policy logic are portable. This package does not run `/usr/bin/fm`, accept a licence, or claim the AF3/AF5 live acceptance. No CI was polled.

## Local results

- Core: 11353 tests, 11319 passed, zero failures; 22 existing skips and 12 existing TODOs.
- Providers: 775 passed; configuration schema: 134 passed; RPC schema: 90 passed.
- Affected web model tests: 43 passed.
- Rust configuration: 71 passed; the CLI Layout vector test passed. Configuration and CLI Clippy checks passed with `-D warnings`.
- Root lint: 166 tests, 163 passed and three existing Laya acceptance TODOs; zero failures. Documentation generation/check, formatting and diff checks passed.

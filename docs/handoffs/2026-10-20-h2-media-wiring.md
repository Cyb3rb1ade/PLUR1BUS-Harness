# H2 media wiring — 2026-10-20

Branch `codex/gp4-h2-media-wiring`, managed worktree
`/Users/cyberblade/.codex/worktrees/gp4-h2-media-wiring/PLUR1BUS-Harness`.
Engine H1: [#248](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/248),
contract **1.19.0**, head `f933f3134c1374fa562c02630947052f5dbb95a4`.
Harness Engine pin and `pnpm-lock.yaml` are unchanged. No dependency was added.

## Production path

- `buildEngineConfig` maps the owned `memory.mediaEmbedding` namespace to the
  real Engine media fields. Raw `engine.media` cannot replace the host policy.
  The currently admitted encoder is local Gemma 2, with supported dimensions;
  unsupported selections never silently fall back to another model.
- `createHarnessHost` supplies actual 1.19 codec capabilities before Engine
  construction. ffmpeg frame/PCM requests are translated; source paths are
  rooted under `<home>/media`. Missing decoders remain unsupported-kind.
- Actual `host.fetch` readiness is mandatory. If absent, the projected Engine
  media config is disabled **before construction**. Bootstrap forwards the
  readiness to runtime composition, so a future Engine pin alone cannot enable
  downloads through global fetch. [#602](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/602)
  owns that transport; H2 does not copy its implementation.
- `composeMediaSearch` uses the actual Engine 1.19 shape, not the historical
  1:1/`attachHost` assumption. Host IDs are namespaced by agent/workspace;
  public IDs are recovered only from matching namespaces. Engine ownership is
  trusted agent-private context, never an unvalidated RPC owner tuple.
- OutputStore events resolve the authoritative owner before caption/encoder
  work. A conflicting supplied agent fails closed. Owner-file creation races,
  delete-during-index and late completion cleanup remain supported.
- Prompt/user captions pass to the Engine, which owns ordinary text-memory
  storage. Agent caption settings and modality/enablement overrides are read
  at operation time. Distinct provider/model/dimension overrides are refused,
  because 1.19 has only one shared encoder.
- Human text/example queries search authorized agents, deduplicate by best
  score, and recheck media readability after search. An agent searches only
  its own scope. A like-image seed is sent only to its authoritative scope,
  so another searched agent cannot make a valid seed query fail.
- Global Engine counters are available only to Owner/Admin people. Member,
  Viewer, Operator and agent callers receive unavailable; no global counts
  masquerade as per-agent status. Backfill operations remain Owner/Admin.
- The existing Web Medien tab, provider settings and six RPCs are reused.
  No RPC/config schema was changed; no generated RPC/CLI documentation changed.

## Budget boundary

[#603](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/603) is still open.
This PR imports no pending budget code and has no artificial Draft stack.
`MediaEncodingBudget` is a dependency-free reservation seam: reserve one image
or rounded-up trusted video seconds before encoding; recheck privacy after an
awaited reservation; release an unused reservation if denied; settle a started
encode conservatively on success or failure. Settlement failure is visible and
never silently releases consumed units. Host-only duration metadata is stripped
before calling the Engine.

**Production cloud encoding stays disabled** without actual Secret lease,
privacy admission and image/video-second unit accounting. The seam tests are
not evidence of a #603 binding. Cloud query encoding also needs its token/Secret
admission. Engine 1.19's coarse global backfill budget hook has no per-item
reservation/delivery units; cloud backfill is refused, and the local gate no
longer pretends a one-token check meters images. No paid/cloud calls were made.

## Validation

Node 24.21.0, pnpm 10.28.0; `pnpm install --frozen-lockfile --ignore-scripts`.

```bash
export PATH=/Users/cyberblade/.node24/bin:$PATH
pnpm gen
pnpm typecheck
node scripts/lint-hygiene.mjs
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
  --test --test-concurrency=1 packages/core/test/media-search/engine-119.test.ts \
  packages/core/test/media-search/engine-host.test.ts \
  packages/core/test/rpc/media-search-surface.test.ts
pnpm test
```

- Unit-reservation subset: **4 passed, 0 failed, 0 skipped**, including 2.25
  trusted video seconds → 3 reserved seconds and invalid-duration refusal.
- Final review adapter/RPC/host subset: **29 passed, 0 failed, 0 skipped**.
- Selected production composition/admission/audit subset: **52 tests, 51 passed,
  0 failed, 0 skipped, 1 existing TODO**. Earlier full media/host/config/RPC
  diagnostic subset: **233 tests, 0 failures**, with the inherited engine-config
  Secret-port TODO unchanged. No test was weakened or newly skipped.
- TDD RED → GREEN covered ID/scope/status translation, no Fetch activation,
  invalid vector width disabling, authoritative owner mismatch, caption
  forwarding, model drift/localOnly, reservation order/provider/settlement
  failures and privacy races, global-count privacy and multi-agent seed queries.
- `pnpm typecheck`, hygiene and `git diff --check` pass. These are compile/import
  checks, not native media inference acceptance.
- The full workspace run is recorded below after completion. One unrelated
  failure was observed in untouched `packages/web/test/chat-model-picker.test.ts`
  (`keyboard only: focus the select, arrow to a level; a stale revision reloads
  and says so`): timeout waiting for the stale-model-choice alert. A single
  isolated file rerun reproduces the same failure. No Web source or that test
  was changed. No broad rerun or test weakening was performed.
- No CI polling; external CI state is unverified.

## Known gaps / acceptance todos

- [ ] Controller merges/pins Engine 1.19 and supplies #602 Host Fetch before
  native Harness H3. The current real Engine has no active media API here.
- [ ] Genuine Harness image/audio fixtures, caption-memory recall and image
  query after that pin. H1's real local Gemma measurements are Engine evidence,
  not Harness end-to-end acceptance.
- [ ] Bind #603's image/video-second budget and Secret leases before cloud
  encoders. Tests for that actual binding must prove no request before both.
- [ ] Engine contract additions for distinct per-agent encoders, scoped status
  and scoped backfill. H2 refuses mismatched overrides/global counter access.
- [ ] A licensed Jina catalogue/runtime binding is not activated in Harness;
  no non-commercial license is silently accepted. Florence caption pins and its
  downloader remain the existing TODO; prompt/user captions work independently.
- [ ] Engine 1.19 has one segment interval and caps audio at 300 seconds; it
  cannot represent all independent video/audio settings. It also creates a
  generic caption memory when no caption is provided, including caption-off.

These are explicit contract/dependency limits, not fake production providers.

Future test todos: `media-harness-native` (after pin/Fetch),
`media-unit-budget-binding` (actual #603 reservations/deliveries/Secret leases),
`media-agent-encoder-contract` (after scoped Engine API additions). These targets are additionally tracked by the executed acceptance TODO assertions below.

## Executed acceptance TODOs

`packages/core/test/media-search/acceptance.todo.test.ts` adds **3 new TODO tests**:
actual pinned Engine media API/Host Fetch before construction, production image/video-second
reservations plus Secret leases, and real Harness image/audio indexing, scoped image query
and caption-memory recall. `docs/evidence/media/harness-acceptance-gates.json` records
the actual dependency pin and required Engine H1 contract; missing receipts are `null`.
The contract comparison parses numeric version components; a fake adapter or Engine-only
measurement does not satisfy the receipt assertions. Cloud encoding remains refused.

Node 24.21, acceptance TODO + existing `engine-host.test.ts`/`engine-adapter.test.ts`, with
`--experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1`:
**7 tests: 4 pass, 3 TODO, 0 fail, 0 skip**. TODO bodies executed and failed at the
actual 1.16 contract or missing production receipts, as intended; no import/configuration
failure was masked. Existing passing/failing/TODO tests are unchanged. Supply genuine
receipts and satisfy the assertions before removing TODO reasons. No new native inference,
Engine pin, lockfile, budget binding or dependency is claimed by these tests.

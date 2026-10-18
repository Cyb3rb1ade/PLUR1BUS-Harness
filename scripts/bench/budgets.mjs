// ADR-010 policy is explicit; implementation gaps must remain visible.
export const budgets = [
  ['B1', 'gate', 'p95 < 100 ms', 'macOS arm64, Windows x64; other targets advisory', 'startup.mjs; existing pnpm bench gate unchanged; new job awaits 3 green runs'],
  ['B2', 'advisory', 'p95 < 300 ms', 'all five targets', 'RPC submit to mock fetch dispatch; excludes CLI process startup and provider RTT'],
  ['B3', 'advisory', 'p95 < 400 ms', 'all five targets', 'RPC client timestamp of first delta; mock SSE emits immediately'],
  ['B4', 'advisory', 'p50 < 250 ms; p99 <= 1200 ms; 0 overruns', 'all five targets; real models on reference hardware', '500 fixed seeded synthetic queries; engine timing.totalMs; flat seam explicitly labeled'],
  ['B5', 'gate', 'cache read share >= .90 from turn 3', 'all five targets', '20-turn mock session; cache usage is synthetic and derived from matching request prefix bytes; production-provider acceptance remains separate'],
  ['B6', 'gate', '0 zone-hash drifts', 'all five targets', 'existing two-render/two-process prompt-b6-probe.ts'],
  ['B7', 'advisory', 'alert above 10% token regression', 'all five targets', '20 deterministic tasks; synthetic token accounting; comparison needs --baseline'],
  ['B8', 'advisory', '< 3000 ms without models; < 15000 ms with background warming', 'all five targets', 'startup.mjs; fresh homes; socket and healthy-ready reported separately'],
  ['B9', 'gate', '0 socket/spawn calls during recall assembly', 'all five targets', 'existing b9-no-syscalls.test.ts JS proxy; native syscall coverage is an explicit gap'],
  ['B10', 'advisory', 'RSS below configured ceiling; LRU unload fires', 'reference hardware', 'partial: RSS observation available; two simultaneous embedding identities + reranker/LRU soak not exposed by this runner'],
  ['B11', 'gate', 'core.status p95 < 5 ms', 'existing pnpm bench runners', 'existing gate unchanged; startup.mjs reports 200 calls after 20 warmups'],
].map(([id, policy, target, runner, reason]) => ({ id, policy, target, runner, reason }));

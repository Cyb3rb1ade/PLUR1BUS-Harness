# B1 — Tool registry and tool-call loop

Scope: `packages/core/src/tools/**` (new files beside `repair.ts` and `web/`), plus a narrow, optional seam in the turn loop.
Specs: ADR-001/003 (tool surface, `tools.deny`), ADR-014 §3 (provenance envelope), D19 (provenance), D97 (argument repair), D109 (`policy.decide`).

## Design

- `registry.ts` — `ToolRegistry`: name, JSON Schema of the parameters, description, **policy capability**, effect, **risk class**, per-tool `limits` (timeout, result bytes), optional `classify(args)` (flags/targets/access for the policy), `execute(args, ctx)`. Registration fails closed (bad name, duplicate, unknown capability, risk below the capability's base risk, limits above the hard caps, schema that is not an object schema).
- `dispatcher.ts` — `ToolDispatcher.call({id,name,args}, ctx)` → always an envelope, never a throw:
  1. resolve the tool (unknown → `tool-unknown`),
  2. size-bound and validate the arguments with `validateArgs` (D97; one optional repair round) — an invalid call is never gated or run,
  3. `policy.decide` (deny → `tool-denied`, ask → `ApprovalPort`, refusal/error/abort → `tool-not-approved`),
  4. execute under a hard timeout and the caller's `AbortSignal` (a tool that ignores the signal is still abandoned),
  5. bound the serialized result (over the cap → `tool-result-too-large`, never a partial JSON),
  6. wrap in the provenance envelope (D19), also for refusals and failures.
- `approval.ts` — the `ApprovalPort` interface; the real approval store is another task, tests use a fake.
- Turn loop: optional `toolCalls` dep. Without it nothing changes. With it a provider `tool.call` chunk is persisted, dispatched, and the envelope is persisted as `tool.result`; provider-reported `tool.result` chunks are ignored (the harness executes, the provider does not report).

## Rulings

See the `// RULING:` markers in the code; they are listed in the PR.

## Acceptance → tests

`test/tools/registry.test.ts`, `test/tools/dispatcher.test.ts`, `test/session/turn-loop-tools.test.ts`.

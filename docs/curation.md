# Human memory curation (A4)

The Memory page has a **Curation / Kuration** tab. Choose an agent, inspect a
candidate and choose Keep or Drop. A separate confirmation is required before the
write. A server refusal leaves the record unresolved; the page displays that
refusal and keeps the other Memory tabs usable. Text is displayed as escaped
plain evidence. Refresh retrieves the current queue; if the response is
truncated, resolving entries and refreshing reveals later records.

```
plur1bus memory curation list --agent main --limit 100
plur1bus memory curation keep --agent main mem_0123456789abcdefabcd
plur1bus memory curation drop --agent main mem_0123456789abcdefabcd
```

`--json` preserves the raw RPC result, including unknown future fields. These
commands require a live Core and are never journaled offline. Neo record IDs are
opaque bounded strings, not LanceDB UUIDs.

The experimental Core RPCs are `memory.curation.list({agentId,limit?})` and
`memory.curation.resolve({agentId,id,action:"keep"|"drop"})`. Caller identity is
always derived from the authenticated connection; params cannot name a caller or
a different human. Owner/Admin or a human Member with an explicit `manage` grant
on that agent may use them. Engine record ACLs remain in force. The object grant
is the current own-human proxy; active relationship binding follows in D116 C3.
The methods are forbidden over WebMCP because a model cannot make this decision.

The curation queue is **not** `memory.proposals.*`. The latter is D31 proposals to
correct a shared memory card and remains in the Memories view. Curation resolves
Neo candidate/conflict/stale records through Engine keep/drop, with mandatory
Engine audit.

This phase needs Engine contract **1.17.0**. Until the Controller pin is installed,
requests fail explicitly with `E_NOT_AVAILABLE / engine-contract-unavailable`.
There is no local substitute queue or false successful resolution.

## Required Controller pin acceptance

Before closing #609, the Controller must install the committed Engine pin with
`pnpm install --frozen-lockfile`, regenerate with `pnpm gen`, and run from the
repository root:

```bash
PLUR1BUS_REQUIRE_CURATION_ACCEPTANCE=1 node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/core/test/memory-curation.test.ts
```

This is a required acceptance gate after the pin, not an optional diagnostic.
The real Core transport must report Engine contract 1.17.0 or later and execute
real `memory.curation.list` and `memory.curation.resolve` calls. The check fails
on the current 1.16.0 pin. Ordinary pre-pin tests separately verify explicit
`engine-contract-unavailable`; that passing refusal branch is not acceptance.
Setting `PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE` also makes the contract assertion
mandatory, so a requested source run without its resolver cannot silently pass
against the installed old pin.

Pre-pin source evidence on 2026-10-21: all seven tests passed against Engine
`4c7cf1c359cea02e11f2853a09e551a09810f168` using a temporary process-only resolver;
no committed dependency, lockfile or module resolver was changed. The real test
loads persisted Neo queue fixtures through the real Engine, resolves Keep and
Drop successfully, verifies the promoted/demoted JSONL revisions and mandatory
audit receipts, then restarts the Core and checks that both decisions persist.
Foreign evidence remains hidden and unchanged; re-resolving completed entries
returns not-found without a second audit mutation. The required
post-pin command must still pass against the actual installed Controller pin.

RPC `x-since: 1.6.0` matches the current unreleased RPC surface. ADR-016's A4
implementation record documents the additive-method precedent and the reviewed
release basis. If 1.6.0 is published before merge, bump the minor and `x-since`
together; the Engine contract version is independent.

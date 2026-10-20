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

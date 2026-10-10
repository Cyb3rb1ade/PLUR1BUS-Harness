# Progressive session compaction (M2)

The context view is separate from the append-only transcript (ADR-003, D23).
Messages and tool events are never rewritten by compaction. `SummaryRecord`
contains the original message range; its text is marked as a summary and points
back to that range. Hidden tool pairs point to both original event sequences.

## Work ownership

After a successful turn and its memory capture, `TurnRunner` schedules a
macrotask. The turn promise does not await this worker. The runner owns and drains
scheduled workers on shutdown; Core's abort signal stops model and decision work.
One worker per session may run concurrently; different sessions remain independent.

The worker first checks tool-pair visibility, then prepares a summary if the soft
threshold is exceeded. `summarize` requests offer no tools and preserve the
existing router's admission, breaker and billing rules. Large inputs are split
into bounded stages and merged across tiers. Missing model, unavailable role or
budget refusal uses the deterministic digest. A foreground hard-limit swap uses
an exact matching prepared summary or a digest, never an LLM call. It retains the
checkpoint-before-swap contract, including the incognito exception. Summary rows
are superseded rather than removed; originals remain in the transcript.

The composition additions are isolated in `session/maintenance.ts`; `composition/index.ts` only binds the factory and passes its options. Without a configured `summarize` role the foreground wire request, reply, model selection and tool approval behavior remain unchanged; background preparation uses the digest without invoking a model.

An asynchronous summary is discarded if a foreground swap covered its source
while it was being generated. The context hard limit also applies to unusually
large single messages and model changes.

## Token accounting

The selected model's exact `(provider, model)` entry supplies `contextWindow`
through the read-only catalogue. Possible fallback candidates use the smallest
known window. No catalogue match uses the existing conservative window; a missing
window is not inferred from another provider's model with the same name.

Provider output usage is recorded separately from message rows and preferred
when that exact, unmodified message is rendered for the same model. Clipped views
use an estimate. Input usage calibrates the rendered-input estimate, including
recall, rather than being incorrectly assigned to one user message. Calibration
is stored in `token_calibration`, keyed by provider/model, with EWMA weight 0.2.
The first nonzero sample seeds the factor; zero/invalid samples are ignored and
factors are bounded to 0.25–16. When no usage exists the four-character estimate
is multiplied by the persisted factor. This remains an estimate, not a tokenizer.

## Reversible tool pruning

The worker scans completed `tool.call`/`tool.result` pairs in batches, under one
time budget. The Laya port accepts the current task, original pair data and an
AbortSignal, and returns `{ ref, relevant: boolean, reason }` per pair. Laya remains
the default local CPU backend on Linux, Windows and macOS (D34); compaction adds
no cloud decision backend and downloads no model. The current main branch has no
Laya runtime: a host may supply the existing session service's `laya` port; an
absent port or explicit unavailable/budget result uses the conservative heuristic.
Timeouts and exceptions apply no changes from any earlier batch. Missing/duplicate refs and malformed answers retain their entire batch. Successful decisions commit in one SQLite transaction.

Protected pairs include the last `keepLastTurns` turns, incomplete turns,
references in the latest assistant message, approval/audit/grant/policy evidence,
and explicitly restored refs. Every protection is checked again after an awaited
decision; a foreground running turn invalidates the candidate batch. The heuristic
requires an old, unreferenced pair larger than 1,024 characters. `off` disables
pruning altogether. Hidden pairs become compact placeholders only in the context
view. All retained pair data stays byte-identical.

Visibility is persisted in `tool_visibility`. `ToolPruner.restore(sessionId, ref)`
restores and pins the original; no deletion or event rewrite occurs. `session.get`
adds `compaction.hidden` and original ranges of applied summaries to its existing
inspection response. The full message/event APIs keep returning the transcript.
No new CLI command, restoration RPC or authorization rule is added.

## Configuration and events

`session.compaction` is advanced tier and restarts the Core. Defaults:

| Key | Default |
| --- | --- |
| `softRatio` / `hardRatio` | 0.65 / 0.88 |
| `summaryMaxTokens` / `maxMessageTokens` | 1228 / 819, additionally capped for smaller model windows |
| `summarizer` | `llm` (`digest` also supported) |
| `prune.enabled` | `true` |
| `prune.keepLastTurns` | 3 |
| `prune.decider` | `laya` (`heuristic`, `off` also supported) |
| `prune.maxMs` / `prune.batchSize` | 100 / 16 |

`softRatio` must be less than `hardRatio`; both are strictly between zero and one.
Decision time, batch size and retained turn count must be positive.

D111 registers `compaction.summary.created`, `compaction.prune.hidden` and
`compaction.prune.restored`. Diagnostic attributes contain session/ref/range/tier
metadata only (IDs and counters), never decision text or transcript payload. Summaries and
visibility metadata are distinct from approval/audit records.

## Deterministic verification

The session tests use fake routed models and fake Laya batches. Timer mocks drive
timeout and post-turn scheduling tests; no model download, HTTP request or sleep
is required. Byte comparisons cover the complete original event JSON before and
after pruning, and restart tests cover calibration persistence.

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
time budget. The composition binding uses the shared DecisionClient with
`choice keep|truncate|drop`. Raw pairs force local backend routing. Missing
backend, invalid answers, low confidence, timeouts and exceptions keep outputs;
there is no implicit heuristic replacement for an unavailable production role.
The legacy binary host port remains compatible, and an explicitly configured
`heuristic` uses the existing deterministic rule. This phase installs no Laya
runtime or model. Missing/duplicate refs and malformed answers retain their
entire batch. Successful overlay decisions and metadata traces commit in one
SQLite transaction.
Protected pairs include the last `keepLastTurns` turns, incomplete turns,
references in the latest semantic assistant message, pending follow-up calls,
approval/audit/grant/policy evidence,
and explicitly restored refs. Every protection is checked again after an awaited
decision; a foreground running turn invalidates the candidate batch. The heuristic
requires an old, unreferenced pair larger than 1,024 characters. `off` disables
pruning altogether. Hidden pairs become compact placeholders only in the context
view. Truncated pairs show the first and last 256 output characters plus an
original ref; dropped pairs retain tool name, argument digest and result status.
All retained pair data stays byte-identical.

Visibility is persisted in `tool_visibility`. `ToolPruner.restore(sessionId, ref)`
restores and pins the original; no deletion or event rewrite occurs. `session.get`
adds `compaction.hidden` and original ranges of applied summaries to its existing
inspection response. The full message/event APIs keep returning the transcript.
In an already authorized session, `/compact --explain` shows at most 50 pruning
decisions plus aggregate counters; it does not force a new background pass.
`/compact --restore event:123` restores and pins that session's original pair.
These local transcript commands need no model and perform no recall or capture.
Their administrative replies cannot accidentally make hidden outputs visible
through the semantic-reference protection. No restoration RPC is added.

The saved-token metric estimates the positive difference between original and
rendered character counts divided by four; it is not provider usage. Re-fetch
rate counts explicit restores divided by all pruned overlay rows, including
restored rows. Similar later tool calls are not classified as restores.

## Rewind with a lesson (D120 CX1)

RPC 1.18.0 adds human-only `session.rewind` and `chat.rewind`. Apply with
`{ sessionId, toSeq, lesson? }` (`session.*` also carries the existing CLI caller),
or undo with `{ sessionId, undo: rewindId }`. The session must be idle. Transcript
commands use `/rewind [<seq> | last] [--lesson "..."]` and `/rewind --undo <id>`.
They never reach recall, capture, the model or its cached prefix.

Session schema v10, allocated by the owner on 2026-11-01, adds `path_rewinds` and
checkpoint metadata. Original messages and events remain byte-identical. The
overlay records the last kept sequence, inclusive hidden range, lesson message,
actor, trigger and SHA-256 digest. The digest is over the UTF-8 JSON array of
ordered `[id, text]` tuples. Audit actions are `session.rewind` and
`session.rewind.undone`; no transcript text enters the audit. Undo lifts the hidden
range and hides the obsolete lesson, without deleting either. Nested rewinds are
independent overlays.

Prompt readers, loaded-skill restoration and pruning use the active path. Tools
from a partially discarded turn are excluded too. Applied and prepared summaries
that touch a hidden range leave the view; new summaries never span that hole.
A summary awaiting its model is discarded if the session revision changed.
Undo exposes the original tool-visibility overlays and summaries again. FTS keeps
all original text and marks hidden hits `rewound`; transcript APIs carry the same
flag. `chat.export` separates `messages` from `discarded`.

The stored harness note renders at conversation rank after the kept prefix. This
keeps provider system blocks stable, including on providers that hoist system messages.
Human corrective notes are limited to 1567 UTF-16 code units and preserved verbatim.
Inline file context uses the remaining note budget and may be shortened or omitted;
the original tool history retains the file references. Model-derived text is bounded
without splitting a Unicode code point.
Forks copy an active corrective note at conversation rank too; they do not inherit
the source session's overlay identifiers. The owning M3 transcript reader applies
the same rewind markers after its existing privacy and breakglass checks.

An explicit lesson avoids a model call. Otherwise the existing `summarize` role
and budget distill the selected active range, bounded tool envelopes and final failing
check essence. A trusted system instruction requests a corrective lesson; supplied
transcript text stays untrusted. Already discarded messages and tool metadata stay
out of later lessons too. Artifact bodies, invalid artifact identifiers and full
stdout/stderr are excluded. Missing role,
unavailable model or budget refusal uses a deterministic changed-file/failure
digest. The complete harness note is capped at 400 estimated tokens, using the
existing four-character estimate. Rewind leaves previously captured memory alone;
correct a remembered fact through the existing memory correction/forget surface.

Q13 counts a successful `file.edit`/`file.write` followed by a failing `code.check`,
test-running `exec.run`, or coding gate result. Three consecutive cycles produce
an interactive proposal, confirmed by a human action or `/rewind`. A successful
check resets the streak. `session.rewind.autoProjects` is an advanced, live,
Owner/Admin-written list (default `[]`). Automatic application additionally needs
a trusted unattended turn, kind `card`, a unique active D115 card link, the assigned
agent and the shared worktree binding. The turn runner treats a trusted background
origin on a T0 surface as unattended, including one-shot work; the responsible person's identity does not
mean a person is present to approve. An agent message does not
provide human approval; automatic rewind never restores files.

Q14 leaves files unchanged by default. For a bound D115 card, each model turn
attempts a checkpoint at `refs/plur1bus/checkpoints/<session>/<turn>`. Git uses a
private temporary index, preserving dirty working bytes, staging and HEAD;
untracked files are excluded. Repository filters, hooks, pagers and signing
programs are disabled during these harness-owned Git operations. Capture and
restore use an owner-private temporary Git directory as well as a copied index.
Its highest-precedence attributes disable filters, text/EOL normalization,
encoding conversion and ident expansion, including drivers from included or
worktree configuration. Capture re-reads tracked contents rather than reusing a
cached normalized blob. Split-index dependencies are copied privately; the real
index remains unchanged. An unavailable
checkpoint is logged and `--files` refuses rather than substituting HEAD.
Incognito sessions create no file checkpoints.

`/rewind ... --files` (or RPC `files: true`) requests a T2, single-use
`local-destructive` approval through D109. An unattested local connection (T1)
uses the existing `approval.decide` flow with `attest: true` and OS confirmation
to lift that one decision to T2. Without the helper or confirmation it is refused;
the scope remains `once`. The action binds the session, root,
recorded checkpoint, current working tree and real-index digest. The session is
reserved while approval is pending. Changed files, index, assignment, checkpoint
or session revision invalidate the request before restoration. Only tracked
working files present in the checkpoint are restored in overlay mode; newly
tracked files, staging, HEAD and untracked files are preserved. The approval
lists overwritten paths and newly tracked paths that will be kept, with counts.
The Core computes the list from immutable Git trees; D109 redacts it before
display. A preview exceeding 200 paths or 4096 characters is refused before
asking for approval. A file/directory collision that would overwrite a preserved
path is also refused.
Checkpoint Git children have a 30-second deadline and a combined 32 MiB output
limit. Cancellation and timeout send SIGTERM, then SIGKILL after one second if
needed. Every result waits for `close` before the temporary index is removed.
The file action is audited separately as `session.rewind.files`. Git restoration
and the SQLite overlay are separate operations: a later storage failure does not
roll back an already approved file restoration. Undo is conversation-only and
does not undo a file restoration.

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
visibility metadata are distinct from approval/audit records. The additive
`compaction.prune` session event records ref, mode, confidence and estimated
savings together with the overlay transaction.

## Deterministic verification

The session tests use fake routed models and fake Laya batches. Timer mocks drive
timeout and post-turn scheduling tests; no model download, HTTP request or sleep
is required. Byte comparisons cover the complete original event JSON before and
after pruning, and restart tests cover calibration persistence.

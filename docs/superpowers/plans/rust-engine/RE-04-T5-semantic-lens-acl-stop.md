# RE-04/T5 stop report: Semantic Lens bypasses user ownership ACL

Status: reproduced at the immutable Node pin; narrow Rust correction authorized by the controller on 2026-11-01.

## Scope and source

Harness Node pin: `9f34008c143c5da87b2194b5a28442b407ff8ba7`.
Node 24.21.0, temporary native LanceDB `MemoryDB`; synthetic records only.
The reference checkout is read-only and unchanged. All 37 recorder source hashes
were checked before importing it, and native `engine/store/memory-db.js` was also
compared byte-for-byte with its Git object (SHA-256
`bc2df1ec45fd71669c8c32209fea537b821415bd298efcf232432c0d78ecd1c5`).

## Reproduction and result

The same private agent table contains an authorized base record and a user-scoped
record belonging to principal B. The request has principal A. A valid version-1
semantic-lens index links the base record's community to the other record.
Both records have overlapping ordinary topic words.

This invokes the actual pinned `runMergedNamespaceRecall`, its actual child
`runRecallPipeline`, the actual `createPromptContextAssembler`, and the actual
native `MemoryDB.getById`. Only external collaborators such as the synthetic
embedder, scheduler, emotion state and lease holder are fixtures. The initial
pipeline selection is no longer a fixture in the final reproduction.

| Lens setting | checkAccess on other row | Ordinary result and ledger | Final prompt includes denied row |
|---|---|---|---|
| object absent (default) | denied: acl.user.mismatch | authorized base ID only | yes |
| enabled:true | denied: acl.user.mismatch | authorized base ID only | yes |
| enabled:false | denied: acl.user.mismatch | authorized base ID only | no |

All three recalls return degraded:null. Thus the normal pipeline correctly filters
the row and the later Semantic Lens step reintroduces it. The retrieval ledger
also omits the injected unauthorized addition.

## Source path

- `engine/create-engine.js:429`: the lens configuration defaults to an empty
  object; `resolveSemanticLensConfig` treats that as enabled.
- `engine/recall/assemble-prompt-context.js:575`: the lens callback calls
  `db.getById(memoryId)` directly, without checkAccess. The nearby CRR hydration
  callback does perform an explicit checkAccess.
- `lib/semantic-lens-index.js:166`: tryPick checks lifecycle, epistemic state and
  thematic overlap, then appends the hydrated row without an ownership ACL.
- `engine/store/memory-db.js:1246`: getById reads solely by ID; it has no caller
  principal and cannot apply request ACL itself.

The deployment impact assumes a denied row is present in the agent table and is
referenced by a lens community. The reproduction demonstrates that condition on
native storage; it does not claim to have tested a live deployment or end-user
index creation. Memory import can write request-bound user/workspace rows into
its supplied agent store (`engine/memory-ops/import.js:490` onward), so the render
boundary cannot rely on all rows in that store being authorized for this request.

## Historical stop and required decision

Package G explicitly says to stop/report a Node ownership-scoping finding rather
than silently reproduce or independently fix it. G2 was paused pending a controller
ruling before porting this path: the proposed narrow correction would authorize
every hydrated lens row against the canonical request, like the existing CRR
callback, while retaining default/enabled/disabled coverage. No exception was
assumed at that checkpoint. The authorization below supersedes this pause.

## Historical evidence and recovery checkpoint

- `acl-probe/probe-full-pipeline.log`: three concise observations.
- `acl-probe/evidence.json`: actual raw blocks, host join, calls, and hashes.
- `acl-probe/probe.mjs` plus its adjacent fixture modules: repeat with
  PLUR1BUS_ENGINE_SRC pointing at the pin and TZ=UTC under Node 24.21.0.
- The external probe scripts create and delete only their own temporary native
  database and workspace; all data and principals are synthetic.
- G2 worktree: `/workspace/.worktrees/g2-re-04-t5`, branch
  `codex/g2-re-04-t5-context`, based on main `df525459`.
- At the stop: no G2 commit, push or PR. The port was unfinished, with its first missing-API
  RED test documented in `render-api-red.log`; no completion/gate claim is made.
- Eleven preliminary Node files had 74 cases. The original runtime recorder
  disabled Semantic Lens; that fixture composition had to be corrected on
  resumption. The external probe uses the actual production default and both
  explicit states, and is separate from the provisional render goldens.
- Tracked patch and all untracked task files are backed up outside the checkout
  as `g2-paused-tracked.patch` and `g2-paused-untracked.tar.gz`.

#850 is independent: N1–N5 fix cdaea2fb, normal main merge f7030a97, pushed to
ready PR850 on main; full final six gates green,435 Engine tests passed, and one
fresh independent review reported zero findings. The owner alone merges it after
external re-review.

## Controller authorization, 2026-11-01

The controller explicitly authorized canonical-request checkAccess on every hydrated
Lens row, matching the existing CRR hydration callback. Denial is silent, emits no
row data, ID, ledger entry, log or new counter, and consumes no selection quota.
The authorized base stays present for default, enabled and disabled Lens settings.
Both compression paths are exercised. Only cases whose final output differs from
the pin carry the RE-04-T5-LENS-ACL parity-exception marker; the disabled controls
remain unmarked. The recorder uses the production default, with no forced disable.
The reference Node checkout is unchanged; the controller/owner handles its issue.

The resumed recorder now uses the production default and contains 119 actual Node
cases in eleven files. Exactly four default/enabled security cases (compression
on/off) carry the exception marker; both disabled controls remain unmarked.
The boundary has no logger or ledger port. Focused tests additionally verify that
denied rows consume no quota and malformed/alternate ownership forms stay denied.

This ruling supersedes the earlier pause. Historical reproduction/recovery paths
above describe the stop checkpoint, not the completed G2 branch.

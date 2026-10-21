# Verify and recover the audit chain

The audit chain makes later changes to recorded privileged actions detectable: each line carries the hash of the previous line, a sequence number and the audit record. A separate anchor file holds the sequence and hash of the last anchored end. The German version is [audit.md](../de/audit.md).

It supplements `logs/audit.log`. A successful verification checks the examined files against their available anchor. Someone able to rewrite both consistently can create a different, internally consistent history. Where needed, retain `lastSeq` and `lastHash` from a verification separately from the host. The chain also cannot prove that every action was recorded in the first place.

## Status and permissions

Owner and Admin may read audit metadata and verify the chain. Operator, Member, Viewer and agents do not receive this audit view. A restricted access token also needs the appropriate audit scope.

Open **Logs → Audit** (`#/logs/audit`). The tab loads operational status when opened, but does not automatically verify the chain. After a verification returns successfully, it reloads status; the server cache still applies.

- **Writer health** shows **Accepting audit writes** or **Refusing audit writes**, observation time, last sequence, refusal code and known recovery events. **Refresh health** requests status again; the server-side cache still applies.
- **Pending audit lines** shows counts and dropped rows, with only time, actor, action and refusal code. Targets and details are not displayed.
- Under **Chain verification**, only **Verify chain** starts an explicit check. The result shows the current chain verdict, record/file counts, last sequence, anchor and check time. At most 20 current findings are listed; further findings are counted.
- **Audit eras** shows reported reanchor boundaries and previous chains, including **Valid through seq N**, anchor and first deviation. Missing era metadata is described as unavailable, rather than a verified empty history.
- **Local recovery** explains the CLI preview. The displayed command is guidance; the view does not run reanchor.

Status and explicit verification can fail independently. A status-loading failure does not automatically disable verification. Leaving the tab does not carry its displayed result over as a new verification of another view.

Operational status is cached for up to 30 seconds. It includes the observed state, last sequence, time of the last successful explicit verification, pending rows, and the last observed anchor advancement or reanchor with time and actor. Unknown values are not replaced with invented success messages.

**`ok` is not a full integrity verification.** Status mainly examines the tail and anchor, rather than checking the entire history. A torn write fragment can still exist as separate evidence requiring investigation. The time of an earlier successful verification does not automatically cover later entries.

The running supervisor's JSON status includes audit metadata:

```sh
plur1bus daemon status --json
plur1bus audit verify
```

`audit verify` asks the running core. Findings cause exit status 1. A read or verification error does not establish an intact chain. A successful explicit verification stores its time in a private metadata file; it does not repair chain evidence.

## What a refusing chain means

`refusing`, with a reason such as `anchor-missing`, `anchor-invalid` or `tail-anchor-mismatch`, means the observed end does not permit normal continuation. A missing or damaged file can result from a crash, storage failure or modification. The reason alone does not distinguish these causes.

One special exception is a complete, correctly chained line exactly one step beyond the old anchor. If the previously anchored line still matches as well, the next writer can advance the anchor and records `audit.chain.anchor-advanced`. This does not validate other deviations. The status display itself repairs nothing.

### Configuration can still be saved

If only the chain refuses an audit record for a configuration change, the supervisor can still save the configuration. The record reaches `audit.log` with `chain: "refused"` and `chainReason`; the writer also attempts to queue it in the pending journal. The result carries the warning `audit-chain-unavailable`. This warning means neither that saving failed nor that audit coverage is complete.

If `audit.log` cannot be written, or the chain has another storage error, saving still fails. The exception applies to this configuration path; it does not generally permit privileged actions without audit. An audit record with phase `prepare` records preparation of a change, not proof by itself that the change completed successfully.

Pending rows are not yet protected by the chain. The journal is bounded to 10,000 lines and 8 MiB; overflow removes the oldest rows, counted as `pendingDropped`. Queuing can also fail after the record reached `audit.log`. An empty pending list therefore does not establish a complete history.

Once the chain accepts appends again, a successful Rust audit append attempts to drain waiting rows in their original order. They retain their original event time but appear later in the chain. A crash can cause a duplicate late append. Reanchor alone does not establish that the journal has already drained.

## Reanchor is a local CLI operation

Before further writes, preserve the available evidence privately and consistently: chain files, anchor, `audit.log`, pending journal, and any `.torn-*` and `.pre-reanchor-*` files. A normal installation backup excludes `logs/`. Do not edit the chain and anchor by hand or delete old evidence to make verification pass.

First preview the operation for the same home:

```sh
plur1bus audit reanchor --reason "Anchor lost after investigated storage failure" --dry-run
```

It shows the finding and files to set aside without changing the chain. If normal appending is possible or the next writer can heal the state, the command reports `nothing-to-repair`. A temporary lock problem is not a reason to start a new era pre-emptively.

Only after reviewing the finding, run the same reasoned command without `--dry-run` to start a new era:

```sh
plur1bus audit reanchor --reason "Anchor lost after investigated storage failure"
plur1bus audit verify
```

Reanchor works directly on local files and needs no running core. Run it as the operating-system owner of the installation; the Web Admin role alone does not grant that access. On Unix it checks the private log directory; on Windows, file ACLs provide the guard. The command coordinates with a running core through the audit lock. The following `audit verify` request needs the core to be reachable again.

The previous chain files and anchor are set aside unchanged with `.pre-reanchor-<time>`. The new chain starts at sequence 1 with `audit.chain.reanchored`: actor, shortened and redacted reason, old anchor and end, first deviation, and references to the old files. Do not put secrets in the reason. There is no Web reanchor button.

## Read eras and repair results correctly

Verification separates the current era from previous chains. For each set-aside chain it counts only the prefix up to the first deviation. An intact new era does not undo that earlier deviation. `announced: false` means no matching reanchor event in the current chain names that file group; this can happen after a crash between renaming files and starting the new chain and needs investigation.

The next writer preserves a torn write tail as `.torn-*`. This is retained evidence, not a reconstructed complete audit row. A subsequently intact chain, `1staid repair` or a reanchor confirms neither the fragment's contents nor the completeness of earlier records.

Next: [Status and logs](diagnostics.md), [Operations](operations.md).

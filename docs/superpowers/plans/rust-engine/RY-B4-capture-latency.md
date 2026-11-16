# RY-B4 — Capture latency and Neo publication

Open one PR after RY-B2. Merge before RY-C and RE-11 remove the Node reference.
Close the named RE-09 T4 exception when the Release Rust capture median is at
most 1.5× the pinned Node median on macOS and Linux. Repeat the 20-pair
comparison in quiet windows with fresh and populated homes. Keep the Recall
and capture recovery gates. [RY-B2 capture baseline](../../../evidence/ry-b2-capture-baseline.md)

## Cost as shipped in RY-B2

The final macOS pair with Pi active measured Rust 527.5 → 2,304.6 ms and Node
58.8 → 64.1 ms from fresh to 4,000 added Neo rows. These are warmed Release CLI
medians with sync enabled. Both homes kept the same Lance workload. The
section timings below are from the matched pre-optimization Rust A/B with
sync bypassed in both legs. Subsections share work and their times overlap.

| Rust stage or subsection | Fresh | +4,000 rows | Work tied to history |
|---|---:|---:|---|
| Neo journal | 125.9 ms | 1,234.2 ms | Under the workspace lease, reads and parses existing `turn-journal.jsonl`, `memory-candidates.jsonl` and queue data for preflight and replay. Source writes normally append and repair torn tails. Caps read, hash and parse source files, and replace them at retention boundaries. Caps across Neo transactions were 49.4 → 616.4 ms and journal preflight was 10.0 → 207.0 ms. |
| Journal projections | 9.6 + 9.7 ms | 131.3 + 171.5 ms | Reads and rewrites `native-append-history.json` and `record-index.json`. Reads and merges existing `candidate-index.jsonl` with live candidate revisions, then replaces the projection when it changes. The first two columns time append-history and record-index work. |
| Episodes and session checkpoint | 28.8 ms | 142.0 ms | Verifies journal/cap state before appending to `episodes.jsonl` and replacing the checkpoint. The synthetic seed adds no historical episodes. |
| Embedding drain | 112.6 ms | 770.6 ms | Reads the queue and target generations, checks caps and live IDs, prepares a recovery plan, publishes the vector sidecar and `vector-index.json`, appends target/queue status, and rewrites `candidate-index.jsonl` and `record-index.json`. Preflight was 24.8 → 315.8 ms, the plan and projection spans 29.1 + 10.9 → 313.2 + 220.7 ms. |
| Admission and Neo workspace pins | 63.0 ms | 74.0 ms | Resolve and verify pinned owner/workspace bindings around publications. Admission saves were 18.3 → 19.0 ms. |

In the paired populated probe after the CPU changes, with sync still bypassed,
the journal took 1,105.4 ms and the drain 663.3 ms. The subsequent sync
consolidation reduced engine `F_FULLFSYNC` calls from 57 to 51.

## Reference behavior at Node pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`

- `lib/neo-worker-runner.js` calls the Neo capture store in `lib/neo-arch.js`.
  It appends deduplicated turns, candidates, episodes and pending queue work
  where those records apply. Normal candidate index updates append projections.
  Retention can replace capped files. The pin reads queue history, hydrates and
  writes `record-index.json`, and publishes target/vector updates during a drain.
- `engine/capture/capture-turn.js` disables drain inside the capture worker. The
  main Node thread retains the provider and, when enabled and enough capture
  budget remains, awaits a drain in the capture task's `finally`. The drain
  bounds count and time, leaves unfinished work pending, publishes the new
  vector and target state, then appends the queue status. A later capture or
  the embedding-drain job can process outstanding work. Both test homes
  processed two items before completion on every timed capture.
- The Core waits for the capture handle. Right after a successful stored
  response, normal recall can find the committed Lance row under its ACL and
  retrieval filters. Neo semantic recall can use the new vector once its
  publication is visible. A deferred item can leave a new Neo record without
  a fresh vector even after a successful capture. Add an immediate recall
  oracle for both completed and deferred drains before changing this contract.

## Design choices to measure

| Approach | Estimate | Failure boundaries to test |
|---|---:|---|
| Append source rows and update projections from verified offsets | 4–6 agent days | Crash mid-row, after source sync but before the projection watermark, and during cap or archive replacement. Verify cursor invalidation after a Node writer, stable IDs on replay and retained dedupe evidence across caps. |
| Drain after the reply from a durable queue | 3–5 agent days | Crash between source and enqueue, between durable enqueue and ack, and after each of vector, target and queue publication. Revalidate owner/workspace and model on resume. Measure oldest pending age, drain throughput and immediate recall under a backlog. |
| Combine the two | 7–10 agent days | Use the verified source generation in queued work. Cover cap, model switch and concurrent Node/Rust access during replay. Measure each change in isolation before accepting the combined result. |

## Can a file be rebuilt after power loss from the turn WAL?

The Rust turn WAL stores turn and Lance row IDs for duplicate suppression and
rollback. Capture admission temporarily holds the input and recovery state
until completion. Neo prepared files contain their own plans. Existing tests
exercise process kill and reopen with these plans present. Power-loss rebuild
after a successful capture still needs evidence for the owner's durability
decision.

| File class | Evidence available at RY-B2 |
|---|---|
| Neo source journals (turn, candidate, queue and other capture rows) | The turn WAL lacks source row bodies. Journal tests replay a prepared Neo plan after the first durable append and re-sync a visible row from an interrupted append. |
| Episodes and session checkpoint | The separate episode plan preserves revisions and the next checkpoint. Tests kill before and after checkpoint publication. The turn WAL has neither the revision nor the checkpoint. |
| Vector bytes, manifest, target/queue progress | The embedding plan validates the prefix and replays the prepared suffix through five SIGKILL boundaries. The turn WAL has neither the vector bytes nor the generation and queue transitions. |
| Derived candidate, record and append-history indices | Live source rows provide material to reproject live entries. The older dedupe and candidate history kept past retention cannot be inferred from those rows or turn IDs. A rebuild needs a surviving projection, archive or equivalent retained history. |
| Lance data and manifest | The turn WAL identifies rows for rollback or duplicate suppression. It has no copy of their text, vectors, fragments or manifest. The timed traces observed a Lance commit per capture and zero explicit table syncs for both engines. |

Establish recovery from actual lost or torn persisted files for each class
before proposing a new durability guarantee. Keep that decision outside RY-B2.

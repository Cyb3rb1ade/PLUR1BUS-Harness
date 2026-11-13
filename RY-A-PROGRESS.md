# RY-A progress

Branch `codex/ry-a-rust-engine-jobs`, based on A0 `3994f2fe6e`.
This is the restart checkpoint. Read the RY plan and the 2026-11-13 addendum in
`/Users/cyberblade/worktrees/reviews/` before continuing. Use this checkout for all changes.

## Rulings

- RE-D177: Use the owner's explicitly named A0 head while #908 is open. The starting
  `origin/main` (`ee3fc2d41a`, RX merge) is already an ancestor. Integrate later main
  by merge. Open the single ready PR at the end as requested.
- RE-06 T0: #903 reports 15/15 Node and 15/15 Rust. Re-run RE-09 on the A0 base
  before starting T2. A1 repairs the known baseline Dreams exit assertion.

- RE-D178: A refused step leaves the active migration's lease alone, even if its
  request names that migration. Only the accepted operation can settle its lease.
  If the Core gives up after a refused request, expiry resumes compaction.

## Tasks

- [x] A1.1 Align invalid Cron with `E_INVALID_PARAMS` (exit 2). Syntax check
  passed. Runtime checks against both engines follow the local build.
- [x] A1.2 Move the compaction lease into the coordinator's exclusive operation.
  Regression coverage checks unrelated IDs, bad proofs, and release after an admitted
  source-drift failure. Targeted Rust run pending the local build.
- [ ] A1.3 Distinguish transient shared-memory failures from unsafe roots.
- [ ] A1.4 Initialize the store base under the single-instance lock.
- [ ] A1.5 Explain the job session cap.
- [ ] A1.6 Verify the Core Dreams capability gate at the composition boundary.
- [ ] A1.7 Document backup retention's upper limit and missing directory warning.
- [ ] F12 Turn metadata seam and F13 principal binding source.
- [ ] RE-06 T2 prompt layer and LLM routing, S8.
- [ ] RE-06 T3 maintenance and C5.
- [ ] RE-06 T4 reflection, S6 and A1 importance staging.
- [ ] RE-06 T5 skill mining.
- [ ] RE-06 T6 dreams, S2b, S7 and C6.
- [ ] RE-06 T7 job parity, background read inventory and local acceptance.

# F2 Windows validation request

Scope: main-based A/B fixes and C measurement, separate from WP6 PR #87.
No `.github/workflows` file is changed in this branch. Request to the owner of
the workflow area (PR #99 is already merged): provide dispatch-only, Windows x64 `windows-2025` acceptance jobs
that check out this PR's exact head and run the commands below after the normal
Node 24.21/pnpm 10.28/Rust 1.95 setup, frozen install and desktop UI build.

```bash
node apps/desktop/scripts/windows-flake-loop.mjs spa 20 "$RUNNER_TEMP/f2-spa"
node apps/desktop/scripts/windows-flake-loop.mjs startup 30 "$RUNNER_TEMP/f2-startup"
```

Run the SPA loop separately with cookie guard `on` and `off`. Retain both output
directories as artifacts even on failure. Allow about 110 minutes for SPA loops
and 65 minutes for startup loops; these are repetition-job limits, not increases
to any child's deadline. The loop builds SPA fixtures once, uses fresh private
homes per iteration, counts every failure and never reruns an iteration. Startup
runs execute the entire startup-test file with fresh helper profiles and the production 12s batch cap. The ordinary
native signature test has an injectable 40s cap, while this acceptance loop
explicitly restores 12s. The overall diagnostic cap stays 45s. Timing evidence is
mandatory, so a skipped test cannot pass the loop.

Acceptance: all requested iterations complete, zero failures, and all seven
normal desktop matrix jobs pass on the exact same head. Preserve run URLs and
commit SHA. Inspect every SPA phase's `teardown[].scanMs/cookieMs/filesRead/bytesRead`
and `milestoneTimings`, plus each startup iteration's `startup-timings.json`.
Do not infer percentile reliability from fewer than the requested runs.

A: cookie DB inspection precedes the deadline-aware scan. Five seconds remain
shared between the phases; total cleanup stays 10s with its 1s delete reservation.
A scan timeout is an incomplete audit, never clean evidence. Positive findings
survive incomplete scans. No audit retry is added.

B: Reflection.Emit creates interop methods in memory, replacing Add-Type/csc.
Every helper phase has monotonic milliseconds. Native PowerShell 5.1 runtime
validation must confirm the emitted signatures; macOS parser tests do not prove it.

C: fixed milestone records contain only stage, monotonic t_ms and nullable signed
HRESULT. Environment/controller timestamps are observations after Tauri exposes
those objects, not internal WebView2 callback timestamps. Creation/navigation
stage caps reuse the initial open's existing 30s cap, retirement its existing 15s;
the 80s total ceiling stays fixed. Repeated/late milestones cannot extend it.
No WebView2 creation retry or product workaround is included; decide from data.

D remains on PR #87: its lifecycle/single-instance fixture is absent from main.
Do not duplicate WP6 here. Keep #87 Draft pending owner-confirmed #118 merge,
normal main merge, its local c095cc9b and strict x64 CI proof. ARM VM acceptance
is performed manually by the owner before D1 release.

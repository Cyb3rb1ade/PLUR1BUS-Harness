# M1 CI Corrections Implementation Plan

> **For agentic workers:** Use the systematic-debugging and test-driven-development workflows. The Owner has authorized execution on the existing M branch.

**Goal:** Resolve the new failures reported for PR #815 at `aa379bdc` without concealing unverified platform behavior.

**Architecture:** Preserve the readonly source port and selected-root confinement, private worker handoffs, and cold import rollback. Fix test setup and CI preparation at their owning boundary.

**Tech Stack:** Node 24.21, TypeScript, Rust 1.95, Python unittest, Playwright, GitHub Actions.

**Spec:** Owner addendum M1, 2026-10-29, items 1–9, supplied as pasted request; the original M v2 plan and its boundaries remain in effect except for the explicit M1 exceptions.

## Constraints and review focus

- Same branch and PR; additive commits, no rebase, amend, force-push, CI polling or merge.
- Engine, Core Engine adapter and WebMCP remain unchanged. No uv producer, PATH fallback, advisory waiver or manual Darwin attribution edit.
- M1 authorizes the existing `browserSkip` convention in the three new browser suites, with browser-required mode preserved.
- M1 authorizes generation before Desktop tests in both named workflows and printing failed WSL detection output.
- Exercise filesystem aliases and roots on different Windows volumes without granting remote free-path access.
- Preserve root confinement and limits after canonicalization, including symlink/junction escape and UNC paths.
- Exercise stdin installation under CI's ordinary umask rather than relying on a private inherited umask.
- Report structured worker failure reasons without raw stderr, source contents or secret values.
- Keep real browser assertions, accessible names and asynchronous request completion meaningful.

## Work items

- [x] A1: Reproduce local-reader volume restriction; support native drive and UNC roots with one shared budget. Verify selected readers remain confined.
- [x] A2: Reproduce root alias mismatch; canonicalize both configured root and selection, and canonicalize native fixture roots. Run readonly/import/SFTP maintenance tests.
- [x] A follow-up: Recheck Windows MCP fixture imports, leased process setup and Core wiring; use portable ESM file URLs where required.
- [x] B3: Reproduce stale RPC fixture failures in Python/Hermes; update the four fixtures' RPC fields to the schema version and add a version consistency assertion.
- [x] B4/B5: Apply only M1's browser availability convention and use the existing setup skip helper; retain browser-required failure behavior.
- [x] C6: Reproduce stdin install with its actual CI conditions, fix the private spool boundary, and verify success/refusal cleanup.
- [x] C7: Add complete run diagnostics and safe worker reason logging, reproduce manual rollback under CI-like permissions/concurrency, and change lifecycle behavior only if a cause is demonstrated.
- [x] C8: Fix duplicate landmark names and precise browser locators; await discovery and choose a source format explicitly. Retain signer/key disclosure and all import safety assertions.
- [x] D9: Generate schemas before Desktop tests; exercise packaging/snapshot tests and failed WSL output handling.
- [x] Integration: Run affected package suites, generators, lint, docs checks and Rust checks; review the M1 delta independently; prepare the German evidence for #815. Keep pending Owner decisions and native/browser limitations explicit.

## Verification findings

Checked work items have local code/test evidence; they do not claim native Windows, WSL, macOS or browser acceptance.

- The stdin failure reproduces under umask 0022 and is a private-directory creation bug, not loss of the independent UUID inspection spool.
- A deterministic native progress-file replacement reproduces a held-runtime authentication race. Its fix retries at most three verified regular-file replacements and retains immutable job checks; a changed plan still refuses release. The original one-off full-run SFTP failure was not conclusively attributed.
- The shell browser test waited for temporary lazy headings. It now waits for the loaded page headings while keeping navigation, focus and document-title assertions.
- A main-equivalent approval fixture configured its memory keyring at suite registration. Per-suite setup and guaranteed cleanup pass all eleven assertions with and without seeded parent variables.
- The SFTP deadline fixture also mocked native cleanup timers. Restoring real timers after triggering the deadline preserves every timeout/release/zeroization assertion; fixture cleanup is now a test hook. The full package passes 35/35 under umask 0022 after that fix.
- Main 5df6c5df was merged normally as 918807ab; its only additional change is the four-line macOS RPC socket test fix. The four trust tests pass.
- Idle maintenance-mutex contention incorrectly rejected valid public config writes. A typed admission guard now preserves maintenance/config/state lock order and all active-import fences; 47 integration tests pass.
- Core shutdown keeps its full nominal allowance when it is the first stopped child, as ADR-012 requires. The hard deadline still starts at request acceptance; deterministic timing and unchanged exact integration assertions pass.
- Independent reviews of the M1 delta and the held-runtime correction found no actionable issues. Native platform/browser outcomes and the initial SFTP failure attribution remain explicit evidence limits.

## Shared interfaces

The source-reader task supplies canonical paths to the native import fixtures. Native rollback tests wait for that reader build before measuring the completed run. The stdin and rollback tasks share Cargo artifacts and serialize compilation. Web fixes are independent of these paths. Root owns workflow/RPC changes, staging and commits.

Final local verification: full pnpm run 18,270 tests (Core 10,901 pass/0 fail; blocked WebMCP and local Chromium failures recorded), current remote-fs rerun 35/35, Rust 3,548 pass with only the three Owner-listed host failures and three existing ignored tests, current release system 15/15, fmt/Clippy/lint/docs checks successful. Browser-required mode still fails without the pinned browser. No overall acceptance is claimed.

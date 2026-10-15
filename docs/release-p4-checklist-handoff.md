# Release phase 4 — evidence checklist and docs (2026-10-15)

Builds on #527 / #524 / #522. Main refreshed by normal merges between phases; no rebase/force/amend/stash.

## Inventory / decisions

- `docs/release-checklist-v0.1.0.md`: all 14 original §6.2 items, explicit fulfilled/open/manual vocabulary,
  evidence and remaining gaps. Historical token-attribution wording is interpreted under the later binding
  ADR-004 amendment; no milestone criterion is silently removed or weakened.
- `scripts/release/check-checklist.mjs`: validates IDs, table/machine-status agreement, statuses, local evidence
  existence and repository boundaries. Fixed local-check registry; no shell commands from Markdown and no
  remote CI polling. A URL is not green evidence. `--run-local` actually executes local checks; `--strict`
  fails while anything remains open/manual. Structure-valid never implies release-ready. The advisory step runs after local evidence checks so existing advisory failures do not prevent their collection; it still fails the job.
- `docs/release-documentation-audit.md`: README, five-platform quickstart, admin/user handbooks, providers,
  models, channels, import, architecture, ADRs and known issues inventoried; small navigation gaps closed by
  bilingual native quickstarts/admin index, larger content/human review tasks explicitly retained.
- `docs/milestones.md` M8 reconciliation dated 15.10.; no acceptance/effort/scope estimate promoted. Release/README
  link the checklist and known issues. Quality workflow validates evidence and executes its local registry.

## Validation

macOS ARM / Node 24.21: checklist integrity/false-green regression tests 2/2; fixed local registry passes
(backup crypto/rollback, strict source options, retired theme bridge regression, attribution drift). Output:
12 open, 2 manual, `releaseReady: false`; strict mode exits 1 as intended. Document links and CLI examples pass.
Full docs check initially exposed a macOS temp-directory alias in the existing bundle CLI space-path regression. Canonicalize only that test fixture path (per the platform-test exception); it still asserts a stale bundle fails under a path with spaces. Product handling of symlinked script entry paths remains with Web ownership. Final full docs check passes (generated docs, links, commands, bundle regressions and exit-code documentation); full lint passes (99 regressions), release-script tests and actionlint pass; no native Windows/Linux or true reboot claim.

The optional source-wide TS run was terminated after actual existing Web failures and a Web worker hung
for over 14 minutes (after a recurring-task double-click test hit its own 120 s timeout). It is failed/incomplete,
not a whole-suite pass. No test was skipped/retried or timeout increased to hide it; no Web product code changed.

## Gates / owner questions / KNOWN-GAP

No existing gating promotions, branch-protection changes, GitHub merges, tags or releases. All release criteria
remain open/manual at overall level. Audit policy is implemented and covered by eight regressions: production
High/Critical block, development/lower severities warn, owner-only exceptions expire within 90 days. The live
audit remains red with 11 blocker rows and no collection errors; see the phase-3 handoff/evidence. Owner questions:
required checks/code-owner branch protection, runner bwrap/tool installation, native ARM runner availability; real reboot/keyring/ACL records and final release approval.

Conflict hotspots: M8 status paragraph, README/release entry links, release-quality workflow. Desktop (#504),
Web-a11y (#497), sandbox and other package implementations untouched. The checklist points to their evidence needs
without claiming those external packages are accepted. No CI polling; only the first own #522 result set was read,
and its new native Python fixture failures received a test-only follow-up in phase 1 and normal merges forward.

Phase 2 follow-up also wires the existing real-model/reranker/restart acceptance to every native leg; the local real-model attempt and native results are reported separately. No assertion/timeout in that existing acceptance test is relaxed, and it is not conflated with the installed-runtime flat smoke. The first own flat smoke results for Linux x64/ARM were successful, not three stable runs and not full T6.

Additional local macOS ARM proof: existing real-model two-session/reranker/restart acceptance passed (1/1), and the installed-home Fresh-Home smoke also passed with real models (1/1, ~57 s). Flat mode passed after adding the same restart path. Five native green T6 outcomes and three stable runs still are not evidenced.

Native update fixture suite: 7/7 and focused Clippy with warnings denied pass locally; the workflow runs it on all five targets. Real macOS launchd lifecycle: 2/2 pass, including restart of a killed supervisor and registration/status/removal, with temporary service names cleaned. No admin operation was used locally. True reboot and other native OS outcomes remain open. Full installed-home flat smoke also passes with the new binary-removal assertion.

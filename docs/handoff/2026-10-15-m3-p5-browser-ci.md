# M3 Phase 5: browser CI and conformance

Preparation base: `origin/main` at `4557176c`, branch `codex/m3-p5-browser-ci`. Predecessor phases must be merged normally before opening the stacked Phase 5 PR and running final integration checks. No CI polling, new dependencies or engine changes.

## Inventory and decisions

- Ubuntu `web-browser` job builds Core/current-branch CLI with the pinned Rust toolchain and requires the real transport/account tests (`PLUR1BUS_WEB_TRANSPORT_REQUIRED=1`, absolute binary path). It installs Chromium using the exact Playwright CLI from the frozen lockfile (1.63.0). Required mode fails if that browser is missing; it never silently uses system Chrome. The whole web suite runs.
- First commit `175969ea` adds the job as informational. Gate activation belongs to its own subsequent commit after the repaired local baseline passes.
- The shipped-page matrix derives all 22 roots from `PAGES`: both themes, four widths, 200% browser reflow, and 200% CSS-zoom enlarged text (264 cases). New registry pages inherit the matrix automatically.
- `main[data-page]` identifies a committed route; the fixture waits for that route and for all loading states to finish. Doctor can render two independent loading regions, so the wait checks their count instead of using a strict single-element locator.
- Compact targets: Home links (39px), Inbox chips (32px), Help table-of-contents links (35.6px) are now at least 44px. Normal/wide sizing remains at least 24px.
- Target measurements follow the [WCAG 2.5.5 Inline exception](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) only for actual links embedded in a prose paragraph. Standalone paragraph links, navigation links and controls are measured. This is semantic classification, not a route exception list.
- Approvals/grant revocation restore focus in `useLayoutEffect` during the first result DOM commit. A MutationObserver regression test deterministically failed before the fix and passes after it; the user never loses focus to body while the old card disappears.
- Recurring initializes the agent-loading promise in `useLayoutEffect`, so a confirmation in the first interactive frame waits for discovery rather than being discarded. The original native-double-click and keyboard tests reproduce the failure. Shared fixtures now implement `agent.list` and correctly separate system/agent history.
- Skills/Plugins list buttons reset the browser's light default button background. This fixes serious dark-theme contrast failures on loaded titles and badges; the existing German axe test now runs in both themes.
- Models' malformed-percent-escape test now requires the router's existing fail-closed 404 and absence of the model surface/actions. Incomplete model segment counts retain their no-selection assertions. No timeout was increased.
- Three former Identity todos are active regression tests: the channel starts empty with suggestions from linked channels, successful requests clear an old error, and removal buttons identify their row. The existing Owner flow explicitly chooses its channel.
- The Voice event-before-response regression waits for the one completion refresh and the late RPC response. Its previous fixed pause compared the count before the scheduled initial refresh ran; now it asserts exactly two total loads and no further application. No product deduplication was weakened.
- The macOS unit lint step gets a 4096MiB V8 heap. There was no explicit 2048MiB or informational lint configuration in this preparation base; the local Mac can validate the check, not the hosted runner's memory behavior.
- Demo and milestones record fixture evidence separately from served-stack evidence. OIDC remains after M3; engine erasure remains outside this package.

## Threat table

| Attack or failure | Protection | Test/evidence |
| --- | --- | --- |
| Missing browser makes a green vacuous run | Required mode rejects an absent pinned browser | `browser-required.test.ts` proves a missing pinned browser fails even with an existing override; CI sets the flag |
| Unrelated system Chrome gives misleading results | Required mode selects only Playwright's browser path | `harness.ts` selection contract; frozen install plus package CLI |
| New shipped page escapes conformance checks | Matrix uses the production registry | `shipped-conformance.test.ts` |
| Small targets make touch activation difficult | Compact min-size fixes | Shipped-page 400/960 and zoom cases |
| Removed decision card drops keyboard focus | Focus restored within DOM commit | `approvals-audit.test.ts`: first-commit observer |
| Malformed URI reaches a model action | Existing router denies malformed encodings before dispatch | `models-states.test.ts`: 404 and no detail/actions |
| CI installer credential leaks into browser tests | Engine access variable and Git config remain scoped to dependency step | Workflow inspection and actionlint |

## Validation ledger

- Node 24.21.0, pnpm 10.28.0; frozen offline install succeeded, matching Playwright Chromium installed locally.
- Initial a11y/contrast/responsive/patterns baseline: 52 passed, 0 failed, 0 skipped.
- Before-fix repro: Home/Inbox/Help compact targets failed; approval first-commit observer failed; malformed model encoding test timed out against the old expectation.
- After-fix focused Home and Help runs each passed 10 cases without skips. The original matrix plus Models/Approvals regression runs passed 263 tests; all 44 shipped-page CSS-zoom cases passed separately. The required-browser guard passed, and the Skills/Approvals/Jobs file passed all 15 cases after the loaded-button contrast fix. Complete repaired-suite results are recorded below after that run finishes.
- `node scripts/check-toolchain.mjs` passed. `actionlint` passed for the modified workflow; hygiene passed. TypeScript check with the 4096MiB heap passed on the local Mac after fixing the new test's DOM NodeList iteration.
- Served-stack browser acceptance: all three tests passed with the current-branch CLI and built Core (real accounts/invite/password/disable, real transport, and CLI/media/collab surface integration), zero skips.
- Hosted Ubuntu/macOS CI results and native accessibility are unverified; CI was not polled.

## Owner questions, hotspots and known gaps

The inline-prose exception follows WCAG itself. If the owner intends a stricter rule for inline article links, that would require a separate reading-layout decision; navigation and controls meet the numeric minimum here.

Hotspots: `.github/workflows/ci.yml`, web `app.ts` (only a route-state attribute), browser `harness.ts`, Approvals page, and page-specific Home/Inbox/Help/Extensions styles plus Recurring initialization and fixtures. Predecessor merges may touch the harness and UI pages; merge normally and rerun the full browser suite.

Three Identity todos in `surfaces-hardening.test.ts` are now active and passing. Existing `settings-known-gaps.test.ts` todos remain explicit (unsaved navigation, long QR payloads, rights panel and schema sensitivity metadata). They are not page accessibility suppressions. The pre-existing `budget.set` server-policy todo also remains; this UI/CI phase does not change the core security policy. No newly failing a11y or responsive case is allowlisted or marked todo. The demo's served bootstrap, TLS/pairing, saga/licence and real HTTP authorization evidence is completed by the corresponding phase handoffs; browser mocks do not establish those claims.

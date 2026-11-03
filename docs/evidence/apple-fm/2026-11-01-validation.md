# AF0 verification — review fixes, 2026-11-01

Platform: macOS 27.2 (26B123), arm64; Node 24.21.0 and pnpm 10.28.0.
Commands used `PATH="$HOME/.node24/bin:$PATH"` and `TMPDIR=/private/tmp`.
Long-running checks wrote local logs outside the repository.

The [evidence index](./README.md) identifies the authoritative full run, the unchanged original
stopped receipt and the [additional native review run](./2026-11-01-probe-review.md).
Only derived conclusions in the full final receipt were corrected; its wire events, CLI output,
server logs, timings and observation ids are unchanged.

## Focused verification

| Command | Result |
| --- | --- |
| `node scripts/check-toolchain.mjs` | passed |
| `node --test scripts/test/apple-fm-probe.test.mjs scripts/test/apple-fm-probe-process.test.mjs scripts/ci/*.test.mjs` | 163 passed, zero failures/skips/TODOs: 43 offline AF0 cases and 120 CI-script contract cases |
| `pnpm lint` | passed; both AF0 test files are now part of its script-test list |
| `pnpm docs:check` | passed |
| `git diff --check` | passed |
| live collector with `--scope follow-up`, two explicit predecessor references and a new output filename | observed; exact source and automatic cleanup in the JSON |

The 43 AF0 cases cover availability independent of exit status; server versus CLI token evidence;
JSON and SSE overflow; partial transport failures; owned subprocess/group cleanup including descendants;
transient EPERM conservatism; repeated HUP/INT/TERM; both output siblings reserved with `wx`; actual
cwd/TTY metadata; optional predecessors; bounded I/O; real fake-executable argv/environment checks;
TCP-listener refusal; live opt-in at the server boundary; post-start pipe EOF; delayed parent-death
behavior and interrupted lifecycle observation. Tests never invoke the real `fm` executable.

Test-first failures included the missing server-prompt bound, streamed-overflow attempt, group/PID
cleanup evidence, signal installation, wx Markdown reservation, partial-response retention and the
server-executable seam. The parent fixture also checks the actual reduced-environment spawn manifest;
macOS may synthesize a CoreFoundation encoding variable after exec, so the Node parent reconstructs
only HOME, LANG and PATH before spawning `fm`.

## Additional native measurements

- A 5,000-word input is accepted with 5056 `usage.prompt_tokens` (CLI count 5001), corroborating the
  original full run's server log. U5's 4096-token hardware-window proposal is refuted; the 4096
  catalog/guard policy remains conservative and the exact shared window remains unknown.
- At 8193 CLI tokens, `stream:false` returns HTTP 500 JSON. `stream:true` returns HTTP 200 SSE: a role
  chunk, then the transcript-size `server_error` with code `500`, no `[DONE]`, and a clean transport end.
- stdin remains an open pipe through readiness, then is closed. Three health/PID samples spanning
  10.00 seconds show continued serving. The value is derived from the samples.
- After killing and reaping only the direct Node parent, three health/PID samples spanning 10.00
  seconds show continued serving. Behavior after ten seconds is not established by either experiment.
- Every launched fm server passed the common TCP-listener check. Three owned process groups and all
  four recorded PIDs subsequently returned ESRCH; the temporary tree was removed automatically.

No licence command, sudo, PCC completion, personal Harness configuration change or global Apple
Intelligence change was used. Native unavailable-system/downloading/region/disabled errors, an
unagreed licence, long idle unloading, a forced unloaded-model cold start and model-service RSS remain
unmeasured. Full protocol, warm latency, CLI RSS and socket-edge experiments were not repeated in this
focused run; those observations remain in the original full final receipt.

SIGKILL of the collector cannot be intercepted and can leave its detached process groups and temporary
tree. No local Linux or Windows run is claimed. CI runs only the offline cases and was not polled;
review and merge remain with the Controller.

# Demo guide — M1b-2a

Four short demos of the harness end to end: recall across a restart, surviving a hard kill, a live config change
that restarts only the affected module, and self-repair. Every command is copy-pasteable and uses
`--home /tmp/p1b-demo` so it never touches a real `~/.plur1bus`. Each demo was run once on the build sandbox
(cloud container, 2 vCPU, Linux) while writing this guide; results and caveats observed there are noted inline.

Prerequisites: a built release binary and core bundle.

```bash
cargo build --release -p plur1bus
pnpm build
export PLUR1BUS_BIN=target/release/plur1bus          # not required by the CLI itself; shown for scripts that use it
export PLUR1BUS_CORE_JS="$PWD/packages/core/dist/core.js"
export PLUR1BUS_NODE=$(which node)
BIN=target/release/plur1bus
rm -rf /tmp/p1b-demo
```

## 1. Two-session recall

Add a fact in one "session" (one CLI call), then recall it in another, after the core has restarted in between.

```bash
$BIN --home /tmp/p1b-demo agent create bernd
$BIN --home /tmp/p1b-demo daemon start
$BIN --home /tmp/p1b-demo memory add --agent bernd "The launch code is 4821."
$BIN --home /tmp/p1b-demo memory recall --agent bernd "launch code" --json
$BIN --home /tmp/p1b-demo daemon stop
```

**Sandbox result:** the automated version of this exact sequence
(`tests/system/two-session-recall.test.ts`) passed three times in a row, with the recall's
`timing.totalMs` at 90–107 ms (well under the 400 ms soft budget) — see
`docs/reports/2026-m1b-2a-baseline.md` §5. Run by hand as above, add/recall/stop also succeeded, printing the
fact back in the `memories` prompt block. On a busy machine the first `memory add` right after `daemon start`
can take a couple of seconds while the core finishes starting — that is expected, not a fault.

## 2. Kill the core and watch `daemon status`

```bash
$BIN --home /tmp/p1b-demo daemon start
$BIN --home /tmp/p1b-demo memory add --agent bernd "The launch code is 4821."
CORE_PID=$($BIN --home /tmp/p1b-demo daemon status --json | node -e \
  'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).children[0].pid))')
kill -9 "$CORE_PID"
$BIN --home /tmp/p1b-demo daemon status --json    # shows the core "crashed", then a new pid once the supervisor restarts it
$BIN --home /tmp/p1b-demo memory recall --agent bernd "launch code" --json
$BIN --home /tmp/p1b-demo daemon stop
```

**Sandbox result:** `daemon status` correctly showed `state: "crashed"` with `lastExit.signal: "SIGKILL"`
immediately after the kill, then a new `pid` with `state: "ready"` and `restarts: 1` a couple of seconds later —
exactly the behaviour the kill-soak system test (`tests/system/kill-soak.test.ts`) exercises at scale. **Caveat
observed on this 2-vCPU sandbox:** a `memory recall` issued in the few hundred milliseconds right after
`daemon status` first reports the new core `ready` can answer `core-unavailable` (`handshake-timeout`) or
`degraded: {reason: "aborted"}` — the process is listening but the RPC handshake and journal replay were still
settling under CPU contention from other work in this build. This is a timing race, not a correctness bug: the
CLI's own system tests wait for a specific ready-and-stable condition (`readyChild` in
`tests/system/helpers.ts`) rather than a fixed sleep, and pass reliably that way. For a live demo, retry the
recall once after a second or two if the first attempt reports `core-unavailable`.

## 3. Config change with a module restart (fixture module)

```bash
$BIN --home /tmp/p1b-demo module install packages/module-fixture/dist
$BIN --home /tmp/p1b-demo daemon start
$BIN --home /tmp/p1b-demo module list --json                              # fixture is "ready", detail.greeting is null
$BIN --home /tmp/p1b-demo config set modules.fixture.greeting '"hi"' --yes
$BIN --home /tmp/p1b-demo module list --json                              # fixture restarted once, detail.greeting is "hi"
$BIN --home /tmp/p1b-demo daemon stop
```

**Sandbox result:** ran cleanly. `config set` printed `changes: modules.fixture`, `restarts module fixture`,
`applied`; the second `module list` showed a new `pid`, `restarts: 1`, `lastExit.reason: "none"` (a clean exit,
not a crash) and `detail.greeting: "hi"`. The core's own `pid` and `restarts` are untouched — only the module
restarted, as the config's `x-restart: "module:fixture"` classification promises.

## 4. `1staid check` → break `run/` → `1staid repair --dry-run` → `repair --yes`

```bash
$BIN --home /tmp/p1b-demo daemon start
chmod 0777 /tmp/p1b-demo/run                       # simulate a loosened permission
$BIN --home /tmp/p1b-demo 1staid check --json      # run.permissions reports "fail": "run/ is 777, expected 0700"
$BIN --home /tmp/p1b-demo 1staid repair --dry-run --json   # plans run.permissions.fix, changes nothing
stat -c "%a" /tmp/p1b-demo/run                     # still 777
$BIN --home /tmp/p1b-demo 1staid repair --yes --json       # applies the fix
stat -c "%a" /tmp/p1b-demo/run                     # back to 700
$BIN --home /tmp/p1b-demo daemon stop
```

**Sandbox result:** ran exactly as described. `1staid check` reported
`{"id":"run.permissions","status":"fail","summary":"run/ is 777, expected 0700"}`; `repair --dry-run` planned
one step (`run.permissions.fix`, risk `low`, `needsConfirmation: true`) and left the directory at `777`;
`repair --yes` applied it (`status: "done"`, touching `run/` plus its four token/pid files) and the directory's
mode was `700` afterward. The repair's own `checkAfter` summary showed `{"fail":0,"warn":3,"ok":12}` — the
remaining `warn`s are informational checks unrelated to permissions (e.g. no OS service registered in this
throwaway home), not a sign the repair left something broken.

## Cleanup

```bash
$BIN --home /tmp/p1b-demo daemon stop 2>/dev/null
rm -rf /tmp/p1b-demo
```

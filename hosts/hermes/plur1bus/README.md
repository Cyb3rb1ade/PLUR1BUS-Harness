# plur1bus: PLUR1BUS memory provider for Hermes

A Hermes memory provider directory (`$HERMES_HOME/plugins/plur1bus/`). It holds no engine, store or
model: every recall and capture goes to the local PLUR1BUS core over its RPC (socket or named pipe),
through the vendored `plur1bus-memory-client` in `_vendor/` (added by the release build).

Installed and bound by `install-plugin.sh --host hermes` (or `install-plugin.ps1 -Host hermes`), which
also runs `hermes config set memory.provider plur1bus`. By hand:

```sh
hermes plur1bus bind        # create agent hermes-<profile> in PLUR1BUS, write $HERMES_HOME/plur1bus.json
hermes plur1bus selftest    # read-only: connect, core.status, agent.status, one recall
hermes plur1bus status      # binding, core, capture journal counts, last error code
```

Files it uses in the Hermes home:

| Path | What |
|---|---|
| `plur1bus.json` | the binding (`plur1bus.hermes-binding/1`, mode 0600): PLUR1BUS home, binary, agent id, `recallHardMs`, `capture` |
| `plur1bus/journal.ndjson` | captures that could not be delivered (mode 0600), replayed in order; at most 1 000 entries / 4 MiB |
| `plur1bus/state.json` | journal counters and the last error code |

When the core is stopped, recall returns nothing (one warning per session) and completed turns wait in
the journal. The core token is never logged or stored; turn text is written only to the journal.
Design: `docs/superpowers/plans/2026-09-29-hm2-hermes-host-mode-adapter.md` (Task 5).

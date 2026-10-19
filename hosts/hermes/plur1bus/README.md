# plur1bus: PLUR1BUS memory provider for Hermes

A Hermes memory provider directory (`$HERMES_HOME/plugins/plur1bus/`). It holds no engine, store or
model: every recall and capture goes to the local PLUR1BUS core over its RPC (socket or named pipe),
through the vendored `plur1bus-memory-client` in `_vendor/` (added by the release build).

Installed and bound by `install-plugin.sh --host hermes` (or `install-plugin.ps1 -Host hermes`) from `Cyb3rb1ade/PLUR1BUS-Host-Addons`, which
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
the journal. Captures run on one background worker, in order; no Hermes hook touches the journal
except `shutdown`, which journals every turn not yet delivered within its 2 s budget and counts (as
`lost` in `status`) any it could not write.

The `plur1bus_memory_*` tools follow what the core advertises. Hermes asks for the model's tool list
once, right after the provider starts (and again only when it rebuilds its tool list, e.g. an MCP
refresh), so if the core is down when a session starts, no memory tools are offered for that session;
they return with the next session once the core is running. The core token is never logged or stored; turn text is written only to the journal.
Design: `docs/superpowers/plans/2026-09-29-hm2-hermes-host-mode-adapter.md` (Task 5).

## Existing full Harness (HM4)

After the owner provisions the derived Hermes agent and a separate `plur1bus-client.token`, use `hermes plur1bus bind --existing --home /absolute/harness-home --json`. This authenticates to the existing IPC endpoint, without starting a supervisor or using the core token. Full-profile bindings require their own credential; missing/invalid/revoked tokens fail closed. Normal `bind` also takes this restricted path when the target manifest is full. Host-to-full setup reuses the same store and validates recorded Hermes client credentials before committing its profile transaction. Owner provisioning, upgrade prerequisites and known platform/recovery gaps are documented in `docs/hermes-host-mode.md`. The catalog build has no updater.

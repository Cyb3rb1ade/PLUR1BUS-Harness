# fixture (test module)

## Purpose

The smallest module the harness can run: the supervisor's and module-api's tests use it to exercise the module
runtime (`runModule` in `@plur1bus/module-api`: control endpoint, lock, lifeline, adoption) and the supervisor's
module handling (start order, backoff, restart classes). It does no real work. It is private and never published.

## Manifest

| Field | Value |
|---|---|
| `name` | `fixture` |
| `version` | `0.1.0` |
| `apiVersion` | `1` |
| `entry` | `index.js` |
| `needs` | `core` |
| `provides` | `fixture.echo` |
| `consumes` | `memory` |
| `extensionPoints` | `collect-status: collect` |
| `scope` | `installation` |
| `priority` | `500` |

## RPC

Provided (on `run/module-fixture.sock`, or the `-module-fixture` pipe on Windows): only the methods every module
serves through the runtime, `module.auth`, `module.status`, `module.adopt` and `module.shutdown`. `module.status`
reports `detail: { greeting }`. The `fixture.echo` capability is declared for the dependency graph only; no method
serves it.

Consumed: none. Because the manifest needs `core`, the runtime keeps a reconnecting client to the core
(`module.status.core` is `connected` or `reconnecting`), but the fixture never calls it.

## Configuration

`modules.fixture` in `config.json`, validated by the manifest's `configSchema`. Every key has the restart class
`module:fixture` (a change restarts this module, never the core).

| Key | Type | Effect |
|---|---|---|
| `modules.fixture.greeting` | string | Reported as `module.status.detail.greeting`; the running process also follows a change without a restart. |
| `modules.fixture.crashAfterMs` | integer ≥ 0 | The process exits 1 this many milliseconds after it started (for crash and backoff tests). |

## Running and testing it alone

```bash
pnpm --filter @plur1bus/module-fixture build        # dist/{index.js,module.json,README.md}
mkdir -p /tmp/p1b/modules/fixture && cp packages/module-fixture/dist/* /tmp/p1b/modules/fixture/
node /tmp/p1b/modules/fixture/index.js --home /tmp/p1b --module fixture
```

Without `--lifeline stdin` it reads `config.json` itself and runs until SIGTERM or `module.shutdown`; with it, it
follows the supervisor's configuration and stops once stdin closes and `supervisor.graceMs` passes without an
adoption. `pnpm --filter @plur1bus/module-fixture test` runs its tests against a fresh build.

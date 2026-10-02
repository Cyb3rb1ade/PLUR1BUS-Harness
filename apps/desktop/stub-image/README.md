# Test-only harness stub image

`p1t-stub-harness:wp02` packages the provisional Rust mock and fake `plur1bus`
CLI. Its Rust builder and Debian runtime use Docker Hub manifest-list digests
verified through the registry tag API on 2026-10-01. The build context is only
`apps/desktop`; `.dockerignore` excludes build outputs, UI artifacts, Git data,
and credential file patterns. The image starts as UID/GID `10001:10001` on
`0.0.0.0:18700`. Publish it **only to host loopback**.

From the repository root with Node 24.21.0:

```sh
node apps/desktop/stub-image/build.mjs --runtime docker
PLUR1BUS_DESKTOP_E2E_RUNTIME=docker node apps/desktop/stub-image/smoke.mjs --runtime docker
```

Replace `docker` with `podman` for the Podman path. The smoke command skips
without the matching opt-in environment variable. It makes unique `p1t-<run id>-`
container and volume names, labels each object `app.plur1bus.test=<run id>`,
uses the desktop read-only/user/tmpfs/capability rules, verifies the host publish
address, checks `/api/v1/meta`, executes `plur1bus daemon status --json`, checks
the fixture, times a graceful stop, and removes only its own objects.
The image sets `PLUR1BUS_CONTAINER=1` so the mock can bind `0.0.0.0` inside the
container. A standalone mock process without that marker accepts loopback
binds only. Test-control routes, if enabled, still require a loopback peer.

The standalone binary can be run with `--port`, `--bind`, and `--state-dir`.
Default bind is loopback. In tests, `MockHarness::start(MockOptions)` gives a
control handle for pair codes, status/secrets, meta changes, SSE disconnect,
revocation, and upgrade failure injection. The image does not expose the
`/__test/*` routes by default. A disposable test container can explicitly set
`PLUR1BUS_DESKTOP_TEST_CONTROL=1` if its fake CLI needs them. `fake-plur1bus` reads an optional
`PLUR1BUS_FAKE_SCENARIO` JSON file and records argv to `PLUR1BUS_FAKE_RECORD`
or `<PLUR1BUS_HOME>/mock-argv.jsonl`. Never pass a bearer token through argv.

The image implements no real storage migration, installation, runtime control,
or container mode. It exists to test the desktop shell before M3's real API.

# Containers

This page explains how the harness runs as a container: on a Mac through Apple Containers or Docker, and on a server,
home server or VPS through Docker. It also describes the optional sidecars and the commands you use to control the
stack. Every command here exists in this build (`docs/cli.md` is the full reference). The German version is
[../de/container.md](../de/container.md). For an installation without a container, see [quickstart.md](quickstart.md).

## What it is for

The harness image contains the supervisor, the core and the `plur1bus` command line in one sealed container. You need
it when the harness should run on a machine where you do not want an installation in your user directory, for example a
VPS or a home server. The installation without a container remains the normal path for development and your own laptop.

Inside the container, services run with restricted rights: a user without a login (UID 10001), a file system that is
writable only for state, no extra Linux capabilities and no new privileges for processes. The state lives in a volume of
the container system and survives restarts and image updates.

## Runtime: Apple Containers or Docker

The harness can use two container runtimes:

- **Apple Containers** (version 1.5.0) on macOS 26 or newer on Apple-silicon Macs. With `auto`, this runtime is preferred,
  even if its service has to be activated first.
- **Docker** as the alternative. Detected are Docker Desktop, OrbStack, Colima, Docker contexts and rootless
  Podman-compatible sockets. On Windows the Docker named pipe is used.

If a runtime is not installed, the plan shows the official download and its licence. The installation downloads it only
with your separate consent (`--accept-runtime-download`). The harness does not run the vendor's installer itself: you
finish the vendor's installation and run the command again.

A remote Docker connection requires TLS. Certificate paths come from `DOCKER_CERT_PATH` and are not saved.

On Windows, the named-pipe connection has not yet been tested natively. The tests ran on a Mac with Apple Containers and
with Docker.

## Installation

First, the plan shows what would happen without changing anything:

```sh
plur1bus install --container --container-plan
```

Then install, interactively with a confirmation or without one:

```sh
plur1bus install --container
plur1bus install --container --non-interactive
```

You get the same result through `setup`:

```sh
plur1bus setup --container --image <digest-pinned-image> --non-interactive
```

The options at a glance:

- `--runtime auto|apple|docker` selects the runtime. Without it, `containers.runtime` applies. A runtime you chose
  explicitly that is not available is refused; the installation does not quietly fall back to another one.
- `--image <ref>` names the image. For production use a digest reference (`…@sha256:…`), not a tag.
- `--image-from <archive>` loads an image from an archive, for installations without a network. The archive must contain
  the reference you pass to `--image`.
- `--sidecar <id>=bundled|off|<url>` sets how a sidecar runs (see below).
- `--container-manifest <file-or-url>` uses a different signed feed. Without an image and without a manifest, the
  installation takes the image from the signed stable channel, or from the beta channel with `--channel beta`.

The installation writes `container-install.json` with the stack, the runtime, the version and the health timeout. It takes
a lock on the host, so two runs do not work against each other.

## Controlling the stack

```sh
plur1bus --json container status
plur1bus --json container up
plur1bus --json container down
plur1bus container logs
plur1bus --json container logs plur1bus-harness
```

- `status` shows the runtime and the state of the stack. It only reads.
- `up` starts the stack and waits until it is healthy. A second call runs without harm.
- `down` stops and removes the containers of the stack. The state volumes stay, so your data stays too.
- `logs` shows the logs of one service; the default is `plur1bus-harness`. With `--json` you get one JSON document per line.

The `container` command only works with containers that belong to this installation. It does not touch foreign containers
or networks.

## The harness API is not reachable from outside

By default the container installation publishes no port of the harness. The current core talks over an authenticated
Unix connection inside the container.

If you want a port on the host, set `containers.apiPort`. It is published on the address in `containers.bindAddress`,
which is `127.0.0.1` by default, so only this computer can reach it. Without `apiPort` nothing is published, whatever
`bindAddress` says. The API always stays behind authentication.

`bindAddress` accepts loopback, private LAN, tailnet and unique-local addresses. `0.0.0.0`, `::` and public addresses are
refused. If you pick another address than loopback, for example in a company network, everything that can reach that
address can reach the port. The installation then prints a warning and asks you to confirm; with `--non-interactive` it
only prints the warning, so read the plan first (`--container-plan`). `container status` shows the published ports
(`published`) and repeats the warning (`warnings`).

## Sidecars

Sidecars are services that run next to the harness. There are two:

- `searxng`, a search engine that the installation can run, or to which it can connect an external service.
- `valkey`, a storage service that SearXNG needs as a dependency. If SearXNG runs bundled, Valkey is started too, unless
  you specify otherwise.

Each sidecar has one of three modes:

- `bundled`: the installation starts the service as a container on the same host.
- `remote`: the service runs on another machine, for example over Tailscale. An address without credentials is enough,
  for example `http://100.64.0.10:8080`. For Valkey the scheme is `valkey://HOST:PORT/0`. The installation then starts no
  local container for it. If the service cannot be reached, the installation stops before the stack starts.
- `off`: the service stays off. No container is started and no health check is made.

```sh
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=bundled
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=http://100.64.0.10:8080
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=off
```

For a bundled SearXNG with a remote Valkey, select it like this:

```sh
plur1bus install --container --image <digest-pinned-image> --sidecar valkey=valkey://100.64.0.20:6379/0
```

Sidecars publish no port on the host. The installation creates a private configuration for the service, with a generated
search secret, and mounts it read-only.

SearXNG is the web search of your agents. With `bundled` the harness uses the sidecar over its private address on the
container network, with `remote` it uses the host from `sidecars.searxng.url` (for example a Tailscale address and port),
with `off` the agents have no web search and the tool answers that search is not set up. Search queries go only to this
SearXNG. After you switch a bundled SearXNG on for an existing installation, run `container down` and `container up`
once so the harness container learns the address. `plur1bus` status shows under `webSearch` whether the sidecar answered
the last search.

For HTTPS services you can set a CA bundle (`caBundle`) and a fingerprint (`fingerprint`, the SHA-256 of the certificate).
The fingerprint checks only the installation's health check. When the harness itself talks to the service, it must apply
the same trust rule. The health check uses no proxy and follows no redirects.

## Configuration

The container settings live in `config.json`. The keys with their defaults:

| Key | Default | Meaning |
|---|---|---|
| `containers.runtime` | `auto` | `auto`, `apple` or `docker` |
| `containers.image` | empty | Image reference; use a digest in production |
| `containers.stateVolume` | `plur1bus-state` | Name of the state volume |
| `containers.bindAddress` | `127.0.0.1` | Address a published port is bound to, see above |
| `containers.apiPort` | empty | Host port for the harness API; empty publishes nothing |
| `containers.healthTimeoutMs` | `120000` | Time a service has to pass its health gate |
| `sidecars.<id>.mode` | `off` | `bundled`, `remote` or `off` |
| `sidecars.<id>.url` | empty | Required for `remote`, without credentials |
| `sidecars.<id>.caBundle` | empty | PEM file for HTTPS services |
| `sidecars.<id>.fingerprint` | empty | `sha256:` followed by 64 hex characters, only for self-signed certificates |
| `sidecars.<id>.timeoutMs` | `5000` | Time limit of the health check for `remote` |

An example:

```json
{
  "schemaVersion": 1,
  "containers": { "runtime": "auto", "healthTimeoutMs": 120000 },
  "sidecars": {
    "searxng": { "mode": "remote", "url": "http://100.64.0.10:8080", "timeoutMs": 5000 },
    "valkey": { "mode": "off" }
  }
}
```

The keys `containers.*` and `sidecars.*` are marked in the schema as "advanced" and `live` (`x-tier`, `x-restart`). Which
change actually rebuilds the running stack is not documented as a rule in the code. After a change, check with
`plur1bus --json container status`.

## Updates

Outside the container, `plur1bus update` updates the program as usual. On a host with `container-install.json`, `update`
updates the image instead of the program file. The order: the new image is pulled before the old container is stopped, the
state volume stays, and the new container must become healthy. If that fails, the old state is restored.

```sh
plur1bus update --plan --manifest stable.json
plur1bus update --yes --manifest stable.json
plur1bus update status
plur1bus update --rollback
```

Inside the container, `setup` and `update` answer with `container-managed`. You run an update on the host.

An update that changes the storage schema is refused by the image updater. An old image cannot undo a data migration. That
needs its own backup and migration (see [operations.md](operations.md)).

## What does not exist yet

- A public image that anyone can pull. Published packages are private until the release makes them public.
- A harness-owned init process as PID 1. Until then the container uses `init` (tini).
- An HTTP API and an HTTP health check.
- Search for the agent. The sidecars provide services, but they are not yet connected to the core.

## Next

- [quickstart.md](quickstart.md): installation without a container, first steps.
- [operations.md](operations.md): directories, logs, updates and troubleshooting.
- [os-confirmation.md](os-confirmation.md): why some approvals need a confirmation by the operating system.

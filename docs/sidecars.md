# Sidecars

Each sidecar supports `bundled`, `remote` or `off`. Remote mode accepts a credential-free
HTTP(S) address, including a Tailscale host and port. Off mode performs no health request
and creates no container. Remote mode creates no local sidecar; an unreachable endpoint
fails before starting the harness stack. The manager resolves endpoints by sidecar ID.

```sh
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=bundled
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=http://100.64.0.10:8080
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=off
```

For a bundled SearXNG with a remote Valkey dependency, add
`--sidecar valkey=valkey://100.64.0.20:6379/0`. No local Valkey container is created;
health checks use credential-free RESP PING with socket deadlines. Use Tailscale's
encrypted network for this native protocol; HTTPS CA/pin settings apply to HTTP services.

The same selections work with `setup --container`; the interactive installer offers the
three modes and asks for the remote URL when chosen. Config can supply them:

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

Bundled SearXNG uses the pinned SearXNG manifest and a pinned Valkey dependency, non-root
UIDs, read-only roots, capability removal, PID/memory limits and isolated networks.
Search gets a separate egress network. No sidecar is published to the host. The installer
creates private host settings with a generated search secret and a read-only config mount;
application state stays on runtime volumes. On Apple, config binds mount a directory,
not one file, and the adapter applies the 200 MiB VM minimum. Bundled application
entrypoints set `no_new_privs` on both runtimes. Apple places the NAT interface first
for outgoing traffic and resolves dependencies to their private IPs on the shared network
(custom networks have no bare-hostname service discovery). `containers/compose.yaml` provides equivalent
Docker deployment defaults; set `SEARXNG_SECRET` before enabling its `searxng` profile.

Remote health probes have a bounded timeout, reject credentials/fragments, do not use
proxies and do not follow redirects. HTTPS supports `caBundle` and an optional
`sha256:<64 lowercase hex>` leaf-certificate `fingerprint`. The pin is checked on the DER
certificate, including self-signed leaves. This check validates the health probe only:
a sidecar consumer must apply the same trust policy to its own requests.

`containers/sidecars/template.json` documents new bundled manifests: image digest,
non-root user, port, health command, memory/PID limits, volumes and licence. Custom remote
IDs can be configured without a local image. This package prepares and resolves endpoints;
it does not add search or cache consumers to the core.

## SearXNG as the agents' web search

SearXNG is the search backend of `web.search` (see [web-tools.md](web-tools.md)). The mode decides where requests go:

| `sidecars.searxng.mode` | Target |
|---|---|
| `bundled` | the sidecar container, reached by its private IP on the container network |
| `remote` | `sidecars.searxng.url`, for example a Tailscale address; the private-IP rule does not apply |
| `off` | no search; `web.search` answers `no-provider` |

In a container installation the install record, not the container's `config.json`, holds the selection. The container
layer therefore hands it to the harness: `PLUR1BUS_SEARXNG_MODE` (`bundled` or `remote`) and `PLUR1BUS_SEARXNG_URL`. For a
bundled sidecar the URL is a stack connection, resolved to the sidecar's private IP once it is healthy (the mechanism
SearXNG uses for Valkey). A `sidecars.searxng` entry in the core's own config wins over these variables. An install record
written by an earlier release is wired on its next `container down` / `container up`; the stack does not recreate a
running harness container.

The client for this traffic is separate from the open-web `web.fetch` client and narrower: only the configured origin,
only private, tailnet (including `.ts.net` names that resolve there) or loopback addresses, never link-local or cloud
metadata addresses, no redirects, JSON answers only, 1 MiB at most, 10 s per search. Queries go to the configured SearXNG
and nowhere else. Logs and `core.status` carry lengths, counts, durations and failure codes, never query or result text.
`sidecars.searxng.fingerprint` protects the health probe only; `web.search` refuses to run with it set (use `caBundle`
in a native install; a container install uses the system trust store). `core.status.webSearch` shows `mode`, `state`
(`off`, `not-running`, `misconfigured`, `unknown`, `ok`, `unreachable`, `error`) and the last failure code; `container
status` shows the reachability of the sidecar itself. SearXNG's `settings.yml` must list `json` under `search.formats`; the
bundled one does.

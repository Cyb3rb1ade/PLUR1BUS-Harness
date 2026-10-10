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

# Privacy and "Local only" mode

With the "Local only" switch (`privacy.localOnly`), no model prompt, embedding or reranker request leaves your machine unless the endpoint is local. The German version of this page is [../de/datenschutz.md](../de/datenschutz.md).

> **Availability:** "Local only" is available from the next release. Earlier versions do not know `privacy.localOnly`, `privacy.localEndpoints` or `agents.<id>.privacy.localOnly`.

## How to

### Web UI

1. Open **Settings → Privacy** (`#/settings/privacy`).
2. Switch on **privacy.localOnly** ("Only local models").
3. To allow a model server of your own outside this machine, add its origin under **privacy.localEndpoints** (for example `http://100.64.0.10:8080`): scheme, host and optional port, no path.
4. Choose **Review changes**, check the diff and save. Both keys restart the core. Only an owner or admin can change them.

### CLI

Check the current setting:

```sh
plur1bus config get privacy.localOnly
```

Turn on local-only mode:

```sh
plur1bus config set privacy.localOnly true
```

Allow a self-hosted model server in your home network:

```sh
plur1bus config set privacy.localEndpoints '["http://100.64.0.10:8080"]'
plur1bus config get privacy.localEndpoints
```

### Per agent

An agent can override the installation value in both directions. Set it for one agent (there is no switch for it in the web UI):

```sh
plur1bus config set agents.<id>.privacy.localOnly true
```

An unset value inherits `privacy.localOnly`; `false` lifts the restriction for that agent only.

## Good to know

- **What counts as local:** an endpoint on loopback (`localhost`, `127.0.0.0/8`, `::1`) or exactly one of the origins in `privacy.localEndpoints`. A LAN address is never local by itself, and a name is not resolved to decide.
- **What is covered:** chat and role models (including the summaries that compact long conversations), embeddings, the reranker, the memory engine's own model features, voice (local models only), captioning, the media index and media generation. Model discovery still lists cloud models, marked "local only: locked".
- **No silent fallback:** a model that is refused is never replaced by another one. The request fails and says why.
- **Web tools are not affected:** `web.fetch` and `web.search` are not model calls. Tool permissions, approvals ([approvals.md](approvals.md)) and the egress rules govern them, not `privacy.localOnly`.
- **Shared memory engine and media index:** every agent writes into them, so they stay local while the installation or any agent is local-only. An agent that lifts the switch for itself never opens them to a cloud model.
- **Egress still applies:** a local endpoint must also pass the `egress.*` rules; loopback needs `egress.allowLoopback`.
- **Doctor:** the check `privacy.local-only` fails while the switch is on and a cloud model is still configured, and lists what will be refused.

## Error messages

Refusals use the closed error codes; the `reason` says which rule applied.

- `E_DENIED` with reason `local-only`: the model, embedding or reranker endpoint is not local while "Local only" applies. Choose a local model, list your own server in `privacy.localEndpoints`, or turn the switch off.
- `E_DENIED` with reason `egress-denied`: the egress rules refused an endpoint of the memory engine when it started (for example a remote embedding host). Add the host to `egress.allowHosts`; loopback also needs `egress.allowLoopback`.

## Next

- Manage cloud and local model providers: [providers.md](providers.md)
- Configure cloud embeddings: [cloud-embeddings.md](cloud-embeddings.md)
- Secret storage for credentials: [secrets.md](secrets.md)

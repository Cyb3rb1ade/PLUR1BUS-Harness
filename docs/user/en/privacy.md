# Privacy and "Local only" mode

Plur1bus provides a strict "Local only" privacy mode (`privacy.localOnly`) that ensures no model prompts, embeddings, or reasoning data leave your machine without explicit permission. The German version of this page is [../de/datenschutz.md](../de/datenschutz.md).

## How to ("So geht's")

### Web UI

1. Open **Settings** (`#/settings/security` or `#/settings/general`).
2. Navigate to the **Privacy & Network** card.
3. Toggle the switch **Local only** to **Enabled**.
4. To allow a self-hosted inference server on your home network, add its URL under **Local endpoints** (for example `http://100.64.0.10:8080`).
5. Choose **Save changes**.

### CLI

Check the current setting:

```sh
plur1bus config get privacy.localOnly
```

Turn on local-only mode:

```sh
plur1bus config set privacy.localOnly true
```

Allow trusted home network or self-hosted endpoints:

```sh
plur1bus config set privacy.localEndpoints '["http://100.64.0.10:8080"]'
plur1bus config get privacy.localEndpoints
```

### Per-agent override

You can enforce local-only execution for a specific agent even when the global switch is off:

- In `config.json` under `agents.<id>`, set `"privacy": { "localOnly": true }`.
- In the Web UI: Go to **Agents** (`#/agents/<id>`), choose **Edit**, and check **Restrict to local models**.

## Good to know ("Gut zu wissen")

- **What is blocked:** Every model inference call that leaves the machine is blocked. This includes chat models, cloud embeddings, cloud rerankers, compaction calls, voice synthesis/transcription, and automated reasoning probes.
- **What is NOT blocked (Web tools):** Browser automation, HTTP fetches, and web search tools are operational tools, not model calls. They are controlled by tool permissions and approvals ([approvals.md](approvals.md)), not by `privacy.localOnly`.
- **Shared Engine impact:** If an agent has local-only enabled, the shared memory engine strictly forbids calling cloud embeddings or cloud rerankers when indexing or searching that agent's cards.
- **Home servers and rebinding protection:** `privacy.localEndpoints` allows local network addresses (such as Ollama or LocalAI on LAN). The egress firewall blocks loopback aliases and DNS rebinding attacks; only explicitly listed addresses are permitted.

## Error messages ("Fehlermeldungen")

- `E_MODEL_FORBIDDEN_LOCAL_ONLY` (or `E_LOCAL_ONLY`): The requested model or embedding service points to an external cloud provider, but local-only mode is active. Choose a local model or disable local-only mode.
- `E_EGRESS_BLOCKED`: The engine blocked an outgoing network connection because the destination IP or domain is not listed in `privacy.localEndpoints`.

## Next

- Manage cloud and local model providers: [providers.md](providers.md)
- Configure cloud embeddings: [cloud-embeddings.md](cloud-embeddings.md)
- Secret storage for credentials: [secrets.md](secrets.md)

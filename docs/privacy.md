# Model privacy

Settings > Privacy offers the basic “Only local models” switch. Interactive CLI setup asks the same question;
unattended setup preserves the configured choice. Only Owner/Admin may change these audited settings.

The switch covers model requests: chat, role models, compaction, voice, media, embedding, reranking and engine LLM
features. Web search and fetching remain governed by their own egress policy. A refusal never silently selects a
cloud provider or substitutes another embedding model / vector space.

Loopback is local. A home-network server must be listed explicitly in `privacy.localEndpoints`, by exact origin
including a nondefault port. LAN addresses, DNS names, tunnels and private address ranges are not trusted implicitly.
This allowlist grants no secret, egress, TLS, license or service authority.

An agent can override the installation setting for its own model calls. When **any** agent explicitly requires local
models, the shared engine must stay local for everyone. Settings shows the pinning agent IDs; a conflicting engine
write reports `local-only-shared-engine` and those IDs. Rust `1staid check` appends `privacy.local-only`: off/consistent
is `ok`, inconsistent cloud configuration is `fail`, and consistent explicit overrides are `info` with the agent list.

Changes apply before the next model request. An in-flight cloud response may finish; the next tool round is checked
again. Doctor reflects accepted live policy without rerunning every provisioning probe.

Engine model changes still follow the existing migration/restart path. Migrate and restart a remote engine before
enabling the switch; the running endpoint inventory is checked alongside the proposed config. The automatic
engine-only restart and actual reembed usage are pending the public Engine ports: see [egress](egress.md#live-local-only-policy-ii).

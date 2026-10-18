# Voice sessions / Sprachsitzungen (D110)

## English

`voice.session.create` is the server broker entry point for `openai:realtime` and `openai:gpt-live`. A person needs `agent.use` and a transport-authenticated T2+ surface; declaring trust in RPC params is rejected. Requests contain `agentId`, `provider`, `model`, `transport`, and for WebRTC `sdp`. The result contains only `sessionId` and optionally `sdpAnswer`. GPT-Live delegates to the harness agent by default. Existing server-side usage accounting and budget refusal remain authoritative.

Configure `providers.openaiVoice` explicitly:

```json
{ "kind": "api_key", "billing_path": "api_key", "region": "eu", "secretRef": "voice.key", "licenceAccepted": true }
```

Store the actual credential with the existing secret-store tooling, never in config. Workload identity uses `kind: federated_token`, `billing_path: workload` and the existing `federated` settings. Choose `global`, `us` or `eu`; no implicit default and no fallback from ChatGPT plan or CLI login. Existing profiles with only `secretRef` need the explicit metadata above. `licenceAccepted` records the administrator's confirmation of provider terms; it does not waive model-specific restrictions.

SIP and Realtime WebSocket relay are still refused by the underlying runtime. GPT-Live WebSocket requires a separately authenticated media relay consumer; the create RPC alone does not deliver audio. Ephemeral direct WebRTC delivery is **not exposed by this RPC**: a trusted delivery channel and provider-authenticated call-id attachment are still required. The existing in-process mint API defaults to 60 seconds and one delivery, but that alone does not establish a provider-enforced one-session secret.

## Deutsch

`voice.session.create` startet eine Sitzung über den Server-Broker. Erforderlich sind eine Person mit `agent.use` und eine authentifizierte Oberfläche ab T2. Identität und Vertrauen stammen aus der Verbindung. Parameter: `agentId`, `provider`, `model`, `transport`, bei WebRTC zusätzlich `sdp`. Zurück kommen nur `sessionId` und gegebenenfalls `sdpAnswer`; kein Credential.

Das Elternprofil `providers.openaiVoice` braucht explizit `kind`, `billing_path`, `region` und die Bestätigung `licenceAccepted`. Den Schlüssel über den Secret-Store unter `secretRef` hinterlegen. API-Key und Workload werden nicht untereinander oder mit ChatGPT-Plan/CLI-Login vertauscht. Region: `global`, `us` oder `eu`.

Budgets und Sideband-Abrechnung bleiben aktiv. SIP, Realtime-WebSocket und die direkte Zustellung von Ephemeral-Secrets sind hier noch nicht verfügbar. GPT-Live-WebSocket benötigt zusätzlich den bestehenden authentifizierten Medien-Relay. Kein Live-Abnahmebeleg liegt vor.

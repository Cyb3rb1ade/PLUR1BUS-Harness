# M2 live proof and discovery / Live-Belege und Discovery

## English

The scheduled/manual `nightly` workflow owns job `m2-live-proof`. Pull-request CI never invokes these tests. A configured endpoint failure fails Nightly; an absent endpoint is a named skip. No run has been accepted by the owner yet.

Set repository variables `PLUR1BUS_M2_CHAT_URL` (OpenAI-compatible base URL including version segment) and `PLUR1BUS_M2_CHAT_MODEL`; optionally set repository secret `PLUR1BUS_M2_CHAT_KEY`. The test uses the real chat adapter through core Direct Chat and the real local E5/BGE engine, stores a randomly generated verification phrase in session one and requires the real model to retrieve it in session two. A temporary home and cached models are used; the home and logs are removed afterwards. The configured model must work with the existing provider/budget rules. This is not a flat-embedder or echo-provider acceptance.

For each of `OLLAMA`, `TEI`, `VLLM`, `LLAMACPP`, `OMLX`, `MTPLX`, set variables `PLUR1BUS_LIVE_<P>_URL`, `_MODEL`, `_DIMS` for embedding; for all except Ollama set `_RERANK_URL` and `_RERANK_MODEL` for reranking. Optional credentials are **separate secrets** `PLUR1BUS_LIVE_<P>_KEY` and `_RERANK_KEY`; they are not reused across endpoints. URLs cannot carry credentials, query strings or fragments. Adapter secrets require TLS or loopback, and redirects are refused by the existing adapters. The hosted runner can only reach endpoints available to that runner. This test does not deploy a local model server.

Only synthetic probes leave the runner. Provider values, errors, URLs, prompt/reply bodies and credentials are withheld from test output. The fixed provider allow-list constructs no hosted cloud embedding/rerank adapter. Existing ADR-006 wire-format fixtures remain assumptions until a successful configured observation; the smoke checks strict mapping and semantic ordering but does not mark source rows verified automatically.

The Models page has “Scan now”, new/unavailable badges, override editing and keyboard support in English and German. Scan never assigns modelRoles. The API allow-list currently admits list/overrides but omits `models.scan` and `models.acknowledge`; the parallel M3 owner must add the trusted transport before the GUI scan works end to end. Browser tests run against the mock API and do not prove this production transport.

Local embedding setup remains the engine's pinned local-transformers configuration. Explicit cloud selections fail; self-hosted adapter selections currently fail with the engine-factory gap instead of silently selecting another model. See `docs/embedding-migration.md` for the current plan/run/status/abort flow: production switch validation and rollback remain blocked, not an enabled migration recipe. Voice setup and limitations: `docs/voice-sessions.md`.

## Deutsch

Nur der geplante/manuell gestartete Workflow `nightly`, Job `m2-live-proof`, führt Live-Aufrufe aus. Ohne Endpoint-Konfiguration gibt es sichtbare Skips. Ein konfigurierter, fehlschlagender Test bleibt rot. Noch kein Lauf wurde durch den Owner abgenommen.

Für Direct Chat die Variablen `PLUR1BUS_M2_CHAT_URL` und `PLUR1BUS_M2_CHAT_MODEL` sowie bei Bedarf das Secret `PLUR1BUS_M2_CHAT_KEY` setzen. Der Test verwendet einen echten Chat-Provider und die echten lokalen E5/BGE-Modelle. Eine zufällige Prüfphrase wird in der ersten Sitzung gespeichert und muss in einer neuen Sitzung wiedergegeben werden. Temporäres Home und Logs werden gelöscht.

Für lokale/selbst gehostete Adapter gelten die oben genannten Variablen je Provider; Embedding- und Rerank-Credentials sind getrennte Secrets. Der Runner muss die Server erreichen können; der Workflow installiert keine Modellserver. Keine Cloud-Embedding-Adapter werden erzeugt. Ausgaben enthalten keine Credentials, Endpoint-URLs oder Prompt-/Antworttexte. Ein Skip belegt keine Modellfunktion.

Die Models-Seite bietet „Jetzt scannen“, Neu-/Nicht-verfügbar-Markierungen und Overrides; Rollen werden nicht automatisch zugewiesen. Für den echten Scan fehlen noch `models.scan` und `models.acknowledge` im API-Filter des parallelen M3-Pakets. Browser-Tests mit Mock-API ersetzen diesen Anschluss nicht. Lokale Standardmodelle laufen weiter; andere Embedding-Provider werden bis zum öffentlichen Engine-Hook sichtbar abgewiesen. Umschalten und Rollback bleiben bis zur Engine-Validierung offen. Voice-Konfiguration: `docs/voice-sessions.md`.

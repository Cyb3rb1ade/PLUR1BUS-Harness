# Auftrag: PLUR1BUS Harness

## 0. Rolle und Arbeitsregeln

Du entwickelst **PLUR1BUS Harness**: einen selbst gehosteten, mehrbenutzerfähigen Multi-Agent-Harness, der **um PLUR1BUS als festen Gedächtniskern herum gebaut** ist, Funktionsumfang in der Größenordnung von Hermes Agent, Web-UI in PLUR1BUS-Optik.

Festgelegt: Produktname „PLUR1BUS Harness" · Repository `PLUR1BUS-Harness` · CLI `plur1bus-harness` (Paketnamen in npm/PyPI kleingeschrieben) · Lizenz MIT.

Verbindlich:

- Phasenweise arbeiten. Phase 0 endet mit einem Stopp; ohne meine Freigabe kein Produktivcode.
- Nichts erfinden. Provider-Endpunkte, OAuth-Flows, Hermes-Extension-Points, Protokollversionen und native Binaries gegen aktuellen Code bzw. aktuelle Doku prüfen; Fundstelle (URL/Datei, Commit, Datum) im jeweiligen ADR festhalten.
- Widerspricht die Realität diesem Auftrag: stoppen, Befund und Optionen nennen, nicht stillschweigend abweichen.
- Annahmen explizit in `docs/assumptions.md`; offene Fragen (Abschnitt 13) vor der betroffenen Phase stellen.
- Kleine, thematisch reine Commits (Conventional Commits); jede Phase mit Tests, CHANGELOG-Eintrag und kurzer Demo-Anleitung.
- Niemals Secrets, Tokens oder echte Nutzerdaten in Repo, Logs oder Test-Fixtures.

## 1. Referenzen (zuerst lesen)

| Projekt | Rolle | Eckdaten |
|---|---|---|
| PLUR1BUS — https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory | **Kern** des Harness, Optik-Vorlage | MIT, JavaScript, Node ≥ 22.22, LanceDB, optional Transformers.js/ONNX (lokale Embedding- und Reranker-Modelle), OpenClaw-Plugin `memory-lancedb-namespaced`, npm `@cyb3rb1ade/plur1bus-memory`. Lies `README.md`, `AGENTS.md`, `docs/compatibility-openclaw.md`, `OPENCLAW_SDK_COMPAT_AUDIT.md`, `openclaw.plugin.json`, `index.js`, `docs/configuration.md`, `bench/` sowie den Control-UI-Renderer. |
| Hermes Agent — https://github.com/NousResearch/hermes-agent | Funktions- und Architekturziel, bevorzugte Basis für die Außenschichten | MIT, Python 3.11 (uv) + Node (TUI/Web/Desktop). Doku https://hermes-agent.nousresearch.com/docs/ — vor allem developer-guide: architecture, provider-runtime, adding-providers, plugins, memory-provider-plugin, model-provider-plugin, secret-source-plugin, adding-platform-adapters, subagent-lifecycle-api, plugin-llm-access, middleware, observer-hooks, gateway-internals, multiplexing-gateway, acp-internals. |
| Buzz — https://github.com/block/buzz | Kommunikationskanal | Apache-2.0, Nostr-Relay-Workspace (NIP-01, NIP-42), Agenten mit eigenem Schlüsselpaar, `buzz-cli` (JSON rein/raus), `buzz-acp`. |

Protokolle: MCP (modelcontextprotocol.io) · Agent Client Protocol (agentclientprotocol.com) · A2A (a2a-protocol.org, github.com/a2aproject/A2A).

Nicht-Ziele: kein austauschbares Memory-Backend, keine Neuimplementierung von PLUR1BUS-Logik in einer anderen Sprache, kein eigenes Inferenz-Backend, kein Mobile-Client, keine Cloud-/SaaS-Komponente, keine Telemetrie.

## 2. Grundsatzentscheidungen

### 2.1 Leitprinzip: PLUR1BUS ist der Kern, alles andere wird darum gebaut

- PLUR1BUS ist fester Bestandteil, kein wählbarer Memory-Provider. Es gibt keine Auswahl alternativer Memory-Backends; die Hermes-eigene Memory-Schleife (Nudges, Pflege von `MEMORY.md`/`USER.md`) und andere Memory-Provider werden abgeschaltet oder PLUR1BUS untergeordnet — PLUR1BUS klassifiziert und spiegelt die kuratierten Dateien, wie heute unter OpenClaw.
- Identitäten kommen aus dem Kern: Agent = PLUR1BUS-`agentId`, Projekt = PLUR1BUS-Workspace, Mensch = ein kanonischer PLUR1BUS-Prinzipal (Harness-Benutzer mit verknüpften Kanalidentitäten, Abschnitt 5.1). Das ACL-Modell von PLUR1BUS (`agent-private`, `workspace`, `user`; Teilen nur explizit, copy-never-move) ist das Berechtigungsmodell für geteiltes Wissen im gesamten Harness.
- Anlegen eines Agenten provisioniert zuerst Store, Vault-Ordner, Feature-Profil und Crons; Löschen ist archive-first.
- Jedes Subsystem hat eine definierte Memory-Schnittstelle: Kanäle (Identität, Critical-Push, Afterthoughts, Reminder), Kollaboration (Beratungs- und Delegationsergebnisse mit Herkunft erfassen, Workspace-Pool), Skills (Skill-Miner-Queue), Cron (Feature-Crons), Sessions (Temporal-Context, Reaktivierung nach Pausen und Kompaktierung), Modellschicht (Embedding und Reranking als Pflichtfähigkeit, Abschnitt 6.2), UI (Memory ist Hauptbereich, nicht Unterseite), Doctor und Backup (Stores zuerst).
- Der Embedding-/Reranking-Dienst gehört zum Kern und wird vom restlichen Harness mitbenutzt.
- Betrieb ohne Memory nur als sichtbar markierter degradierter Zustand; ein Turn blockiert trotzdem nie.
- Was PLUR1BUS dafür braucht (Adapter, Windows-Portierung, Host-Neutralität, Prinzipalmodell, Recall über mehrere Embedding-Identitäten), geht als PR ins PLUR1BUS-Repo. Der Harness enthält keine abweichende Kopie der Memory-Logik.

### 2.2 Basis

**Default: Variante A — PLUR1BUS Core (Node-Daemon) im Zentrum, Außenschichten als Distribution auf Hermes-Basis.**

Begründung: Hermes liefert die austauschbaren Außenschichten bereits und pflegt sie upstream — Provider-Auflösung mit drei Wire-Modi (`chat_completions`, `codex_responses`, `anthropic_messages`), OAuth-Flows und Credential-Pools, Plattform-Plugins für Telegram, Discord, Matrix und Buzz, MCP-Integration, ACP-Adapter, Skills, Plugin-System, Cron mit Zustellung, Profile (isolierte Instanzen), Subagenten, Web-Dashboard, Desktop-App, nativer Windows-Support. Die `MemoryProvider`-ABC (`prefetch`, `queue_prefetch`, `sync_turn`, `on_pre_compress`, `on_session_end`, `on_memory_write`, Tool-Schemas, `cli.py`, `config_schema.py`) passt auf den PLUR1BUS-Lebenszyklus. Ein Nachbau in TypeScript würde Provider-, OAuth- und Kanalpflege dauerhaft an mich binden.

Umsetzungsform: Das Repo `PLUR1BUS-Harness` nutzt Hermes als **gepinnte Abhängigkeit** und liefert das Delta ausschließlich über Plugins, Entry-Points, eigene Dienste (Core, Harness-API), Skin und Installer. Ein Hermes-Fork nur als minimaler Patch-Branch, falls ein benötigter Extension-Point fehlt — dann Patch klein halten, als Upstream-PR vorbereiten und in `UPSTREAM.md` dokumentieren (gepinnter Commit, Patchliste, Rebase-Prozedur).

**Kill-Kriterien für A** (in Phase 0 prüfen; trifft eines zu → ADR-001 mit Befund, Stopp):

- K1 (entscheidend): PLUR1BUS lässt sich unter Hermes nicht als **fester Kern** nach 2.1 betreiben — Recall vor dem API-Call mit Zeitbudget, nicht blockierendes Capture, Pre-Compress-Checkpoint, Kontrolle über alle Injektionspunkte (Recall-, Temporal-, Mood-, Persona-, Reaktivierungsblöcke), Abfangen von Kommandos und zitierten Antworten vor dem Agenten, Tools, Chat-Kommandos in Gateway und CLI, modellfreie Feature-Crons mit Zustellung, LLM-Zugriff für interne Jobs, Abschalten der Hermes-eigenen Memory-Schleife — ohne Eingriffe in den Agent-Loop.
- K2: Agentenverwaltung und Agent-zu-Agent-Beratung lassen sich auf Profilen, Multiplexing-Gateway und Subagent-API nicht ohne invasive Core-Änderungen bauen.
- K3: Auf einer Zielplattform (Abschnitt 10) ist der Doppel-Stack Python + Node nicht lauffähig zu bekommen.
- K4: Mehrbenutzerbetrieb ist nicht sauber durchsetzbar — Hermes-API und Dashboard lassen sich weder hinter eine Harness-API mit serverseitigem RBAC stellen noch durch eine eigene SPA ersetzen.

**Variante B (Fallback): eigenständiges TypeScript-Monorepo** (Node ≥ 22.22, pnpm), PLUR1BUS in-process als Kernpaket über denselben Host-Shim, eigene Provider-Schicht mit drei Wire-Formaten, Kanaladapter (Telegram, Discord, Matrix, Nostr/Buzz), offizielle MCP-, ACP- und A2A-TypeScript-SDKs, SQLite (`node:sqlite`, FTS5) für Sessions. Alle funktionalen Anforderungen dieses Auftrags gelten unverändert.

## 3. Phase 0 — Analyse und Plan (endet mit Stopp)

Liefere, ohne Produktivcode:

1. `docs/host-contract.md`: vollständige Liste der OpenClaw-Host-API, die PLUR1BUS tatsächlich nutzt — Hooks (`before_prompt_build`, `before_agent_reply`, `before_dispatch`, `gateway_start`), `runtime.llm.complete`, Memory-Slot-Runtime inkl. `classifyWorkspaceMemoryPaths`, Gateway-Methoden, CLI-Registrierung, Cron-Provisionierung, Control-UI-Deskriptor, Session-Entry-Form, Shutdown-Registrierung, Konfig-Schema — jeweils mit Fundstelle, Semantik, Zeitbudget und Abbildung auf Hermes bzw. den Shim. Dazu: alle Stellen, an denen PLUR1BUS Embedding- und Rerank-Aufrufe absetzt (OpenAI-SDK, Cohere, lokale ONNX-Modelle, Embedding-Owner, Caches), das heutige Prinzipalmodell (Kanal + Account + Benutzer) und die Annahme einheitlicher Embedding-Dimensionen über alle Recall-Tabellen.
2. `docs/hermes-gap-analysis.md`: jede Anforderung aus Abschnitt 5–9 × „vorhanden / per Plugin machbar / Core-Patch nötig", mit Fundstelle. Ausdrücklich prüfen: Modellschicht für Embedding und Reranking? Mehrbenutzer/RBAC in API-Server und Dashboard? A2A? Reifegrad der Plattform-Plugins `matrix` (E2EE?) und `buzz`.
3. `docs/provider-matrix.md` (Fähigkeiten `chat` / `embedding` / `rerank` je Provider) und `docs/platform-matrix.md` (Abschnitte 6 und 10), vollständig verifiziert.
4. `docs/import.md`: Quellformate von OpenClaw- und Hermes-Installationen (Versionen, Pfade, Schemata) und Abbildung auf den Harness (Abschnitt 4.2).
5. ADR-001 Basisentscheidung · ADR-002 PLUR1BUS Core und Host-Shim · ADR-003 Agentenmodell und Kollaboration · ADR-004 Web-UI und Harness-API · ADR-005 Auth-Policy und Secret-Speicher · ADR-006 Embedding-/Reranking-Dienst · ADR-007 Benutzer, Rollen, Identitätsverknüpfung · ADR-008 Protokolle (MCP, ACP, A2A).
6. Meilensteinplan mit Aufwandsschätzung, Risiken, Testplan.

Dann stoppen und Freigabe abwarten.

## 4. Zielarchitektur (Variante A)

```
PLUR1BUS-Harness/
├── core/                    PLUR1BUS Core (Node-Daemon): Host-Shim + @cyb3rb1ade/plur1bus-memory
│                            + Embedding-/Rerank-Dienst + JSON-RPC-Server
├── api/                     Harness-API: einzige exponierte Oberfläche (AuthN, RBAC, Audit, Rate-Limits),
│                            trägt Web-UI, REST/JSON-RPC, MCP-Server- und A2A-Endpunkte
├── cli/                     plur1bus-harness
├── plugins/
│   ├── plur1bus_memory/     MemoryProvider (Python) + config_schema.py + cli.py + Skills
│   ├── plur1bus_collab/     Agenten-Registry, Projekte, consult/delegate-Tools, Hooks
│   ├── plur1bus_providers/  Model-Provider-Plugins für Lücken aus der Provider-Matrix
│   └── plur1bus_dashboard/  Dashboard-Seiten + Skin — oder web/ als eigene SPA (ADR-004)
├── importers/               OpenClaw, Hermes
├── distro/                  Installer (install.sh, install.ps1), Default-Konfig, Branding, Dienst-Units
├── docs/                    adr/, host-contract.md, provider-matrix.md, platform-matrix.md, import.md, assumptions.md
├── tests/                   unit, contract, e2e
└── UPSTREAM.md
```

Prozesse: PLUR1BUS Core (Node) im Zentrum; Hermes-Laufzeiten (Python, ein Profil je Agent) hängen sich an; die Harness-API ist die einzige nach außen erreichbare Komponente, Core und Hermes-API-Server sind nur lokal dahinter erreichbar. Genau **ein** Core pro Installation, damit Stores, Embedding- und Reranker-Modelle nur einmal geöffnet bzw. geladen sind; mandantenfähig über `agentId`. IPC: JSON-RPC 2.0 — über stdio, wenn ein einzelner Elternprozess genügt, sonst Unix-Domain-Socket bzw. Windows Named Pipe mit Token und restriktiven Rechten. Kein offener TCP-Port außer der Harness-API.

CLI `plur1bus-harness`: `setup`, `doctor`, `agent`, `user`, `model`, `login`, `channel`, `memory`, `project`, `import`, `service`, `update`, `uninstall`. Unter Variante A kapselt sie die Hermes-CLI; `hermes` bleibt Implementierungsdetail.

### 4.1 PLUR1BUS Core (ADR-002)

- Stufe 1 (Pflicht): **Host-Shim**, der die in `host-contract.md` erfasste OpenClaw-Plugin-API emuliert, sodass das unveränderte npm-Paket läuft. Gegen die PLUR1BUS-Testsuite und eigene Contract-Tests prüfen; Versionen pinnen, Kompatibilitätsmatrix PLUR1BUS × Shim pflegen.
- Stufe 2 (optional, erst als Vorschlag an mich): hostneutraler Kern in PLUR1BUS (`core` + Adapter „OpenClaw" und „Harness"), verhaltensneutral, gesamte Suite grün.
- Abbildung: `prefetch` → Recall-Pipeline mit hartem Zeitbudget, Ergebnis als flüchtiger Kontextblock (System-Prompt bleibt stabil) · `queue_prefetch` → Vorwärmen · `sync_turn` → Auto-Capture, nicht blockierend (`spawn_context_thread`) · `on_pre_compress` → Checkpoint-API v2, idempotent über Transkript-Digest · `on_memory_write` → Spiegelung von `MEMORY.md`/`USER.md` · Tools `memory_store`, `memory_recall`, `memory_search`, `memory_forget`, `knowledge_update` · Chat-Kommandos (`/state`, `/memory`, `/forget`, `/correct`, `/mf`, `/share`, `/enable`, `/disable`, `/plur1bus …`) in CLI **und** allen Kanälen · `plur1bus-harness memory <doctor|setup|migrate|command …>`.
- Identität: Hermes-Profil ⇄ PLUR1BUS-`agentId`; der Shim reicht dem Kern den kanonischen Prinzipal (5.1) plus `chat_id`, `gateway_session_key`, `platform`. `agent_context` ∈ {`cron`, `subagent`} → keine automatischen Writes, keine Recall-Rekursion.
- Feature-Crons (u. a. `consolidate-daily`, `classify-recent`, `afterthought`, `rem-dream`, `skill-miner`, `persona-evolve`, `emotion-refine`, `discover-semantic-links`, `gc-run`) über den Harness-Scheduler: modellfrei (kein Träger-LLM-Lauf), pro Agent gestaffelt, Zustellung nur an validierte Ziele, fail-closed bei fehlender Fähigkeit.
- Modellzugriffe: interne **Chat**-Aufrufe von PLUR1BUS laufen über den Host (Modell und Credentials des jeweiligen Agenten, nie fest verdrahtet). **Embedding und Reranking** führt der Core selbst aus (Abschnitt 6.2) und bietet sie dem restlichen Harness als Dienst an.
- Fail-soft: Ausfall, Timeout oder Absturz des Core blockiert keinen Turn; Supervisor mit Backoff, Health-Check, Statusanzeige in der UI.
- Doppelte Lernschleifen vermeiden: Hermes-Skill-Autogenerierung/Curator ⇄ PLUR1BUS-`skillMiner`, Host-Dreaming ⇄ PLUR1BUS-REM. Eigentümer ist jeweils PLUR1BUS; Vorschlags-Queue teilen.

### 4.2 Importer für OpenClaw und Hermes

`plur1bus-harness import <openclaw|hermes>` und ein UI-Assistent; mehrfach ausführbar, auch nachträglich.

- **OpenClaw:** Agenten (IDs, Workspaces, Bindings), Persona, `MEMORY.md`/`USER.md`/`KNOWLEDGE.md`/`DREAMS.md`, Skills, Cron-Jobs, Kanal-Konfig und Allowlists, Modell-/Provider-Konfig — und die **PLUR1BUS-Stores** vollständig: LanceDB je Agent, Shared Pools, Neo-Store und Journale, `.adaptive-learning`, Tombstones, Audit-Logs, Obsidian-Vault. Übernahme ohne Re-Embedding, wenn die Embedding-Identität erhalten bleibt; sonst geführte Re-Embedding-Migration. `agentId`s erhalten oder über Mapping-Tabelle führen; Workspace- und User-Bindungen auf Harness-Prinzipale abbilden (unklare Bindungen bleiben unsichtbar, fail-closed).
- **Hermes:** Profile → Agenten, `SOUL.md`, `MEMORY.md`/`USER.md` → PLUR1BUS-Karten mit Herkunft `imported` (je nach Feature-Profil direkt oder über die Review-Queue), Skills, Cron-Jobs, Plattform-Konfig, Allowlists und Pairings, Sessions optional. Daten fremder Memory-Provider werden nicht übernommen. Baut auf `hermes claw migrate` auf, wo sinnvoll.
- Secrets nur Opt-in, allowlist-basiert, direkt in den Secret-Store; nie im Bericht.
- Eigenschaften: Dry-Run als Default, copy-never-move, idempotent und fortsetzbar, Snapshot vorher, Rollback, Versionserkennung der Quelle, Konfliktstrategie (überspringen / umbenennen / überschreiben mit Bestätigung), Bericht (JSON + lesbar) ohne Inhalte und Secrets. Tests gegen Fixture-Installationen beider Quellen.

## 5. Agenten, Benutzer und Rollen

- Agenten-CRUD über Web-UI, CLI und API: anlegen (aus Vorlage oder Klon; PLUR1BUS-Store zuerst, dann Laufzeitprofil, transaktional mit Rollback), bearbeiten, pausieren, archivieren, löschen (mit Export und Bestätigung; Store archive-first), Import/Export als Bundle ohne Secrets.
- **Genau eine Soul (`SOUL.md`) pro Agent** — dieselbe Persona auf allen Kanälen, über die der Agent erreichbar ist.
- Pro Agent: Eigentümer und Zugriffsrechte (5.1), Primärmodell + Fallback-Kette, Auth-Profil, **Embedding-Modell wählbar pro Agent/Store** (beim Anlegen oder per Migration) und Reranker (jederzeit), Toolsets, Skills, Plugins, MCP-Server-Allowlist, A2A-Freigabe, Kanalbindungen, Arbeitsverzeichnis/Terminal-Backend, Approval-Policy, Token-/Kostenbudget, PLUR1BUS-Konfig (Feature-Profil safe/recommended, Temperament, Namespaces), Zeitpläne.
- Laufzeit: Status, laufende Sessions, Unterbrechen, Logs, Verbrauch, Health. Agenten strikt isoliert (Konfig, Sessions, Secret-Scope, Memory).
- Technisch auf Hermes-Profilen aufsetzen (Agent = Profil), sofern Phase 0 das trägt.

### 5.1 Benutzer, Rollen, Identitäten (ADR-007)

- Mehrbenutzerbetrieb mit RBAC. Rollenvorschlag: **Owner** (Installation, Secrets, Lizenzbestätigungen, Benutzerverwaltung) · **Admin** (Agenten, Provider, Modelle, Kanäle) · **Operator** (Betrieb, Logs, Cron; keine Secrets) · **Member** (freigegebene Agenten nutzen, eigene Erinnerungen verwalten, Projekte) · **Viewer** (lesend). Dazu objektbezogene Rechte: pro Agent (nutzen / verwalten), pro Projekt (Mitglied / Lead).
- Durchsetzung serverseitig in der Harness-API für UI, CLI, API-Tokens, MCP- und A2A-Endpunkte sowie Kanäle; deny by default.
- Anmeldung: lokale Konten (Argon2id), optional OIDC-SSO, 2FA (TOTP, WebAuthn), Sitzungen mit Ablauf und Widerruf, persönliche API-Tokens mit Scopes, Brute-Force-Schutz. Erst-Bootstrap des Owners über ein Einmal-Token aus Installer bzw. Konsole.
- **Identitätsverknüpfung:** Harness-Benutzer ⇄ Kanalidentitäten (Telegram-ID, Discord-ID, Matrix-MXID, Nostr-Pubkey) per Pairing-Code. Der Core sieht einen kanonischen Prinzipal, sodass `user`-Scope-Erinnerungen kanalübergreifend demselben Menschen gehören. Unverknüpfte Kanalidentitäten bleiben getrennte Prinzipale (fail-closed); Zusammenführen nur mit Bestätigung, Trennen jederzeit. Nötige Erweiterung des PLUR1BUS-Prinzipalmodells als PR.
- Privatsphäre: `user`-Scope-Karten sieht in der UI nur der jeweilige Benutzer; Admin-Einsicht ausschließlich als Break-Glass mit Begründung und Audit-Eintrag. `agent-private` sehen nur Verwalter des Agenten. Auskunft, Export und endgültige Löschung der eigenen Daten (Archive eingeschlossen) auf Anforderung.

## 6. Modelle, Provider und Authentifizierung

Modellarten im gesamten Harness: `chat`, `embedding`, `rerank` (Registry erweiterbar). Ein **Provider-Profil** (Base-URL, Auth, Header) deckt alle Arten ab, die der Endpoint anbietet. Zuweisung nach Zweck mit Installationsstandard und Überschreibung pro Agent/Store: Chat-Primärmodell und Fallbacks, Hilfsmodell für interne Jobs, `memory.embedding`, `memory.reranker`, weitere Verbraucher (Session-Suche, Skill-/Tool-Retrieval, Projekt-RAG, semantische Link-Entdeckung).

### 6.1 Chat-Modelle

Drei Wire-Formate — OpenAI Chat Completions, OpenAI Responses, Anthropic Messages — jeweils mit SSE-Streaming, Tool-Calling, Reasoning/Thinking, Vision, Usage und Prompt-Caching, soweit vorhanden. **Generische Templates** „OpenAI-kompatibel" und „Anthropic-kompatibel" (Base-URL, Auth-Header-Schema, Modellliste manuell oder via `/v1/models`, Header-Overrides, Capability-Flags) müssen jeden weiteren Endpoint ohne Code abdecken.

Mindestumfang der mitgelieferten Profile; Details in `docs/provider-matrix.md` (Wire-Format je Modell, Base-URL, Auth-Arten, Discovery, Fähigkeiten, Besonderheiten, Quelle, Prüfdatum):

| Gruppe | Provider | Auth |
|---|---|---|
| Groß | OpenAI Platform | API-Key |
| | OpenAI ChatGPT/Codex-Abo | OAuth (PKCE, Loopback) + Device-Code |
| | Anthropic API | API-Key |
| | Anthropic Claude-Abo | nur gemäß Auth-Policy (6.3) |
| | Google AI = Gemini API über AI Studio | API-Key |
| | Google-Gemini-Abo-Logins (Gemini CLI / Code Assist / Antigravity) | nur gemäß Auth-Policy (6.3) |
| | xAI API | API-Key |
| | xAI Grok-Abo (SuperGrok / X Premium+) | Device-Code; bei 403-Tier-Gating Hinweis + Fallback API-Key |
| Aggregatoren | OpenRouter | API-Key (+ OAuth-PKCE-Key-Bezug, falls verfügbar) |
| | OpenCode Zen / OpenCode Go (= „OpenCode-Provider") | API-Key; Chat-, Responses- und Messages-Endpunkte je Modell |
| | Nous Portal (= „Hermes-Provider") | OAuth + API-Key |
| | Ollama Cloud | API-Key |
| Lokal | Ollama, LM Studio, llama.cpp (`llama-server`), vLLM, mlx-lm (`mlx_lm.server`), oMLX | keiner / optionaler Key |
| Optional | Google Vertex AI | ADC / Service-Account |

Lokale Provider: Auto-Discovery (bekannte Ports, `/v1/models`, Health), Capability-Probe (Tools, Vision, Kontextlänge, Embedding, Rerank), klare Fehlermeldung bei fehlendem Tool-Template.

Routing: Modell-Aliase, Fallback-Ketten, Timeouts, Retry mit Backoff, Budget-Limits pro Agent, Projekt und Benutzer, Kosten-/Token-Tracking.

### 6.2 Embedding- und Reranking-Modelle (Pflicht, ADR-006)

**Eigentümer ist der PLUR1BUS Core.** Er führt Embedding und Reranking aus (lokal in-process und remote), lädt jedes lokale Modell genau einmal und bietet dem restlichen Harness `embed()` und `rerank()` als internen Dienst mit zweckgebundenen Quoten an. Der Harness liefert Provider-Profile, Secrets (Lease zur Laufzeit, nie in der PLUR1BUS-Konfig persistiert), Modellkatalog und UI. Neue Adapter landen als PRs im PLUR1BUS-Repo, damit auch das OpenClaw-Plugin sie bekommt.

Quellen (✔ = bekannt, ? = in Phase 0 klären):

| Quelle | Embedding | Rerank | Hinweis |
|---|---|---|---|
| In-process (Transformers.js/ONNX, wie PLUR1BUS) | ✔ E5-small (keyless Fallback), Jina v3, Jina v5 Text Nano | ✔ BGE v2-m3 (Default, Apache-2.0), Jina Reranker v2 | gepinnte Revisionen, SHA-256-Prüfung, Lizenzbestätigung für CC BY-NC |
| OpenAI | ✔ | – | `dimensions`-Parameter |
| Google AI (Gemini API) | ✔ | ? | `task_type`, Ausgabedimension |
| Cohere, Jina AI, Voyage AI | ✔ | ✔ | reine Embedding-/Rerank-Profile; `input_type` bzw. `task` |
| OpenRouter | ✔ | ? | Upstream-Provider pinnen (s. Identität) |
| Anthropic, xAI, OpenCode Zen/Go, Nous Portal, Ollama Cloud | ? | ? | |
| Ollama, LM Studio | ✔ | ? | |
| llama.cpp (`--embedding`, `--reranking`), vLLM (`/v1/embeddings`, `/v1/rerank`, `/v1/score`), oMLX (`/v1/embeddings`, `/v1/rerank`) | ✔ | ✔ | |
| mlx-lm | ? | ? | |
| Hugging Face TEI, Infinity (self-hosted) | ✔ | ✔ | |

Wire-Formate: Embeddings — OpenAI-kompatibel (`/v1/embeddings`), Gemini-nativ, Cohere, Jina, Ollama-nativ, TEI. Rerank hat keinen OpenAI-Standard → normalisierte Schnittstelle `rerank(query, documents[], top_n) → [{index, score}]` mit Adaptern für Cohere-, Jina-, TEI-, vLLM-, llama.cpp- und oMLX-Stil. Generische Templates „OpenAI-kompatible Embeddings" und „Cohere/Jina-kompatibles Rerank" für beliebige Endpoints.

Modellkatalog: je Embedding-Modell native Dimension, Matryoshka-Stufen, maximale Eingabetokens, Präfix-/Task-Schema (z. B. `query:`/`passage:`, `Query:`/`Document:`, `input_type`, `task_type`), Normalisierung, Sprachen, Lizenz, Kosten; je Reranker Kontext pro Paar, maximale Dokumente pro Request, Lizenz.

**Standardwahl bei der Installation:** Installer und Wizard **fragen** nach dem Embedding-Modell und zeigen den Lizenzhinweis. Vorschlag wie in PLUR1BUS 7.12: Jina v5 Text Nano (CC BY-NC 4.0, nicht kommerziell — ausdrückliche Bestätigung nötig), Alternativen OpenAI (gehostet), E5 (keyless), eigener Endpoint. Nicht-interaktive Installation: Bestätigung nur per explizitem Flag bzw. Umgebungsvariable, sonst Fallback auf E5 — nie stillschweigend akzeptieren. Bestätigung (wer, wann, welche Lizenz) ins Audit-Log; nur der Owner darf bestätigen. Gleiches Verfahren für Reranker mit NC-Lizenz.

**Embedding-Identität** = Modell + Revision bzw. Artefakt-Hash + Quantisierung + Dimension + Präfix-/Task-Schema + Normalisierung + Token-Cap (+ bei Aggregatoren der gepinnte Upstream). Sie wird je Store und Generation gespeichert und steckt in jedem Cache-Key. Regeln:

- Niemals Vektorräume mischen. Jede Änderung der Identität läuft über die PLUR1BUS-Re-Embedding-Migration (Ziel vorbereiten → Dry-Run → Kopie in neue Generation → separater Switch → alte Generation bleibt für Rollback) — in der UI pro Store steuerbar, fortsetzbar, mit Kosten- und Dauerschätzung, Rate-Limit und Batch-Steuerung.
- **Wählbar pro Agent/Store** heißt: Private Stores, Workspace-Pools und User-Pools können verschiedene Identitäten haben. Folgen: `/share` kopiert Text und bettet in der Identität des Ziel-Pools **neu** ein (nie Vektoren kopieren); Recall über mehrere Stores bettet die Query je Identität einmal ein und fusioniert rangbasiert bzw. über den Reranker, da Ähnlichkeitswerte verschiedener Identitäten nicht vergleichbar sind; die heutige PLUR1BUS-Annahme einheitlicher Dimensionen über alle Recall-Tabellen wird per PR aufgehoben. Mehrere lokale Modelle gleichzeitig → RAM-Budget mit LRU-Entladen, Pinning, Obergrenze und Warnung beim Anlegen eines Agenten mit neuem lokalen Modell.
- Failover nur zwischen Endpoints derselben Identität (zweiter Key, zweiter Server). Vor der ersten Nutzung eines Endpoints für einen bestehenden Store: **Kompatibilitätsprobe** (festes Probe-Set einbetten, gegen gespeicherte Referenzvektoren prüfen); bei Abweichung ablehnen.
- Ausfall: Capture schreibt ins Journal und bettet später ein (vorhandene Queue nutzen bzw. ergänzen); Recall degradiert sichtbar (lexikalisch/Recency) statt zu blockieren. Timeout pro Request (PLUR1BUS-Default 15 s), keine SDK-Retries im Hot Path.
- Schwellenwerte (Duplikat 0,95, reserviertes Band ≥ 0,96, semantische Links 0,78) hängen an der Identität: Kalibrierlauf (Noise-Band, Margen) nach jedem Modellwechsel, Vorschlag neuer Schwellen, Warnung bei engem Ähnlichkeitskegel.
- Lokale Modelle: Token-Cap (Default 512) gegen OOM, CPU-Budget und Parallelität begrenzen und anzeigen, Warm-up, Download-Manager mit Fortschritt, Wiederaufnahme und Offline-Import.

**Reranker** sind zur Laufzeit ohne Datenmigration umschaltbar (Installationsstandard und pro Agent), mit Timeout (Default 5 s) und Fallback auf reines Vektor-Ranking. Scores verschiedener Reranker sind nicht vergleichbar → Schwellen pro Reranker oder rangbasierte Fusion.

Qualitätssicherung: Retrieval-Benchmark (vorhandenes `bench/` prüfen und ausbauen; reale Recall-Queries gegen ein Referenzranking) als Regressionstest und als Entscheidungshilfe in der UI beim Modellwechsel.

### 6.3 Auth-Engine

- Arten: API-Key, OAuth 2.0 Authorization Code + PKCE (Loopback), Device Authorization Grant (RFC 8628), ADC/Service-Account. **Auth-Profile deklarativ** (Daten, nicht Code): Endpunkte, Scopes, Client-Registrierung, Redirect, Refresh-Verhalten.
- Headless/SSH-tauglich: Device-Code bevorzugen; Loopback mit konfigurierbarem Port, Hinweis auf `ssh -L`, Fallback „Callback-URL einfügen". Login aus Web-UI, CLI und Chat-Kanal startbar.
- Token-Lebenszyklus: Refresh vor Ablauf, Rotation, Widerruf/Logout, Mehrkonten und Credential-Pools mit Failover bei 401/429, Status in der UI (gültig bis, Plan/Tier, letzter Fehler).
- Secrets: OS-Schlüsselbund (macOS Keychain, Windows Credential Manager/DPAPI, libsecret) mit verschlüsseltem Datei-Fallback für Headless-Server; nie im Klartext in Konfig, Logs, Browser oder Exporten. Hermes-Secret-Source-Plugins nutzen, wo möglich. Der Core erhält Secrets nur als kurzlebige Lease. Verwaltung nur durch Owner/Admin.
- **Auth-Policy (ADR-005):** pro Auth-Profil `policy_status` ∈ {`allowed`, `restricted`, `prohibited`} mit Quelle und Prüfdatum. `prohibited` wird nie ausgeliefert; `restricted` als Opt-in mit sichtbarem Risikohinweis (Default, vorbehaltlich Frage in Abschnitt 13). Keine Client-Imitation (fremde Client-IDs, User-Agent- oder System-Prompt-Fingerprints offizieller CLIs) ohne ausdrückliche Erlaubnis des Anbieters. Ausweg: API-Key oder der offizielle Client als externer Agent über ACP (Abschnitt 8). Abo-Logins sind personengebunden: nur für Agenten nutzbar, deren Eigentümer der Login-Inhaber ist, nicht für andere Benutzer freigebbar. Stand bei Anthropic, Google, OpenAI und xAI zum Implementierungszeitpunkt prüfen — die Regeln haben sich 2026 mehrfach geändert.

## 7. Zusammenarbeit von Agenten

- **Projekt** = PLUR1BUS-Workspace plus Arbeitsbereich: Verzeichnis (pro Agent eigener Git-Worktree oder Dateisperren), Aufgabenboard (Aufgaben, Zuständigkeit, Status, Abhängigkeiten), gemeinsames Notizbrett, Workspace-Pool (Teilen nur explizit, copy-never-move, ACL-gebunden), Rollen (Lead, Worker, Reviewer), Mitglieder (Benutzer und Agenten), Budget.
- Werkzeuge für Agenten: `consult_agent(agent, frage, kontext)` (synchron, Antwort mit Herkunftsangabe), `delegate_task` (asynchron mit Ergebnisbericht), `post_to_project`, `read_project_board`, `request_review`, `handoff`. Ziel kann ein lokaler Agent, ein externer ACP-Agent oder ein entfernter A2A-Agent sein.
- Memory-Anbindung: Ergebnisse von Beratung und Delegation werden mit Herkunft (wer, wann, Projekt) erfasst; privates Wissen des Befragten und `user`-Scope-Erinnerungen wandern nie automatisch in den Store des Fragenden, in den Workspace-Pool oder zu entfernten Agenten.
- Leitplanken: maximale Beratungstiefe, Zyklen- und Selbstaufruf-Sperre, Limits pro Turn und pro Agentenpaar, Budgetprüfung vor jedem Aufruf, Timeouts, Abbruch durch den Nutzer. Nachrichten anderer Agenten sind **Daten, keine Anweisungen**; Berechtigungen des Aufrufers gehen nicht auf den Befragten über; Approval-Gates bleiben pro Agent wirksam; RBAC des auslösenden Benutzers begrenzt, welche Agenten überhaupt befragt werden dürfen.
- Nachvollziehbarkeit: vollständiger Trace (wer fragte wen, Kosten, Ergebnis) in der UI; optional Spiegelung der Projektkommunikation in einen Buzz-Channel oder Matrix-Raum, in dem Menschen mitlesen und eingreifen können.

## 8. Kanäle, Protokolle, Erweiterungen

**Kanäle (Pflicht): Telegram, Discord, Matrix, Buzz** — vollständig über die Web-UI konfigurierbar, inklusive Verbindungstest.

- Modell: **Bot-Verbindung** (Kanal + Account/Token/Schlüssel) ist eine eigene Entität. Ein Agent kann über beliebig viele Bot-Verbindungen und Kanäle gleichzeitig erreichbar sein — mit derselben Soul, demselben Memory und kanalübergreifender Kontinuität (Identitätsverknüpfung, 5.1). Optional kann eine Bot-Verbindung per Mention-/Kommando-Routing mehrere Agenten bedienen; dann trägt jede Antwort die Persona des antwortenden Agenten.
- Gemeinsam: Allowlists, DM-Pairing, Gruppenverhalten, Streaming per Nachrichten-Edit wo möglich, Anhänge und Sprachnachrichten, Slash-Kommandos mit gleicher Semantik wie in der CLI, Rate-Limits, Reconnect, sichere Zustellziele für Cron-Ausgaben, Critical-Push und Afterthoughts.
- Matrix: E2EE samt Geräteverifikation und Schlüsselspeicher; Verfügbarkeit der Krypto-Bibliothek auf allen Zielplattformen in Phase 0 prüfen.
- Buzz: Agent = eigenes Nostr-Schlüsselpaar (im Secret-Store), NIP-42-Auth, Relay-URL je Community, Channels/Threads/DMs, Reaktionen. Vorhandenes Hermes-Plugin `buzz` zuerst bewerten, Lücken schließen; Kompatibilität mit `buzz-cli` und `buzz-acp` testen.

**Protokolle (ADR-008) — MCP, ACP und A2A sind Pflicht:**

- **MCP:** Client (stdio und Streamable HTTP, OAuth für Remote-Server, Allowlist und Tool-Approval pro Agent, Verwaltung in der UI) und Server (Harness-Funktionen und PLUR1BUS-Memory-Tools für fremde MCP-Hosts, Auth und Scope über Harness-Benutzer bzw. API-Token).
- **ACP = Agent Client Protocol** (JSON-RPC über stdio), in beide Richtungen: als ACP-Agent (Zed, JetBrains, VS Code, `buzz-acp` steuern den Harness) und als ACP-Client (Claude Code, Codex, Gemini CLI, Goose als externe Teammitglieder).
- **A2A = Agent2Agent** (Linux-Foundation-Projekt; deckt auch das darin aufgegangene „Agent Communication Protocol" ab), in beide Richtungen. Server: pro Agent per Opt-in, Agent Card unter `/.well-known/agent-card.json` (je Agent eigener Basis-Pfad oder Tenant), JSON-RPC-Binding Pflicht, HTTP+JSON und gRPC optional, SSE-Streaming, Push-Notifications optional, Task-Lebenszyklus auf Harness-Sessions/Aufgaben abgebildet, Spec v1.0 mit 0.3-Kompatibilität, sofern das offizielle SDK sie bietet. Client: entfernte Agenten per URL/Card registrieren, Vertrauensstufe, Allowlist pro Agent, Budget; nutzbar in `consult_agent`/`delegate_task`. Sicherheit: standardmäßig aus; nur über die Harness-API mit TLS, Auth nach den Security-Schemes der Card (auf Harness-Benutzer/API-Tokens und RBAC abgebildet), Rate-Limits; Agent Card und Skills verraten keine Memory-Inhalte; Inhalte entfernter Agenten sind Daten.

**Skills:** `SKILL.md` nach agentskills.io, pro Agent aktivierbar, Installation aus Hub/Git/lokal, Versionierung, Vorschau vor Aktivierung. PLUR1BUS-Skill-Vorschläge (`/plur1bus skills …`) landen in derselben Freigabe-Queue.

**Plugins:** Hermes-Plugin-API (Tools, Hooks, Middleware, CLI, Provider-Typen). Vertrauensmodell: Quelle und Version pinnen, Projekt-Plugins nur Opt-in, Rechteanzeige vor Aktivierung, pro Agent deaktivierbar; Installation nur durch Admin.

## 9. Web-UI in PLUR1BUS-Optik

- Vorlage ist der PLUR1BUS-Tab der OpenClaw-Control-UI (`/plugins/memory-lancedb-namespaced/control`). **Referenz ist der Quellcode, es gibt keine gelieferten Screenshots:** Renderer im PLUR1BUS-Repo lokal mit Fixture-Daten rendern und daraus eigene Referenzbilder erzeugen; Karten-Layout, Statusbadges, Readiness-Tabellen, Banner-Rückmeldungen, dunkel als Default, hell nach OS-Einstellung übernehmen. Design-Tokens (Farben, Radien, Typografie, Abstände), die der Tab zur Laufzeit vom Host erbt, aus dem Control-UI-Quellcode von OpenClaw übernehmen (Lizenz und Attribution prüfen) und als eigenes Theme bereitstellen. Keine gewollten Abweichungen außer Wortmarke „PLUR1BUS Harness".
- Weg (ADR-004): (a) Hermes-Dashboard per Skin + Plugin-Seiten oder (b) eigene SPA über die Harness-API. Mehrbenutzerbetrieb und RBAC müssen in beiden Fällen serverseitig in der Harness-API liegen; trägt (a) das nicht, ist (b) gesetzt. Kein Rewrite des Hermes-Frontends im Fork.
- Ersteinrichtung als Wizard: Owner-Bootstrap → Embedding- und Reranker-Wahl mit Lizenzhinweis und Modellvorbereitung → erster Provider-Login → erster Agent → erster Kanal → optional Import aus OpenClaw/Hermes.
- Seiten, Memory als Hauptbereich: **Memory** (Health, Karten nach Agent/Workspace/User, Suche mit Explain, Reviews/Critical-Push, Konflikte, Migration, Compact) · **Modelle** (Chat, Embedding, Reranking: Katalog, Zuweisung nach Zweck und Store, Embedding-Planer, Modellvorbereitung, Kompatibilitätsprobe, Kalibrierung, Benchmark, RAM-Budget) · Agenten (CRUD, Detail, Zugriffsrechte) · Benutzer & Rollen · Mein Bereich (eigene Erinnerungen, verknüpfte Kanalidentitäten, API-Tokens, 2FA) · Provider & Logins (inkl. Device-Code-Dialog, Policy-Status) · Kanäle & Bot-Verbindungen · Projekte & Kollaborations-Trace · Skills · Plugins · MCP/ACP/A2A · Cron · Import · Sessions/Logs/Audit · Einstellungen/Secrets · Doctor. Sichtbarkeit aller Seiten und Aktionen folgt der Rolle.
- Sicherheit: Loopback-Bindung als Default; Fernzugriff über Reverse-Proxy/VPN oder eingebautes TLS dokumentieren. Sitzungs-Cookies `HttpOnly`/`SameSite`, CSRF-Schutz mit Einmal-Token für schreibende Aktionen, strikte CSP (keine Inline-Skripte ohne Nonce), Schreibaktionen stufenweise freischaltbar, Secrets verlassen den Server nie.
- i18n Deutsch/Englisch, responsiv, tastaturbedienbar, WCAG 2.1 AA.

## 10. Plattformen und Auslieferung

Ziele, nativ (ohne WSL oder Emulation): macOS arm64 (x64 nach Möglichkeit), Windows x64 und ARM64, Linux x64 und ARM64 (glibc; musl optional).

- `docs/platform-matrix.md`: je Ziel die Verfügbarkeit vorgebauter Binaries für `@lancedb/lancedb`, `onnxruntime-node`/`@huggingface/transformers` (lokale Embedding- und Reranker-Modelle müssen auf **jedem** Ziel laufen), `sharp`, `node:sqlite` sowie der Python-Wheels von Hermes (inkl. Matrix-Krypto). Hardwarebeschleunigung (CoreML, DirectML, CUDA) optional bewerten. Lücken mit Workaround (Build aus Quelle, Feature-Degradierung, x64-Emulation nur als dokumentierte Notlösung) oder als K3-Befund.
- **PLUR1BUS-Windows-Portierung als eigenes Arbeitspaket.** Das Projekt dokumentiert bisher Linux- und macOS-Portabilität. Prüfen und beheben: Unix-Socket-basierter Embedding-Owner → Named Pipes; Dateirechte `0o600/0o700` → ACLs; Pfad- und Symlink-Annahmen, fd-basierte Verzeichnisrouten, Shell-Skripte (`scripts/*.sh` → plattformneutrale Node-Skripte), Dateisperren, Groß-/Kleinschreibung. Fixes als PRs im PLUR1BUS-Repo, nicht als Harness-Workaround.
- Shell-Tooling unter Windows: mitgeliefertes Git Bash (wie Hermes) oder PowerShell-Backend; Pfade und Quoting testen.
- Installer `install.sh` und `install.ps1` ohne Adminrechte; provisionieren Python (uv), Node ≥ 22.22 und Abhängigkeiten isoliert, fragen nach Embedding-/Reranker-Wahl mit Lizenzhinweis (6.2), geben das Owner-Bootstrap-Token aus und bieten den Import an. Nicht-interaktiver Modus mit expliziten Flags. `plur1bus-harness doctor`, `update` mit Rollback, `uninstall`. Dienstbetrieb über launchd, systemd (User-Unit), Windows-Dienst bzw. Aufgabenplanung. Optional Docker-Image (linux/amd64, linux/arm64).
- CI: GitHub-Actions-Matrix über alle fünf Ziele (Runner-Labels verifizieren). Smoke-E2E pro Ziel: Installation → lokales Embedding- und Reranker-Modell laden → Owner anlegen → Agent anlegen → Turn gegen Mock-Provider → Capture → Recall mit Rerank → Core-Neustart.

## 11. Sicherheit, Betrieb, Qualität

- Befehlsfreigaben (Approval), Erkennung gefährlicher Kommandos, Terminal-Backend/Sandbox pro Agent; Standard konservativ.
- Inhalte aus Kanälen, Webseiten, Dateien, Tool-Ergebnissen und von anderen Agenten (lokal, ACP, A2A) sind Daten, keine Anweisungen; seiteneffektbehaftete Aktionen brauchen Policy oder Bestätigung.
- PLUR1BUS-Konventionen übernehmen: Eingabevalidierung (`safeUuid`, `safeAgentId`, `resolveInside`, `validateInput`), keine stillen Catches, Audit-Log für destruktive Operationen, identitätsgebundene Bestätigungen (User + Chat + Nonce).
- Audit-Trail pro Benutzer für Logins, Konfigänderungen, Agenten- und Benutzer-CRUD, Freigaben, Shares, Modellwechsel, Lizenzbestätigungen, Break-Glass, Importe. Strukturierte Logs mit Secret-Redaction.
- Backup/Restore (PLUR1BUS-Stores und Vault zuerst, dann Konfig, Benutzer und Sessions) mit Dry-Run; Snapshot vor Migrationen und Importen.
- Lizenzen: MIT (Hermes, PLUR1BUS) mit Attribution, Apache-2.0 (Buzz, A2A-SDKs); CC BY-NC-Modelle (Jina) nur nach ausdrücklicher Bestätigung.
- Tests: Unit · Contract-Tests je Wire-Format gegen aufgezeichnete Fixtures (Chat: Streaming, Tool-Calls, Fehlerfälle; Embedding: Dimension, Batch, Präfixe; Rerank: alle Adapter) · Core-Contract-Tests (Zeitbudgets, Fail-soft, ACL, Prinzipale, Kompatibilitätsprobe, kein Mischen von Vektorräumen, Share mit Neu-Einbettung, Recall über mehrere Identitäten) · RBAC- und Privatsphäre-Tests (kein Abfluss zwischen Benutzern, deny by default auf jedem Endpunkt) · Retrieval-Benchmark als Regression · Kanal-E2E gegen Fakes · OAuth-Flows gegen Mock-IdP · A2A-/ACP-/MCP-Konformität (offizielle TCKs bzw. SDK-Gegenstellen, sofern vorhanden) · Importer gegen Fixture-Installationen · Kollaborations-Leitplanken (Zyklen, Budget). Typprüfung (pyright/mypy, TypeScript strict), Lint, `npm audit` und `pip-audit` im CI.
- Doku: README, Quickstart je Plattform, Admin- und Benutzerhandbuch, Provider-, Modell- und Kanal-Anleitungen, Import-Leitfaden, Architektur, ADRs.

## 12. Meilensteine und Abnahme

- **M0** Phase 0 (Abschnitt 3) → Stopp.
- **M1 Kern:** PLUR1BUS Core + Host-Shim + MemoryProvider; lokales Embedding und Reranking; Recall, Capture, Tools, Kommandos in der CLI; Fail-soft. *Abnahme:* Fakt in Session 1 genannt, in Session 2 korrekt erinnert (mit Rerank); `/forget` archive-first; Core-Kill blockiert keinen Turn; Hermes-eigene Memory-Schleife ist aus.
- **M2 Modelle, Provider & Auth:** Matrix vollständig, generische Templates für Chat, Embedding und Rerank, Auth-Engine, Secret-Store. *Abnahme:* Device-Code-Login headless über SSH; Refresh übersteht Neustart; je ein Turn mit Tool-Call über alle drei Chat-Wire-Formate; Embedding über einen Remote-Endpoint und zwei lokale Server; Rerank lokal (BGE) und über einen Remote-Adapter; zwei Agenten mit verschiedenen Embedding-Identitäten parallel, `/share` in einen Pool bettet neu ein; Modellwechsel per Migration mit Rollback; Kompatibilitätsprobe schlägt bei falschem Modell an.
- **M3 Harness-API, Benutzer/Rollen, Agentenverwaltung, Web-UI-Grundgerüst** in PLUR1BUS-Optik, Memory- und Modelle-Bereich zuerst. *Abnahme:* Wizard inkl. Lizenzabfrage durchlaufen; zwei Agenten per UI anlegen, betreiben, löschen; ein Member sieht nur freigegebene Agenten und nur eigene `user`-Erinnerungen; Break-Glass erzeugt Audit-Eintrag.
- **M4 Kanäle:** Telegram, Discord, Matrix, Buzz inkl. Kommandos, Cron-Zustellung und Identitätsverknüpfung. *Abnahme:* derselbe Agent mit derselben Soul auf allen vier Kanälen; ein verknüpfter Benutzer wird auf zwei Kanälen als derselbe Prinzipal erinnert, ein unverknüpfter nicht; Feature-Cron stellt an validiertes Ziel zu.
- **M5 Kollaboration:** Projekte, `consult_agent`/`delegate_task`, Leitplanken, Trace, Spiegelung nach Buzz/Matrix. *Abnahme:* Agent A löst eine Aufgabe mit Rat von Agent B; Zyklusversuch wird unterbunden; Trace vollständig; kein ungewollter Abfluss privater Erinnerungen.
- **M6 MCP/ACP/A2A/Skills/Plugins** in der UI. *Abnahme:* MCP-Server per UI hinzufügen und nutzen; PLUR1BUS-Tools aus fremdem MCP-Host; Steuerung aus Zed; externer ACP-Agent als Teammitglied; fremder A2A-Client findet die Agent Card, sendet einen Task und erhält ein gestreamtes Ergebnis; ein Harness-Agent konsultiert einen entfernten A2A-Agenten.
- **M7 Importer:** OpenClaw und Hermes. *Abnahme:* OpenClaw-Installation mit PLUR1BUS-Stores — Dry-Run-Bericht, dann Übernahme ohne Re-Embedding, alte Erinnerungen werden erinnert, Quelle unverändert; Hermes-Profil — Soul, Skills, Cron übernommen, `MEMORY.md`-Einträge als Karten mit Herkunft; zweiter Lauf ist idempotent.
- **M8 Plattformhärtung und Release:** Installer, Dienste, CI-Matrix grün auf allen fünf Zielen, Doku, v0.1.0.

Nach jedem Meilenstein: Demo-Anleitung, Testbericht, offene Punkte — dann auf Freigabe warten.

## 13. Entscheidungen und offene Fragen

**Entschieden:** Name, Repo, CLI, Lizenz (Abschnitt 0) · „Hermes-Provider" = Nous Portal, „OpenCode-Provider" = OpenCode Zen/Go, „Google AI" = AI Studio · Protokolle: Agent Client Protocol **und** A2A · UI-Referenz ist der Quellcode · Importer für OpenClaw und Hermes · eine Soul pro Agent, Agent auf mehreren Kanälen · Mehrbenutzerbetrieb mit Rollen · Installer fragt nach dem Embedding-Modell und weist auf die Lizenz hin · Embedding wählbar pro Agent/Store.

**Offen (vor der jeweiligen Phase fragen; bis dahin gilt der Default):**

1. Basis: Variante A bestätigt? (Default: A mit Kill-Kriterien.)
2. macOS x64: Pflicht oder Kür? (Default: Kür.)
3. Abo-Logins mit Status `restricted`: Opt-in mit Risikohinweis oder ganz weglassen? (Default: Opt-in.)
4. Soll eine Bot-Verbindung optional mehrere Agenten per Routing bedienen können, oder genügt „ein Agent, viele Verbindungen"? (Default: beides unterstützen, Routing nachrangig.)
5. Rollenmodell aus 5.1 passend, oder schlanker (Owner / Admin / Member)?

# P4-W · Inventar der Wire-Bibliotheken

Stand W1, 18. November 2026. Bestandsaufnahme aus W0 auf `origin/main` bei `fc113b4e2d`.
Maßgeblich sind die Paketkarte mit den Nachträgen 1 bis 3 und der [Phase-4-Plan](../superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md).
Die [Quellzeilen](../superpowers/plans/phase4/MODULE-MAP.md#source-rows) und
[Testzeilen](../superpowers/plans/phase4/MODULE-MAP.md#test-rows) des MODULE-MAP geben die
Einzeldateien je P4-Paket an. Die folgenden Abschnitte schneiden diese Zuordnung auf den
Bibliotheksumfang zu. Bei den folgenden Meilensteinen beschreiben die Modi und offenen Vektoren die geplante Abnahme.

## Bereiche, Testmodi und Ports

### W1 · Modell-Anbieter (P4-41)

- **Dateien.** [Provider-Quellen](../../packages/providers/src) für Chat Completions, Anthropic,
  Gemini, Responses, SSE, Accumulator, Reasoning, Profile und Router. Dazu lokale Adapter, Probe
  und Unix-Socket-Transport in `local/` sowie [Cache-Emitter](../../packages/core/src/composition/cache-emit.ts),
  [AF1-Komposition](../../packages/core/src/composition/apple-fm.ts) und
  [AF2-Socket-Guard](../../packages/core/src/apple-fm/socket.ts).
- **Tests.** Die [Provider-Tests](../../packages/providers/test) und
  [Model-Routing-Tests](../../packages/core/test/model-routing) liefern W für Requests, Streams,
  Abbruch, Fehler und Fallback. Cache-Profile, Cache-Emitter und AF2-Guard liefern V. In
  `apple-fm-runtime.test.ts` ist das Gespräch mit `fm serve` W, die Core-Komposition folgt beim Flip.
  `cache-profile-vectors.ts` bleibt der TS-Exporter.
- **Ports.** Credentials beziehungsweise Header-Leases, Egress- und Endpoint-Freigabe, Uhr und
  Wartefunktion für den Breaker, Socket-Pfad und Prozess-/Datei-Metadaten für lokale Server. Cache-
  Profilwahl und Router-Inputs kommen vom Aufrufer. `host.llm.complete` und Pool-Zustand folgen beim Flip.
- **Umsetzung.** [`plur1bus-providers`](../../crates/plur1bus-providers/src) enthält die vier
  blockierenden Wire-Adapter, SSE-Akkumulation, Fehlerklassifikation, Reasoning und den Router mit
  Breaker, Retry und Fallback. Dazu kommen die keyless Modellabfragen für Ollama und
  OpenAI-kompatible Endpunkte, AF1 über den privaten Unix-Socket mit AF2-Prüfung sowie der
  Cache-Emitter für Marker, TTL und Affinity. W prüft Request-Bytes, SSE-Deltas, Usage, EOF,
  Anbieterfehler und P4D-40. V prüft Router, Reasoning, Cache-Emitter und die bestehenden Cache-Profile.
- **Flip.** Der Flip bindet Profile und Kandidaten, die lokalen Discovery-Zyklen, den Secret-
  Store, den Router-Budgetdienst, zugelassene Socket-Metadaten sowie den Zustand der Sidecar
  ein. Die Bibliothek erhält Credential- und Egress-Ports samt Adress-Pin, Clock, Zufall,
  Budget, Abbruchsignal und Anthropic-Thinking-Speicher über den Aufrufer. Sie wird in W1
  von keinem Laufzeitpfad aufgerufen. Der Modellscanner und sein Abgleich folgen in W5.
- **Abdeckung.** Die W1-Aufzeichnungen decken die hier genannten Drahtfälle ab. Die Zuordnung
  jeder TypeScript-Testdatei im MODULE-MAP wird mit dem Paketabschluss W10 nachgeführt.
  Der optionale Tool-Argument-Reparaturhook kommt vom Aufrufer und ist im Chat-Replay belegt.
  Der Aufrufer kann laufende Lesevorgänge an I/O-Grenzen abbrechen. Während ein blockierender
  Socket-Aufruf wartet, greift dessen Frist.

### P4D-40 · Verwandte HTTP-Wrapper

| Stelle | Befund zur Behandlung körperloser Antworten |
|---|---|
| [Web-Fetch](../../packages/core/src/tools/web/http.ts) | Gibt Status, Header und Bytes oder einen Stream als eigenes `HttpResponse` zurück und hat diese Fehlerursache nicht. |
| [Web-Suche](../../packages/core/src/tools/web/search-http.ts) | Gibt ein eigenes `ApiReply` zurück und hat diese Fehlerursache nicht. |
| [MCP-HTTP](../../packages/core/src/mcp/http.ts) | Verwendet für 204, 205 und 304 explizit `Response(null, …)` und hat diese Fehlerursache nicht. |
| [Telegram](../../packages/channels-telegram/src/api.ts), [Discord](../../packages/channels-discord/src/api.ts), [Slack](../../packages/channels-slack/src/api.ts), [Matrix](../../packages/channels-matrix/src/api.ts) | Konsumieren native Fetch-Antworten, daher tritt diese Konstruktor-Fehlerursache dort nicht auf. |
| [Telegram-Webhook](../../packages/channels-telegram/src/channel.ts) | Baut eigene lokale Antworten mit Null-Body und hat diese Fehlerursache nicht. |
| [Signal](../../packages/channels-signal/src/rpc.ts), [E-Mail](../../packages/channels-email/src), [Buzz](../../packages/channels-buzz/src) | Nutzen die jeweiligen JSON-RPC-, Mail- oder Relay-Transporte ohne diesen HTTP-Response-Wrapper. |
| [Medien-HTTP](../../packages/media/src/http.ts), [Adapter-Transport](../../packages/media/src/adapters/_shared/transport.ts) | Konsumieren native Fetch-Antworten und haben diese Fehlerursache nicht. |
| [Apple-FM-Unix-Transport](../../packages/providers/src/local/unix.ts) | Wandelt körperlose Status in `Response(null, …)` um und hat diese Fehlerursache nicht. |
| [Cloud-Sprache](../../packages/core/src/voice/transport.ts) | Verweigert 3xx, übergibt bei 204/205 einen Null-Body und fängt Konvertierungsfehler im Callback ab. |
| [A2A-Client](../../packages/core/src/a2a/client.ts) | Konstruiert im HTTP-Callback stets ein `Response` mit Stream und weist dieselbe Ursache auf (P4D-40). |
| [Engine-Host-Port](../../packages/core/src/engine-host-ports.ts) | Übergibt für HEAD und körperlose Status einen Null-Body und hat diese Fehlerursache nicht. |

### W2 · Kanäle (P4-60–64, P4-66)

| Feature | Quellen und Tests | Ports für den Flip | W-Aufzeichnung und Lücken |
|---|---|---|---|
| `telegram` | [Quellen](../../packages/channels-telegram/src), [Tests](../../packages/channels-telegram/test) | Bot-Credentials, Egress, Uhr/Warten, Update-Offset, eingehende Nachrichten und Uploads | Bot-API-Requests, Long Poll und Webhook einschließlich Wiederanlauf, Retry und Attachments |
| `discord` | [Quellen](../../packages/channels-discord/src), [Tests](../../packages/channels-discord/test) | Credentials, Egress, Uhr/RNG, Gateway-Session, Nachrichten-/Upload-Port | REST, Gateway Hello/Heartbeat, Reconnect/Resume, Close-Codes und Rate Limits |
| `slack` | [Quellen](../../packages/channels-slack/src), [Tests](../../packages/channels-slack/test) | Bot/App-Credentials, Egress, Uhr, Zustellport, Channel- und Thread-Zuordnung | Socket-URL, ACK, Burst/Retry, Web API und mehrstufige Uploads |
| `signal` | [Quellen](../../packages/channels-signal/src), [Tests](../../packages/channels-signal/test) | `signal-cli`-Transport/Prozess, Konto, Uhr, Attachment-Pfade und Zustellport | JSON-RPC-Antworten und Notifications mit Wechsel der Reihenfolge, Reconnect und Timeouts. Dafür fehlt der Stream-Fake jenseits HTTP/WS. |
| `email` | [Quellen](../../packages/channels-email/src), [Tests](../../packages/channels-email/test), [Auth-Vertrag](../../packages/core/src/channels/email-auth-check.ts) | IMAP-/SMTP-Streams aus einem freigegebenen Connector, Credentials, UID-/Thread-/Datei-Ports, Uhr und Zufall für MIME-Metadaten | IMAP und SMTP mit partiellem Lesen, Antwortfolgen und Retry. MIME- und Auth-Vektoren für Encodings, gefaltete Header, Anhänge und Grenzen. Dafür fehlen Roh-TCP-/TLS-Testseams. |
| `buzz` | [Quellen](../../packages/channels-buzz/src), [Tests](../../packages/channels-buzz/test) | Relay-Egress, Schlüssel-/Signaturport, Uhr/RNG, Nachrichtenport | Relay-Gespräche mit Filtern, ACKs, EOSE, Wiederverbindung und NIP-44 mit Testschlüsseln |

Der Testmodus für die Adapterdateien im MODULE-MAP ist W. Reine Parser-, Signatur- und
Nachrichtenabbildungen können zusätzlich V bekommen. Modulstart, Modulmanifest, Host-Prozess,
Switchboard, Routing der Core-Kanäle und RPC bleiben bei den jeweiligen Flip- und Systemtests.
`email-auth-check` liefert V für die Protokollentscheidung. Einbindung und Durchsetzung im
Core bleiben bei der Kanal-Laufzeit.

### W3 · Cloud-Sprache (P4-52)

- **Dateien.** [Voice-Provider-Quellen](../../packages/voice-providers/src) mit `providers/`,
  HTTP/WS, Registry, Fehlertypen und Realtime-Hilfen. Die lokalen Quellen unter `local/` gehören zu P4-93.
- **Tests.** [Voice-Provider-Tests](../../packages/voice-providers/test) für ElevenLabs, Gemini,
  Grok, Polly, HTTP und WS sind W. Chunker, Endpointing, Profil-/Registry-Auswahl, Latenz und
  Fehlertabelle eignen sich zusätzlich für V. `local-*.test.ts` folgt P4-93. Broker,
  Session-/Barge-in-Integration und RPC aus [Core-Voice-Tests](../../packages/core/test/voice)
  folgen dem Flip. `local-socket.ts` ist eine W-Aufnahmehilfe.
- **Ports.** Provider-Credentials, Egress, HTTP und blockierender WebSocket-Connector, Clock und
  Wartefunktion, Audio-Ein-/Ausgabe und Realtime-Ereignisse mit Abbruch.
- **Lücken.** W0 hat JSON-Frames des Voice-Fakes. W3 braucht aufzunehmende Provider-Header,
  Audio-Bytes, Fehler/Abbruch, Credential-Abweisung, Pipeline-Timeouts und ggf. binäre WS-Nachrichten.

### W4 · Medien und Dokumente (P4-53)

- **Dateien.** [Media](../../packages/media/src) mit Adapterprotokollen, `jobs.ts`, `store.ts`,
  `files.ts` und Video/ffmpeg-Schnittstellen. [Dokumente](../../packages/documents/src) mit
  Markdown, Sanitization, Token-/Kontrastprüfung, Vorlagen, Renderer, `chromium.ts` und CDP.
  `pagedjs` bleibt Browser-Asset.
- **Tests.** [Media-Tests](../../packages/media/test) liefern W für Provider-Protokolle und Job-
  Abläufe über geskriptete Ports. Reine Bytes-/Syntaxfunktionen eignen sich für V. Die
  [Dokument-Tests](../../packages/documents/test) liefern V für HTML, Vorlagen und Kontrast,
  W für CDP und PDF-Goldens für `documents-golden`. RPC-/Composition-Tests sind T beim Flip.
- **Ports.** Credential-, Egress-, Clock-, Zufalls- und Abbruchports, Job- und Ergebnisdatenpfade,
  atomare Dateien, Upload-Quelle und Fortschritt, Child-Process/ffmpeg/ffprobe, Chromium und Font-/Asset-Pfade.
- **Lücken.** Bild-/Video-Uploads, Binär- und Statusantworten, Job-Resume/Cancel, Storage-Fehler,
  CDP-Abfolge, unterschiedliche Font-/Plattformausgaben und die existierenden PDF-Goldens.
  Die Downloads und Prozesse im Rust-Test durch Fixtures oder mitgelieferte Testassets steuern.

### W5 · Erkennung und Katalog (P4-44)

- **Dateien.** [Discovery](../../packages/core/src/discovery) mit `scanners/`, HTTP, Reconcile,
  Metadaten, Rollen und Overrides. [Katalog](../../packages/core/src/catalog) mit Client,
  Verifikation und Extension-Index. `job.ts`, `schedule.ts`, `scheduler.ts`, `service.ts`,
  Ereignislogger und der Core-seitige Katalog-Store bleiben Laufzeitaufgaben. Bei Katalogsignaturen
  und Checkpoints bekommt die Bibliothek die Bytes und speichert über Ports.
- **Tests.** [Discovery](../../packages/core/test/discovery) und [Katalog](../../packages/core/test/catalog)
  liefern W für Scanner, Abgleich über HTTP/Unix und Indexabrufe, V für Reconcile, Rollen,
  Overrides, Metadaten und Verifikation. Scheduler-/Timer-, Store-/Redaction-Lifecycle- und
  Core-RPC-Tests zählen beim Flip (T/S), soweit sie Zustands- oder Einbindungsverhalten testen.
- **Ports.** Profilquelle, Header-Leases, geprüfte Ziele/Unix-Pfade, Uhr, RNG, signierter
  Root/Trust-Input und Checkpoint-Lese-/Schreibport.
- **Lücken.** Alle Provider-Seiten und 429/Retry-After, unvollständige und leere Aufzählungen,
  Entfernung/Übernahme von Metadaten, Rollen-Fallback und Katalog-Rollback/-Ablauf.

### W6 · Web (Bibliothek von P4-30)

- **Dateien.** [Web-Tools](../../packages/core/src/tools/web) für Fetch, Guard, IP, Robots, HTML und
  Suchanbieter. `tools.ts` bleibt Core-Registrierung. Fremdcode oder Fixtures mit Jina-Herkunft
  sind ausgeschlossen.
- **Tests.** [Web-Tests](../../packages/core/test/tools/web) liefern V für `ip*`, `robots`,
  `html`, Guard- und Extraktionskorpus. HTTP-/Fetch-/Search-Sequenzen und Redirects liefern W.
  Der Tool-Registry-/Dispatcher-Anteil von `tools.test.ts` folgt beim Flip.
- **Ports.** Resolver, Egress, Verbindung an freigegebene Adressen, Provider-Credentials, Clock,
  Limits und Abbruch. Eine Host-Freigabe darf beim Verbindungsaufbau nicht neu aufgelöst werden.
- **Lücken.** Explizite IP-Klassifikation und Robots-Präzedenz, Extraktionsgoldens,
  Redirect-Entscheidungen pro Hop, Body-/Zeitgrenzen, Fehlerabbildung und Suchfallbacks.

### W7 · MCP (P4-70)

- **Dateien.** [MCP](../../packages/core/src/mcp) mit Registry, Auth-/OAuth-Interaktion,
  stdio, HTTP, Tool-Protokoll und Server sowie [MCP-Bridge-Vertrag](../../packages/core/src/tools/mcp-bridge.ts).
  Modulstart, `mcp-bin.ts`, konkrete Secret-Auflösung, Session-/Core-Composition und Toolregistrierung
  folgen beim Flip.
- **Tests.** [MCP-Tests](../../packages/core/test/mcp) liefern W für stdio/HTTP und Server-Verkehr
  einschließlich Auth-Abläufen. Redaction, Erkennung von Auth-Erfordernissen und Protokollformen
  eignen sich auch für V. OS-Job-Prozessbindung und Extension-Aktivierung bleiben S am Laufzeitpfad.
- **Ports.** Egress und Auth-Eingaben, OAuth-Interaktion und State, Uhr/Zufall, stdio-Streams,
  Prozess- und Env-Launcher, Tool-Registry und Tool-Aufruf.
- **Lücken.** stdio-Fake, Transport-Fallback, Session-/SSE-Fehler, Auth-Antworten, Wiederverbindung,
  Umgebungs- und Redaction-Verträge. Response-Bounds stehen unter den Abhängigkeitsauflagen.

### W8 · A2A (P4-72)

- **Dateien.** [A2A](../../packages/core/src/a2a) mit Cards, Handler, Parts, Events, Push-/Status-
  Protokoll und Peer-Client sowie [A2A-Transport-Vertrag](../../packages/core/src/tools/a2a-transport.ts).
  In `tasks.ts`, `peer-store.ts`, `turn-port.ts` und `policy.ts` sind Task-/Peer-Storage,
  Session-/Turn-Laufzeit und Core-Entscheidungen Ports beziehungsweise Flip-Aufgaben. Peer-RPC
  folgt beim Flip.
- **Tests.** [A2A-Tests](../../packages/core/test/a2a) liefern W gegen den SDK-Fixture-Peer für
  Client und Endpunkt sowie V für Card-/Part-/Event-Formen und Protokollvalidierung. Persistenz,
  Session-Turns und Core-Policy-Bindung bekommen ihre Abnahme beim Flip (T/S).
- **Ports.** Egress, Identitäts-/Bearer-Prüfung, Policy-Abfrage, Task-/Peer-Zustand, Turn und
  Cancellation, Uhr/Zufall, Push-Transport.
- **Lücken.** Card-Refresh/Trust-Input, SSE-Events und frühe Ablehnung, Task-Abbruch, Push-Fehler,
  Größenlimits und Zugriffsgrenzen über eine geskriptete Policy. Für eingehende Handler kommt
  der HTTP-Listener aus dem Core-Port.

### W9 · Matrix (P4-65, Owner-Entscheidung)

[Quellen](../../packages/channels-matrix/src) und [Tests](../../packages/channels-matrix/test)
bleiben zugeordnet. Geplant wären W für Sync/Send und ein Crypto-Store-Rundlauf. Der Flip
bräuchte Homeserver-Egress, E2EE-Credentials, Geräte- und Store-Ports, Clock/RNG und Zustellung.
Die Paketkarte verlangt die Owner-Freigabe für die MPL-2.0-Ausnahmen. Der Spike nennt außerdem
Rust 1.96 für `matrix-sdk-crypto 0.19.1`.

## Abhängigkeiten und Policy

| Einsatz | Version / Lizenz | Stand |
|---|---|---|
| W0 Fixture-JSON | `serde_json 1.0.151`, MIT OR Apache-2.0 | Bereits im Lockfile. |
| W0 Exact-Bytes und WS-Handshake | `base64 0.22.1`, MIT OR Apache-2.0. `sha1 0.11.0`, MIT OR Apache-2.0 | Bereits im Lockfile. SHA-1 dient hier nur dem vorgeschriebenen WebSocket-Accept-Wert. Der Testserver nutzt blockierende Standardbibliotheks-Sockets. |
| HTTP und SSE (W1–W8) | `ureq 3.4.2`, MIT OR Apache-2.0. `rustls 0.23.46`, Apache-2.0 OR ISC OR MIT | Wiederverwendung mit `default-features = false`, `rustls` und `platform-verifier` wie bei der Engine. Wiederverwendung der gesperrten URL-, JSON-, Hash- und Plattform-Crates, wo sie den Port erfüllen. |
| WebSocket (W2/W3/W4) | R-W-6 bestätigt `tungstenite =0.30.0`, MIT OR Apache-2.0, Rust 1.85, veröffentlicht am 11. Juli 2026 | `default-features = false`, nur `handshake`. `client_with_config` benutzt einen bereits verbundenen `Read + Write`-Stream des Ports, für WSS mit dem bestehenden Rustls. Der Port verbindet den gepinnten TCP-Endpunkt nach Egress-Prüfung. TLS- und `url`-Features bleiben aus. Der Adapter setzt Frame- und Nachrichtengrenzen mit Grenztest sowie Fristen für Handshake, Lesen und Schreiben. Transitive Auflösung und Gates beim ersten Einsatz. |
| Nostr (W2) | Kandidat `nostr =0.45.5`, MIT, veröffentlicht am 11. September 2026 | Spike verwendet `std`, `nip44`, `os-rng`. Einsatz als Protokoll-/Crypto-Crate, Relay-Transport über den WS-Port. Lockfile-Auflösung und Gates bei W2 erneut prüfen. |
| E-Mail (W2) | Handgeschriebene IMAP-/SMTP-/MIME-Schicht, bestehende `base64`-/TLS-Bausteine | Der Stream-Port liefert TCP oder Rustls, einschließlich des STARTTLS-Übergangs. Weitere Codec-Kandidaten erst anhand der TS-Fixtures bewerten. |
| Markdown/HTML (W4/W6) | Parserauswahl offen | Erforderlich sind HTML-/Sanitization-Parität für den vorhandenen Korpus und ein zulässiger Lizenz-/Advisory-Befund. CDP braucht den WS-Port. Chromium und ffmpeg sind vom Aufrufer bereitgestellte Prozesse. |
| Scanner/Katalog/A2A (W5/W8) | Bestehende JSON-, Hash-/Signatur- und HTTP-Bausteine | Keine neue SDK-Abhängigkeit vorgesehen. Socket- und Prozess-Ports werden vom Flip besetzt. |
| MCP (W7) | `rmcp =3.9.0`, Apache-2.0, **zulässig ab 19.11.2026, 16:08 UTC** (R-W-4) | W0 trägt den Kandidaten nur hier ein. W7 baut den generischen Transport mit bestehendem Workspace-Tokio und `ureq`. `transport-streamable-http-client-reqwest` und `transport-streamable-http-client-unix-socket` bleiben aus. Neue transitive Pins einzeln gegen Lizenzliste und Zwei-Wochen-Regel prüfen. Beim Lesen deckelt der Adapter erfolgreiche JSON-Antworten auf 16 MiB und Fehlerantworten auf 64 KiB, mit Test. |
| Matrix (W9) | `matrix-sdk-crypto 0.19.1`, Apache-2.0, und MPL-2.0-Transitive | Abhängig von Owner-Freigabe und kompatibler Workspace-Toolchain. |

Quellen für die Vorschläge sind der [Spike](../research/2026-11-08-phase4-spike.md),
die [Workspace-Pins](../../Cargo.lock), die [tungstenite-Registry-Metadaten](https://crates.io/api/v1/crates/tungstenite/0.30.0)
und die [API für den Handshake auf einem bereitgestellten Stream](https://docs.rs/tungstenite/0.30.0/tungstenite/client/fn.client_with_config.html).
Maßgeblich bleiben das [Advisory-Gate](../../scripts/release/audit-policy.mjs) und das
[Lizenz-Gate](../../scripts/audit-deps.mjs) gemäß R-W-5. Neue Advisory-Warnungen gehören mit
Nummer und Grund in den PR-Text. W0 und W1 fügen dem Lockfile keine Drittanbieter-Version hinzu.

## W0 · Testfundament

`plur1bus-wire-fixtures` übernimmt den P4-03-Fake samt Selbsttests. Der Server bindet
an IPv4-Loopback, protokolliert HTTP-Header und exakte Bytes, hält je Methode und Pfad die
Antwortreihenfolge ein und beendet seine Sockets und Threads beim Drop. Er spielt HTTP-JSON,
SSE-Bytes als HTTP-Chunks sowie JSON-WebSocket-Nachrichten ab. Die Aufzeichnungen decken
Wiederholung, eine nicht aufgezeichnete Route, eine spontane WS-Nachricht und eine SSE-Trennstelle
in einer UTF-8-Sequenz ab. HTTP/WS sind hier Fixture-Transporte. Stdio, IMAP/SMTP,
Unix-Sockets, binäre WS-Nachrichten und die Produktionsports kommen bei Bedarf in den
jeweiligen Meilensteinen hinzu. Für die Laufzeit-Flips entsteht in W0 kein API-Port.

Die [Exporter-Konvention](../../scripts/parity/README.md#wire-fixtures-mode-w) legt Aufnahme,
Platzhalter, Vergleiche und Reproduktion fest.

W0 lokal auf macOS arm64 geprüft. Der SSE-Test scheiterte zuerst an der fehlenden
Event-Stream-Antwort des bisherigen Fakes. Danach liefen zehn Rust-Selbsttests und der
TypeScript-Regenerationstest über vier Fixtures grün. Alle 15 geprüften Mutationen
führten zu Testfehlern. Sie betrafen Zuordnung und Reihenfolge von HTTP-Antworten,
Fehlerstatus, Header-Normalisierung, Request-Framing, Body-Grenze und Byteprotokoll,
SSE-Chunk-Länge und -Abschluss sowie WebSocket-Accept, Maskierung, Close-Code und
serverseitige Erstnachricht. Die Laufzeit- und Plattformabnahme gehört zum Abschluss
des Pakets.

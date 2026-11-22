# P4-W · Inventar der Wire-Bibliotheken

Stand W2, 22. November 2026. Bestandsaufnahme aus W0 auf `origin/main` bei `fc113b4e2d`.
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
- **Benannte Abweichung R-W-9 (Abbruch während Socket-I/O).** TypeScript kann einen wartenden
  Aufruf unmittelbar unterbrechen. Rust prüft den Abbruch an I/O-Grenzen. Die Verzögerung
  beträgt höchstens das vom Port über `socket_timeout` gelieferte Zeitbudget, begrenzt auf
  600 Sekunden. Eine kürzere Gesamtfrist verkürzt die Obergrenze. Die Frist gilt auch bei
  deaktivierten Phasenfristen und deckt TCP, TLS und Unix-Sockets ab.
- **RW-6, Frist der Rückfallkette.** Rust und TypeScript beziehen die Socket-Frist auf den
  einzelnen Adapterversuch. Der Router erlaubt standardmäßig bis zu sechs Versuche mit jeweils
  bis zu 600 Sekunden und den anfallenden Retry-Pausen. Beim Flip hält der Host die gemeinsame
  Turn-Frist und liefert über `Ports::socket_timeout` die verbleibende Zeit für jeden Versuch.
  Timer, Abbruchsignal und Warteport müssen dieselbe Turn-Frist berücksichtigen.


**Mutationsnachweis für W1 (RW-3).** Alle folgenden Einzeländerungen ließen ihren gezielten
Test scheitern. Der unveränderte Code besteht die Tests.

| Mutation | Geprüfte Stelle |
|---|---|
| M1–M3 | Offene SSE-Zeile, CR am Chunk-Ende, akkumulierte Event-Daten |
| M4–M5 | Gesamtgröße des SSE-Stroms und UTF-16-Grenze für Tool-Argumente |
| M6–M7 | Redirect-Ablehnung und wirksamer Deckel von 600 s im HTTP-Client |
| M8a, M8b, M9 | Abweichender Pin-Port, abweichende Literal-IP und fehlender Loopback-Pin |
| M10 | Redaktion synthetischer Credential-Marker in Meldung, Debug und JSON |
| M11a, M11b | Absolute Frist bei Raw-Socket-Lesen und -Schreiben unter der TLS-Schicht |
| M12–M13 | 0700 für das AF1-Verzeichnis und ignorierter Body bei 205 |
| M14–M15 | Fehlerbody mit genau 64 KiB und darüber, Abbruch nach fehlgeschlagenem Router-Versuch |


**RW-4 / [P4D-195](defects.md#p4d-195).**
Die Redaktion verwendet in Rust sowohl die gesendete normalisierte Schreibweise als auch die
Originalwerte. Die TypeScript-Aufzeichnung erfasst den Unterschied bei nachgestellten
Leerzeichen in Authorization und bei OWS um Zusatzheader (TS-2). Beide Fälle nutzen
synthetische Marker. Die Rust-Fehlerform folgt der aufgezeichneten Redaktion bei bereits
normalisierten Headern. Seit RW-5 enthält die Debug-Ansicht der Provider-Konfiguration
die Namen der Zusatzheader. Ihre Werte sind dort ausgeblendet.


**RW-7 / [P4D-196](defects.md#p4d-196).** Das Reasoning-Replay enthält sechs Fälle mit
Katalogwerten außerhalb der Typdeklaration. `null` bei einer Effort-Stufe fällt wie in
TypeScript auf den Stufennamen zurück. Für String-Toggle, nichtboolesches oder unbekanntes
Adaptive-Thinking und fehlende oder als Text gelieferte Budgetgrenzen speichert der Exporter
die TypeScript-Ergebnisse. Die Rust-Tests prüfen die engeren Ergebnisse einzeln (TS-4).


**RW-8, inkrementelle SSE- und Thinking-Puffer.** Der SSE-Parser validiert pro Read nur den
neuen UTF-8-Bereich und führt die UTF-16-Länge der offenen Zeile mit. Unvollständige Skalare
und CR am Chunk-Ende bleiben bis zum nächsten Read offen. Der Anthropic-Akkumulator ergänzt
Thinking- und Signatur-Deltas im vorhandenen String. Die Proben prüfen eine offene Zeile aus
2.048 Chunks, ein geteiltes Vier-Byte-Zeichen und die Wiederverwendung reservierten Speichers.

**Weitere Beobachtungen in TypeScript.**

- **TS-1** ist die unterschiedliche 304-Klassifikation von Core-Bridge und nativem Fetch.
  Der R-W-10-Nachweis verwendet die Core-Bridge. TS-2 und TS-4 sind bei RW-4 und RW-7 erfasst.
- **TS-3** betrifft aufeinanderfolgende UTF-8-BOMs und eine Chunk-Grenze im ersten BOM.
  Der Rust-Parser konsumiert einmal den führenden BOM.
- **TS-5** betrifft ungültige Breakpoint-Indizes, Scalar-Content im Responses-Emitter und
  ein fehlendes Input-Array beim Cache-Umbau. Der Rust-Emitter überspringt diese Formen
  oder behält den ursprünglichen Anfragetext.

<a id="p4d-40-http-wrapper"></a>

### P4D-40 · Verwandte HTTP-Wrapper

Unter R-W-10 meldet HTTP 304 in Rust und in der TypeScript-Core-Bridge `invalid_request` mit
„provider redirects refused“. Nach #937 zeichnet der Exporter auch 204 und 205 direkt aus der
reparierten Core-Bridge auf. Es gibt je Status 24 Fälle über die vier Anbieterformate, beide
Aufrufarten und drei Content-Type-Fälle. Bei SSE meldet der Adapter einen fehlenden Body, sofern
der Aufruf das SSE-Parsing erreicht. JSON erhält leere Eingabe. Die Abweichungsmarkierung für
P4D-40 entfällt.

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

[`plur1bus-channels`](../../crates/plur1bus-channels/src) enthält je ein Feature für Telegram,
Discord, Slack, Signal, E-Mail und Buzz. Die sechs sind in der Standalone-Bibliothek Standard,
damit der bestehende native Workspace-Test alle Adapter abdeckt. Der Flip kann einzelne
Features auswählen. Die [Aufzeichnungen](../../fixtures/parity/channels) erzeugt der
[TypeScript-Exporter](../../scripts/parity/export-channels.ts). Der Rust-Fake spielt HTTP,
WebSocket oder bytegenaue Duplex-Dialoge lokal ab.

| Feature | TypeScript-Quellen und Tests | Aufgezeichnet und im Rust-Replay geprüft | Ports beim Flip |
|---|---|---|---|
| `telegram` | [Quellen](../../packages/channels-telegram/src), [Tests](../../packages/channels-telegram/test) | Bot API einschließlich Long-Poll-Offset, Sendefelder, 429, Download-Grenze und Redirect. Webhook mit Geheimnis, Body-Grenze, Update-ID und Duplikaten. | Bot-Credential, Egress, HTTP/TLS-Ingress, Offset-Persistenz vor dem nächsten Poll, Wartefunktion, Zustellung und Dateiport. |
| `discord` | [Quellen](../../packages/channels-discord/src), [Tests](../../packages/channels-discord/test) | REST-Körper, Autorisierung je Route, Retry-Timing und Gateway v10 Identify, Resume, Sequenz, ACK und fehlender Heartbeat-ACK. | Clock, RNG und Schlaf, zugelassener TCP-/TLS-Stream, dauerhafte Gateway-Session, Supervisor des Gateway-Zyklus, Nachrichten und Uploads. |
| `slack` | [Quellen](../../packages/channels-slack/src), [Tests](../../packages/channels-slack/test) | Web API, URL-Formulare, Upload ohne Bearer, geprüfte File-Redirects, Hello, ACK vor Zustellung und ACK bei Redelivery. | Bot/App-Credentials, Egress-Pin je Dateihop, erneutes Öffnen bei Refresh mit gemeinsamem Dedupe-Fenster, Zustellung und Zuordnung von Channel und Thread. |
| `signal` | [Quellen](../../packages/channels-signal/src), [Tests](../../packages/channels-signal/test) | Byte-Splits und coalesced reads, vertauschte Antworten, Notification, Rückantwort auf unbekannte Daemon-Methode, Retry-Hinweis, Timeout und Schließen bei Linienüberschreitung. | Daemon-Prozess und Duplex-Transport, Watchdog und Wiederverbindung, Uhr, Konto, Zustellung und Attachment-Pfade. |
| `email` | [Quellen](../../packages/channels-email/src), [Tests](../../packages/channels-email/test), [Auth-Vertrag](../../packages/core/src/channels/email-auth-check.ts) | SMTP- und IMAP-STARTTLS-Sequenz, fehlendes STARTTLS, SMTP 450 und DATA, IMAP-Literal und UID-Operationen, MIME-Bytes, Charset, RFC 2231, Größen-/Tiefengrenzen und unklare Absender. | Egress plus zertifikatsgeprüfter TLS-Upgrade desselben Streams, DNS/IP-Pin, Store für UID/Threads, Thread-Metadaten, Zeit und RNG für MIME, Absenderautorisierung des Hosts. |
| `buzz` | [Quellen](../../packages/channels-buzz/src), [Tests](../../packages/channels-buzz/test) | REQ-Bytes, EOSE, signierte Relay-Metadaten, drei AUTH-Antworten, NIP-44/59 mit synthetischen Schlüsseln, Abgleich der entschlüsselten Nutzlast, persistierte Deduplizierung und OK-Korrelation. | Relay-Egress, Host-Credentials und kryptografische Entropie, Uhr, atomare Replay-Persistenz, Zustellung und Auswahl der aktiven Relay-Verbindungen. |

Der Host besitzt Weiterleitung, Pairing, Ausgabe-/Tool-Policy, Cooldowns, Dateien und Stores.
Gateway-, Socket-Mode- und Relay-Zustandsmaschinen geben Entscheidungen an den Host zurück.
Live-Verbindung, Prozessstart, Netzwerk-Disposition und die Core-Policy um die Adapter folgen
beim Flip. Die STARTTLS-Replays prüfen den Übergang vor den Credentials über den Stream-Port.
Zertifikatsverifikation führt der Host aus. Der E-Mail-Auth-Vertrag bleibt bei der Core-Kanal-Laufzeit.
Bei Buzz bleiben die tatsächlichen Signaturen prüfbar. Die Aufzeichnung vergleicht variable
Signaturen und verschlüsselte Outbound-Frames über Event-ID, Signaturprüfung und entschlüsselte Nutzlast.

R-W-6 bindet Nachrichten- und Frame-Limits getrennt und beaufschlagt Handshake, Lesen und
Schreiben mit Fristen. Bei R-W-9 können blockierende Kanalaufrufe bis zur jeweiligen Restfrist
laufen. HTTP begrenzt Einzelaufrufe auf 600 Sekunden, WebSocket-Phasen ebenfalls auf maximal
600 Sekunden. SMTP/IMAP-Kommandos nutzen bis zu 600 Sekunden, IMAP IDLE hat separat das
protokollbedingte Maximum von 25 Minuten. Egress- und TLS-Ports müssen ihre erhaltenen Fristen
am Socket durchsetzen. Die HTTP- und WebSocket-Features deaktivieren TRACE beim Kompilieren,
auch bei isoliertem Build des Kanal-Crates. Telegram transportiert Credentials im Pfad und
Socket Mode Tickets in der URL. Der Kanalcode reicht von Close-Frames nur den Code weiter.
Beim Flip muss der Host seinen `log`-Logger über
[`plur1bus_wire_log::install`](../../crates/plur1bus-wire-log/src/lib.rs) registrieren.
Nach R-W-11 lässt der Filter Ziele mit Präfix `plur1bus` und sonst nur WARN und ERROR zu.
Der Loopback-Test zeigt denselben synthetischen Close-Grund mit ungefiltertem Logger und
weist seine Unterdrückung mit Filter nach. HYG-018 sperrt direkte Logger-Registrierungen im
Anwendungscode. Ein Host außerhalb des Repos muss den Filter ebenfalls einsetzen.

Alle 27 neuen Registry-Einträge wurden gegen Veröffentlichungsdatum, Yank-Status und
Lizenzliste geprüft. Die aktivierten direkten Neuzugänge sind `tungstenite =0.30.0` (MIT OR
Apache-2.0, nur `handshake`), `nostr =0.45.5` (MIT, `std` und `nip44`) und
`secp256k1 =0.30.0` (CC0-1.0, Signieren mit vom Host geliefertem Aux-Zufall).
Die Graphkante `faster-hex → heapless 0.8.0` bleibt in Cargo sichtbar. Nostr aktiviert
bei `faster-hex` die Features `alloc,std`. Damit kompiliert dessen einziger Heapless-Import
und -Aufrufpfad nicht. Das wurde am Feature-Fingerprint und an den Symbolen des macOS-Artefakts
geprüft. Der Aufrufumfang der bestehenden Rstar-Ausnahmen bleibt unverändert.

18 Mutationen wurden jeweils mit dem fachlich zuständigen Replay zurückgewiesen: Redirects,
Pin-Port und Pin-IP, HTTP-Body-Limit, Retry-Deckel, Telegram-Redaktion und Webhook-Auth,
Discord-Tokenroute, Slack-Redirect und Socket-Dedupe, WebSocket-Frame- und Nachrichtenlimit,
Signal-Zeilengrenze, IMAP- und SMTP-STARTTLS, MIME-From-Duplikate sowie Buzz-Rumor-Dedupe
und AUTH-Challenge-Deckel. Die Zuordnung sämtlicher TypeScript-Testdateien zum Testmodus
folgt in W10.

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

**W3 Rust partial delivery.** The cloud library covers the JSON HTTP boundary,
ElevenLabs catalogs and buffered TTS/ASR, Gemini/XAI catalog discovery, Polly
buffered synthesis and list projection through a signed-request port, and
blocking Grok, Gemini and ElevenLabs ASR readiness and audio exchange. The
exporter records actual TypeScript calls and frames for HTTP and WebSocket.

The flip must supply authorized pins, TLS for WebSocket, resolved credentials,
Polly signing, request deadlines and the ASR multipart boundary. R-W-12/R-W-13
are recorded in [P4D-202](defects.md#p4d-202), [P4D-204](defects.md#p4d-204),
[P4D-205](defects.md#p4d-205) and [P4D-206](defects.md#p4d-206). Audio and JSON
have separate ceilings. Host registration uses the R-W-11 logger. A socket
operation already blocked at cancellation can remain blocked until its deadline.

Open W3 parity includes retry timing and the retry-after contract, ElevenLabs
stream-input TTS, caller text and tool frames, and complete realtime event
projection and usage. The cloud library has no production caller.

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

**W4 local partial delivery.** The Markdown fragment renderer and contrast
arithmetic replay the document package's original TypeScript outputs. Media
request validation and accounting cover metadata-only requests. Binary inputs
remain outside that entry point until the owner supplies typed image and video
ports. The browser/CDP, PDF goldens, assembled template and output-store
acceptance remain open. Neither crate is installed by the Core.

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

**W5 local partial delivery.** Model role and alias resolution replays the
production TypeScript implementation, including qualified provider prefixes,
availability ordering and provider-scoped warnings. Scanner HTTP, reconciliation
and overrides remain future slices. The role library has no network or store port.

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

**W6 local partial delivery.** The pure robots parser replays TypeScript
scope selection, priorities and crawl delay. [P4D-207](defects.md#p4d-207)
records the byte ceiling. The fetch port supplies a complete decoded body and
rejects overflow. IP classification already exists in the P4-K egress port.
Crawl scheduling, extraction, redirects, HTTP and search are open.

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

**W7 local partial delivery.** The stdio bridge's JSON reply reader records
normal replies and notifications from the TypeScript forwarder. It applies
[P4D-208](defects.md#p4d-208) on its decoded body port. The rmcp client/server,
SSE and stdio process transports, auth and registration remain open.

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
| Nostr (W2) | `nostr =0.45.5`, MIT, veröffentlicht am 11. September 2026 | `std,nip44` mit separatem Entropie-Port, getestete NIP-44/59-Interoperabilität. Siehe W2 zur Heapless-Graphkante. |
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

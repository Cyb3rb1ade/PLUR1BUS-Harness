# Extensions, import and SSH source — work package M v2

> **For agentic workers:** execute the owner's revised task sequence with test-first changes, task commits and independent review. This plan replaces `2026-10-28-extensions-import-m.md`.

**Goal:** deliver MCP extensions/bundles, real web installation, supervised graphical import and a reusable read-only SSH/SFTP source.

**Architecture:** bounded package workers inspect/normalize; the supervisor owns configuration, versioned package transactions and import maintenance. Core owns MCP/policy/secrets and full preflight. Import source access uses a reusable read-only remote-fs port with local/SFTP implementations. Remote snapshots are complete and authenticated before maintenance stops Core.

**Tech stack:** existing Rust1.95/Node24.21.0/pnpm10.28.0/TypeScript/Preact/Tauri; SSH/SFTP dependency selection remains gated by licence, advisories, release age and duplicate dependency lines.

**Spec:** the owner's complete work package M, Fassung2, dated2026-10-28, supersedes Fassung1; existing extension/import/desktop/egress/ADR005/013/016 designs apply except the explicit decisions below.

## Global constraints and execution record

- One PR; final title: `extensions and import: MCP servers, bundles, web install, import assistant and SSH source (X2, X3)`.
- Parts A, B, C, D, E, F. Commits authored `Cyb3rb1ade <cyb3rblade@me.com>`, task-prefixed. Already committed Fassung1 work remains; revised task corrections use explicit v2 task commits without rebase/amend/force push.
- No CI polling or merge. Controller owns ci:macos and merge.
- Do not edit crates/plur1bus-engine, packages/core/src/engine, packages/webmcp or CI workflows. K2 is context for separate packageK; its attached instructions do not authorize engine work in M.
- Long tests run in owned background sessions with logs under `/workspace/m-logs`; exact tool environment is `/workspace/.tools/env-m.sh`.
- Preserve existing CLI raw JSON documents/schema IDs and additive RPC shapes. Changed activation values are explicitly authorized by decision3; no typed reserialization.
- New human-only setup/auth/runtime methods use `admin.extensions.*`, already excluded by WebMCP; ordinary PATs remain agents.
- Versioned MCP tree is `mcp/<name>/<version>/{p1x.json,record.json,payload/...}`. ActiveVersion is authoritative, version mirror must match, previousVersion and version metadata retained; no operational per-agent selector.
- Core cwd is active version root; MCPB __dirname is its authenticated payload child. Runtime generation includes active version and manifest digest.
- Previous versions remain retained; no pruning/extra ready RPC is needed for initial delivery. Same-version different-digest MCP publication refuses before writes; existing inactive identical versions can be selected atomically.
- Secret values stay private: environment leases never enter cached definitions/ChildSpec/RPC responses, native spawn uses an authenticated bounded non-RPC pipe. Secret namespace remains ext:<name>:<slot>.
- MCPB PKCS7 framing is validated before ZIP; absent approved verifier, disclose unsigned/signature-not-checked. No claim of cryptographic verification.
- Read-only remote-fs exposes only stat/lstat/readdir/readFile(maxBytes)/realpath/readlink plus budgets, no write/exec escape hatch. C2 can introduce its local interface; E completes SFTP after dependency gate.
- Full preflight never stops Core on failure. Apply failures restore pre-import target and restart Core; report any evidenced failure that cannot be preflighted or rolled back under the owner's stop rule.
- Remote free paths: Owner permitted after trusted-path checks, Admin detected sources only; loopback/Desktop Owner/Admin permitted. SSH setup and host-key trust are Owner-only; usage Owner/Admin.

## Review focus

- Cross-principal upload/auth/source capabilities and stale-turn package versions never borrow authority.
- Version publish/state switch/recovery keep old usable version after every interruption.
- Import preflight seals source/snapshot; no Core stop on failed space/config/schema/lock/model/licence/secret checks.
- Maintenance status/cancel/progress authentication survives Core stop without a general stale-role cache; rollback restores imported entities and config.
- SSH host keys fail closed before data reads; source/budget/path checks apply at each local/SFTP boundary and private keys never escape leases.

## Owner-Entscheidungen vom 2026-10-28

Diese Punkte sind entschieden. Nenn sie oben in der PR-Beschreibung, jede mit ihrem Grund. Wo sie von der Spec
abweichen, hältst Du das als „Amendment“ in der Spec fest (F2).

1. **Wo der Import schreibt:** Apply und Rollback laufen als **Wartungslauf unter dem Supervisor**, aber erst nach
   einer vollständigen Vorprüfung.
   - **Die Vorprüfung** läuft bei laufendem Core und soll jeden Fehler finden, der sich vorher finden lässt. Erst wenn
     sie grün ist, stoppt der Supervisor den Core. Was sie mindestens prüft, steht in C4.
   - **Der Ablauf:** Der Supervisor stoppt den Core und startet `import.js` als Kindprozess, wie den Paket-Worker der
     Erweiterungen. Danach startet er den Core neu.
   - **Scheitert Apply trotzdem,** stellt ein automatisches Rollback den Stand vorher her, und der Core startet wieder.
     Der Nutzer sieht den Bericht.
   - Erkennen, Planen und Skill-Import laufen ohne Stopp im Core.
   - Konfiguration schreibt der Importer nie direkt, sondern über den `config`-Weg des Supervisors (ADR-013 §5).
2. **Rechte:** Erweiterungen lesen und verwalten dürfen nur Owner und Admin (`extensions.read`, `extensions.manage`).
   Den Import starten dürfen Owner und Admin; Geheimnisse importieren darf nur der Owner. Andere Rollen sehen weder
   die Seiten noch die Methoden.
3. **Nach der Installation** (ändert Spec §6.1 und beantwortet §13 Q5):
   - Ein Paket der Vertrauensstufe `first-party` ist sofort aktiv, für alle Agenten.
   - Jedes andere Paket bleibt deaktiviert, außer der Nutzer wählt im Bestätigungsschritt „Installieren und
     aktivieren“ (Spec §6.1, „Install and enable for …“). Diesen Knopf sehen nur Owner und Admin. Er erscheint erst
     nach der Bestätigung von Rechten und Vertrauensstufe und fragt, für welche Agenten.
   - `PINNED_KEYS` bleibt bis X5 leer. `first-party` gibt es bis dahin nur über die Test-Seam.
4. **Unsignierte Pakete und Pakete unbekannter Signierer** (§13 Q6) sind erlaubt, nur mit der Bestätigung je
   Vertrauensstufe aus §8.3. Andere Wege gibt es nicht.
5. **Ablage von MCP-Servern:** `mcp/<name>/<version>/`, wie Spec §6.2, wegen Multi-User und Multi-Agent.
   - Verallgemeinere die Transaktions-, Rollback- und `recover`-Logik aus `packages.rs` auf dieses Layout. Bau keinen
     zweiten Speicher daneben; `packages.rs` hat außer seinen Tests keinen Aufrufer.
   - Mehrere Versionen dürfen nebeneinander liegen. In diesem Paket hat jede Installation eine aktive Version. Ein
     Update legt die neue Version daneben und schaltet atomar um; die alte bleibt als Rückfall, bis die neue einmal
     sauber gestartet ist.
   - Eine Versionswahl je Agent bereitest Du im Layout und im Datenmodell vor, baust sie aber nicht.
6. **MIME-Typ** überall `application/vnd.plur1bus.extension+zip`, die macOS-UTI ist `app.plur1bus.extension`, wie in
   der Spec.
7. **Signierte MCPB-Pakete:**
   - Die Signatur wird abgetrennt, bevor die ZIP-Prüfung läuft. Sonst greift die X1-Regel „Bytes nach dem EOCD“.
   - Geprüft wird die Signatur nur mit einer Crate, die das Abhängigkeits-Gate besteht. Sonst gilt das Paket als
     `unsigned`, und die UI schreibt „Signatur nicht geprüft“.
8. **Freie Pfade beim Import:**
   - Über Loopback und den Desktop dürfen Owner und Admin freie Pfade angeben.
   - Aus Remote-Sitzungen darf nur der Owner freie Pfade angeben. Ein Admin wählt dort nur, was die Erkennung gefunden
     hat.
   - Jeder freie Pfad läuft durch die Trusted-Path-Prüfung: keine Flucht über Symlinks, nur lesbare Dateien und
     Verzeichnisse, keine Geräte oder Sockets. Kein Pfad aus dem Netz wird ungeprüft geöffnet.
9. **Import von einem anderen Rechner und im Containermodus: Lesezugriff per SSH/SFTP** (Teil E).
   - Der Harness zeigt seinen öffentlichen SSH-Schlüssel. Der Host erlaubt damit nur lesendes SFTP.
   - Der Harness sucht alle importierbaren Daten und zeigt „Gefundene Agenten“, je Agent mit Skills, Plugins,
     MCP-Servern und Stores.
   - Den SSH-Zugang baust Du als wiederverwendbaren Baustein; der Owner will ihn später auch anderswo nutzen.
   - Hat der Host keinen SSH-Server, bleiben der Snapshot über den Desktop (`host.importSnapshot`) und der Hinweis auf
     die CLI.
10. **Fremde Plugins** (vorläufig, endgültig nach der Spec aus Auftrag J): Option B mit einfachen Hooks.
    - Später laufen OpenClaw- und Hermes-Plugins unverändert in einem eigenen Prozess. Ihre Tools, Befehle und Dienste
      erscheinen als MCP-Server, dazu kommen lesende Hooks (etwa Turn-Ende, Nachricht empfangen). Umschreibende Hooks
      und Plugins für Gedächtnis, Kanäle, Provider und Context-Engine bleiben draußen.
    - **Die Brücke selbst ist nicht Teil dieses Pakets.** Hier zeigt der Import gefundene Plugins nur an und stuft sie
      ein (A13, C7).

## Schritte

Test zuerst, rot sehen, implementieren, grün sehen, committen. Jede Task ist ein Commit mit dem Präfix ihrer
Kennung, zum Beispiel `M-A3: …`.

### Teil A: X2, MCP-Server und Bundles

- **A1, Schemas:**
  - `ExtKind` additiv um `mcp-server` und `bundle` erweitern, mit neuer Minor-Version und `x-since`.
  - Config-Namespace `mcp.servers.<name>.{enabled, agents}`: typisiert, mit `x-restart: "live"` und `x-tier`.
  - `ext.inspect`/`ext.install` auf `X2_KINDS` umstellen und `bundle` aufnehmen.
  - `pnpm gen`, danach ist `git diff` leer.
- **A2, die Art `mcp-server` durch den ganzen Lebenszyklus:**
  - Ablage nach Entscheidung 5: `packages.rs` auf `mcp/<name>/<version>/` verallgemeinern und mit `stage.rs` und
    `commit.rs` verbinden
  - `state.json`-Eintrag (mit aktiver und vorheriger Version) und Overlays
  - `ext.list|show|uninstall|restore`
  - `plugin list --kind`
- **A3, Aktivieren und Deaktivieren:**
  - Beides schreibt die Config über `config.set` des Supervisors und sendet `ext.changed`.
  - `agents` ist `"all"` oder eine Liste von `AgentId`.
  - Der Zustand nach der Installation folgt Entscheidung 3.
- **A4, MCP im Core:**
  - Aus jedem installierten `mcp-server` wird eine `McpServerDefinition`.
    - lokal: Befehl aus `requires.runtime`, gepinnte Runtimes (Node, `uv` D58); `cwd` ist das Verzeichnis der aktiven
      Version
    - remote: URL und Auth
  - Server werden live registriert und abgemeldet, sobald sich die Config ändert. Das ersetzt die reine
    Start-Registrierung in `composition/index.ts`.
  - Der absolute Interpreter kommt in die Policy der erlaubten Befehle.
- **A5, Sichtbarkeit je Agent:** Ein Agent sieht nur die Tools der Server, die für ihn aktiviert sind, entweder über
  den Registry-Scope oder einen Filter in `composition/tools.ts`.
- **A6, Wirkung der Tools:**
  - `capabilities.tools[].effect` aus dem Manifest geht an `fromMcp(declared, annotations)` in `mcp-bridge.ts`.
  - `write` und `destructive` starten bei „fragen“.
  - Annotationen des Servers dürfen die Wirkung nur erhöhen, nie senken.
- **A7, Geheimnisse:**
  - Deklarierte Slots werden zu `ext:<name>:<slot>` im Secret Store.
  - Sie gehen an die Umgebung des Kindprozesses oder als Bearer in den Header, beides nur geleast.
  - Die übrige Umgebung wird geleert.
  - `needs-setup` bekommt ein echtes Eingabefeld (CLI und Web).
- **A8, Remote-Auth nach D67:**
  - Die Login-Leiter aus `packages/core/src/auth/ladder.ts` (Device Grant, Loopback mit SSH-Hinweis, Einfügen) wird
    zum `authorize`-Port des `PkceAuthProvider`.
  - Die vier Lücken in `mcp/auth.ts` aus der Ausgangslage schließt Du, mit je einem Test.
  - `auth-required` erscheint als Overlay `error`.
- **A9, MCPB- und DXT-Normalisierer** (`crates/plur1bus-ext/src/mcpb.rs`):
  - Signaturblock abtrennen und nach Entscheidung 7 prüfen
  - Manifest je `manifest_version` prüfen
  - `server.type` gegen `requires.runtime` abgleichen
  - `user_config` abbilden: `sensitive` wird zum Secret-Slot, der Rest zur Config, `directory` und `file` als Pfade
  - `${…}`-Variablen und `platform_overrides` auflösen
  - ein unsigniertes `p1x.json` erzeugen
  - `mcp import` als Alias für `plugin install` anlegen
- **A10, die Art `bundle`:**
  - Regeln: SHA-256 je Mitglied, geschachtelte `.p1x`, keine Rekursion.
  - Alle Mitglieder werden in einer Transaktion installiert.
  - Nicht optionale Mitglieder werden gemeinsam geschaltet; die Anzeige lautet „teilweise aktiv“.
  - Deinstallieren kaskadiert.
- **A11, Normalisierer für Claude-Code-Plugins:**
  - `.claude-plugin/plugin.json` oder, wenn es fehlt, das Standard-Layout wird zu einem `bundle` aus `skills/` und
    `mcpServers`.
  - Übersprungen und im Bericht genannt werden: `commands`, `agents`, `hooks`, `lspServers`, `outputStyles`,
    `workflows`, `experimental.*`, `bin/`, `settings` und `channels`.
  - Eine `mcpServers`-URL lädt nur über die Egress-Policy, mit Größenlimit.
- **A12, Datenverzeichnis:** `ctx.dataDir` in `packages/module-api` und `P1X_DATA` in der Umgebung der Kindprozesse
  des Supervisors und der MCP-Server.
- **A13, Importer:**
  - Die MCP-Server-Konfigurationen aus OpenClaw und Hermes werden zu deaktivierten `mcp-server`-Einträgen mit
    Vertrauen `imported` (§7.3).
  - Geheimnisse übernimmt nur die Allow-Liste aus `docs/import.md` §5.6.
  - Plugins aus OpenClaw und Hermes listet der Import mit einer Einstufung nach Entscheidung 10 und installiert sie
    nicht:
    - „über die Brücke möglich“: Tools, Befehle, Dienste, lesende Hooks
    - „nicht portierbar“: Gedächtnis, Kanal, Provider, Context-Engine, umschreibende Hooks
    - Die Einstufung leitest Du aus dem Manifest bzw. den registrierten Plugin-Teilen ab. Was sich nicht sicher
      einstufen lässt, heißt „unbekannt“.

### Teil B: X3, Weboberfläche

- **B1, RBAC:**
  - Aktionen `extensions.read` und `extensions.manage` in `packages/core/src/rbac/policy.ts`, beide `humanOnly`
  - Einträge in `RPC_RULES`
  - `docs/rbac.md`
- **B2, die beiden Sperren öffnen, in beiden Schichten gleich:**
  - `ext.*` kommt in `WEB_SUPERVISOR_METHODS` und in den Gate in `supervisor/server.rs`.
  - Eine Rollenmatrix steht in einem Test.
  - Delegierte Aufrufer dürfen **nie** `source.path` übergeben. Auch dafür gibt es einen Test.
- **B3, der Upload `POST /api/v1/extensions/upload`:**
  - Sitzung oder Token, `extensions.manage`, CSRF
  - eigene Rate-Klasse
  - Limit aus `extensions.limits.packageBytes`, Default 256 MiB
  - **Streaming auf die Platte, nie im Speicher puffern**
  - Ablage `run/uploads/<zufällige id>` mit Modus 0600, Aufräumen nach 10 Minuten, nie zurückgeliefert
  - Antwort `{uploadId, expiresAt, sha256}`
  - danach OpenAPI und `api-surface` über `pnpm docs:gen`
- **B4, `ext.inspect` mit `source: {upload}`** (als `oneOf`):
  - Der Supervisor löst die ID nur innerhalb von `run/uploads/` auf.
  - Er prüft, dass der hochladende Nutzer der delegierte Prinzipal ist.
  - Die ID gilt einmal und wird nach der Prüfung gelöscht.
- **B5, Events:** `ext.changed` läuft über `/events` (Relay von `ext.watch`).
- **B6, Bestätigungsroute** `/extensions/confirm?inspection=<id>`:
  - Sie liest eine Prüfung über ihre ID erneut ein (`ext.inspection.get` oder Ähnliches).
  - Sie zeigt die Offenlegung nach §8.3:
    - je Vertrauensstufe eigene Bestätigungen und Knopftexte („Unsigniertes Paket installieren“ usw.)
    - Key-ID oder Subject des Signierers, der Herausgeber als „unverifiziert“
    - die Lizenz und das Shebang jedes Skripts
  - Die Knöpfe folgen Entscheidung 3: „Installieren“ immer; „Installieren und aktivieren“ nur für Owner und Admin,
    mit Auswahl der Agenten; bei `first-party` nur „Installieren“ mit dem Hinweis, dass das Paket danach aktiv ist.
- **B7, die Seite fertig nach §10.3:**
  - echter Upload, dann Prüfung, dann Bestätigung
  - Schalter je Agent
  - Filter nach Art (auch Modul, Kanal, MCP-Server, Bundle)
  - Ordner und `.skill` als Eingabe
  - ein Reiter „Aus OpenClaw/Hermes“, der in den Import-Assistenten führt
  - die Zeilen unter Settings › Modules
  - Katalog, Updates und Widerruf kommen erst mit X4.
- **B8, Tests:**
  - Browser-Tests gegen den Mock
  - **ein Test gegen den echten Stack:** Ein signiertes Fixture wird über die API hochgeladen, geprüft, installiert und
    aktiviert
  - axe ohne Befund, in de und en

### Teil C: der grafische Import

- **C1, Importer:**
  - `onProgress` und `AbortSignal` für alle Importer.
  - Gestoppt wird nur an Entitätsgrenzen, wie bei `--resume`.
- **C2, Ports:**
  - Config-Schreiber: `config.set` des Supervisors, die Datei nur ohne Supervisor
  - Engine: injiziert
  - Lock: `imports/.lock` plus ein Wartungs-Gate
  - Dateizugriff: nur über `remote-fs` aus E1, lokal oder per SFTP
- **C3, Schema:**
  - Methoden `admin.import.detect`, `.wsl.list`, `.plan`, `.preflight`, `.apply`, `.status`, `.abort`, `.runs`,
    `.rollback` und `.skills`, nach dem Muster von `admin.reembed.*`
  - Notification `import.progress`
  - Wo Apply und Rollback laufen, steht in Entscheidung 1; danach richtet sich ihr `x-server`.
  - `admin.*` bleibt für WebMCP gesperrt.
- **C4, Vorprüfung, Wartungslauf und Rollback** (Entscheidung 1):
  - **Vorprüfung (`admin.import.preflight`), bei laufendem Core.** Sie prüft mindestens:
    - Die Quelle hat sich seit dem Plan nicht geändert (Hash der gelesenen Dateien bzw. des Snapshots).
    - Jede Konfliktfrage aus dem Plan ist beantwortet.
    - Alle Quelldateien lassen sich lesen und parsen, im Probelauf ohne jedes Schreiben.
    - Die geplanten Config-Änderungen bestehen die Schema-Prüfung des Supervisors, ohne geschrieben zu werden.
    - Im Ziel ist genug freier Platz für den Import und die Rollback-Kopie, mit Reserve. Die Rechte stimmen, und es
      gibt keine fremden Locks.
    - Die Schema-Version der Ziel-Stores wird unterstützt. Wird neu eingebettet, ist das Modell vorhanden und seine
      Lizenz akzeptiert.
    - Werden Geheimnisse übernommen, ist der Secret Store erreichbar.
    - Eine Schätzung, wie lange der Core gestoppt sein wird. Die GUI zeigt sie vor der Bestätigung.
    - Schlägt ein Punkt fehl, endet die Vorprüfung mit einer klaren Liste, und der Core läuft weiter.
  - **Wartungslauf:**
    1. Der Supervisor stoppt den Core.
    2. Er startet `import.js` als Kindprozess und leitet `import.progress` weiter.
    3. Er startet den Core neu.
    4. Der Bericht landet in `<home>/imports/<runId>/`.
  - Scheitert Apply im Wartungslauf, rollt der Lauf automatisch zurück, dann startet der Core mit dem Stand vorher.
  - Nach einem Abbruch lässt sich der Lauf wieder aufnehmen.
  - Läuft ein zweiter Import, wird er mit `E_CONFLICT reason=busy` abgewiesen.
- **C5, Rechte:**
  - `RPC_RULES` für jede neue Methode
  - Geheimnisse nur für den Owner, freie Pfade nach Entscheidung 8
  - die Methoden in `WEB_CORE_METHODS` bzw. `WEB_SUPERVISOR_METHODS` und `import.progress` in `WEB_EVENT_NAMES`
- **C6, `--migrate-secrets`** arbeitet gegen den Secret Store, mit der Allow-Liste aus §5.6. Kein Wert erscheint je im
  Bericht oder im Log.
- **C7, die Web-Seite `/import`**, dazu der Setup-Schritt statt des Platzhalters F37:
  - der Ablauf aus Spec §B.8: Quelle (lokal, Pfad, SSH-Rechner, Snapshot), Erkennen, Pfad-Zuordnung, Re-Embedding und
    Lizenz, Plan, Vorprüfung, Fortschritt, Ergebnis samt Rollback, Folgeschritte im Host-Modus
  - die Ansicht „Gefundene Agenten“, für jede Quelle: je Agent Persona und Dateien, Skills, Plugins mit Einstufung
    (A13), MCP-Server, Stores, Kanäle
  - i18n de und en, die fünf Zustände, axe
  - Cron-Jobs und Sessions erscheinen als „noch nicht übernehmbar“ (§11.3)
- **C8, Tests:**
  - Einheitstests
  - RPC-Tests im Core
  - der Leck-Test über RPC-Ergebnisse und Events
  - **neu: `tests/system/import.test.ts`** gegen einen echten Supervisor: Erkennen, Plan, Vorprüfung, Apply mit
    Fortschritt, Bericht, Rollback, und ein Apply, das mitten im Lauf scheitert und automatisch zurückrollt

### Teil D: Desktop

- **D1, `.p1x`:**
  - `DeepLink::P1x` behält den Pfad, nur in Rust.
  - Die Datei wird nativ und mit Größenlimit gelesen und mit dem Gerätetoken an die aktive Verbindung hochgeladen.
  - Danach öffnet sich die Bestätigungsroute, die den Ursprung zeigt.
  - Bei mehreren Verbindungen gibt es eine Auswahl.
  - MIME und UTI werden korrigiert.
  - `plur1bus://install` bleibt bis X4 „nicht verfügbar“.
- **D2, Import:** Host-Befehle für die Dateiauswahl und für `host.importSnapshot` mit `createSnapshot`, als Weg für
  den Containermodus, wenn der Host keinen SSH-Server hat.
- **D3, Tests** nach den Regeln in `docs/desktop.md`: injizierte Seams, keine echte Keychain.

### Teil E: Lesezugriff auf andere Rechner per SSH/SFTP (Entscheidung 9)

- **E1, Baustein `remote-fs`** (eigenes Paket, etwa `packages/remote-fs`, ohne Abhängigkeit zum Core):
  - Die Schnittstelle ist nur lesend: `stat`, `lstat`, `readdir`, `readFile` mit Größenlimit, `realpath` und
    `readlink`. Eine Schreibmethode gibt es nicht.
  - Zwei Umsetzungen: lokal (`node:fs`) und SFTP. Die Erkennung und `createSnapshot` arbeiten nur noch gegen diese
    Schnittstelle.
  - Grenzen je Lauf: Zeitlimit, Größe je Datei, Gesamtmenge, Tiefe.
  - Eine README nach der Konvention der Pakete; der Baustein ist für spätere Nutzer gedacht.
- **E2, Schlüssel und Host-Vertrauen:**
  - Der Harness erzeugt ein Ed25519-Schlüsselpaar. Der private Schlüssel liegt im Secret Store, nie in einer Datei,
    einem Log, einem Event, einem Bericht oder einem RPC-Ergebnis.
  - GUI und CLI zeigen den öffentlichen Schlüssel und eine fertige Zeile für `authorized_keys`, die nur lesendes SFTP
    erlaubt, etwa `restrict,command="<sftp-server> -R" ssh-ed25519 AAAA… plur1bus-import`.
    - Den Pfad zu `sftp-server` nennst Du je System: Debian/Ubuntu, Fedora/RHEL, Arch, macOS (dort dazu „Entfernte
      Anmeldung“ einschalten) und Windows mit dem OpenSSH-Server (dort auch `administrators_authorized_keys` für
      Admin-Konten).
    - Prüf jede Zeile gegen die Doku von OpenSSH bzw. Win32-OpenSSH. Was Du nicht belegen kannst, markierst Du in der
      Doku als ungeprüft.
  - Schlüssel lassen sich erneuern und löschen.
  - **Host-Key beim ersten Verbinden:** Der Harness zeigt den SHA256-Fingerprint, der Owner bestätigt ihn, der Harness
    speichert ihn. Ein abweichender Host-Key bricht hart ab, bevor irgendetwas gelesen wird.
- **E3, Verbindung und Rechte:**
  - Host, Port und Benutzer; im Containermodus mit einem Vorschlag für die Adresse des Docker-Hosts.
  - Die Egress-Policy (`docs/egress.md`) muss den Host erlauben. Der Owner gibt ihn beim Einrichten frei.
  - Einrichten darf nur der Owner. Suchen und importieren über eine eingerichtete Verbindung dürfen Owner und Admin.
    Freie Zusatzpfade folgen Entscheidung 8.
  - Jede Verbindung und jeder Lauf kommen ins Audit-Log, ohne Dateiinhalte.
  - Agenten erreichen den Baustein nie: kein Tool, keine WebMCP-Methode.
- **E4, Suche:**
  - Die Erkennung läuft über `remote-fs` an allen bekannten Orten aller Benutzer, die der SSH-Benutzer lesen darf:
    Home-Verzeichnisse, die Standardpfade von OpenClaw und Hermes, PLUR1BUS-Stores, unter Windows auch die
    WSL-Distributionen.
  - Kein Vollscan der ganzen Platte: Über SFTP wäre er sehr langsam und fände nichts, was an den bekannten Orten fehlt.
    Zusatzpfade kann der Owner angeben.
  - Das Ergebnis erscheint in der Ansicht „Gefundene Agenten“ (C7).
- **E5, Übernahme:**
  - `createSnapshot` kopiert die ausgewählten Daten über `remote-fs` in einen lokalen Snapshot, privat (0700/0600).
  - Danach läuft der normale Import aus dem Snapshot: Plan, Vorprüfung, Wartungslauf.
  - Den Snapshot löscht der Lauf am Ende, außer der Bericht braucht ihn für ein Rollback.
- **E6, Abhängigkeit:** Für SSH/SFTP in Node kommt etwa `ssh2` in Frage. Es muss das Abhängigkeits-Gate bestehen; sonst
  hältst Du an.
- **E7, CLI:** dieselben Funktionen in `plur1bus import` (Quelle `--ssh <user@host[:port]>`, Schlüssel anzeigen,
  erneuern und löschen, Host-Key bestätigen), jede `--json`-Ausgabe mit `schema`-Kennung.
- **E8, Tests:**
  - ein SFTP-Testserver im Test (etwa der Server-Teil derselben Bibliothek) mit einem OpenClaw- und einem Hermes-Home,
    ohne echten Host
  - Host-Key-Wechsel bricht ab, ohne zu lesen
  - Zeitlimit und Größenlimits greifen
  - Der private Schlüssel erscheint in keinem Log, Event, Bericht oder RPC-Ergebnis (in den Leck-Test aufnehmen).

### Teil F: Doku

- **F1, Doku:**
  - `docs/extensions.md` (§8a, §9)
  - `docs/mcp-client.md`
  - `docs/import.md` (§10, §11, F37, die SSH-Quelle, die Vorprüfung)
  - `docs/web-ui.md`: Die Zeilen, die „Built“ gegen einen angenommenen Vertrag behaupten, richtigstellen.
  - `docs/desktop.md`, `docs/rbac.md` und `docs/egress.md`
  - die Nutzerhilfe unter `docs/user/{de,en}`, mit einer Anleitung für den SSH-Zugang je System
- **F2, Spec:** „Amendment“-Absätze in der Extensions-Spec:
  - die Korrektur zu D46
  - die neuen MCPB- und Plugin-Felder
  - die Owner-Entscheidungen 1 bis 10, besonders die Änderung an §6.1 (Entscheidung 3) und die Antworten auf §13 Q5
    und Q6
- **F3, generierte Doku:** `pnpm docs:gen`, danach ist `pnpm docs:check` sauber.

## Abnahme

Jeder Punkt ist ein Test. Die Spec nennt für X2 und X3 keine nummerierten Kriterien, diese hier gelten.

1. Installationszustand nach Entscheidung 3:
   - Ein unsigniertes `.mcpb` (0.3 und 0.4, eines davon vom Typ `uv`) ist nach der Installation deaktiviert.
   - Mit „Installieren und aktivieren“ ist es für die gewählten Agenten aktiv.
   - Ein `first-party`-Paket (über die Test-Seam) ist sofort aktiv.
   - Ein signiertes MCPB zeigt die Stufe nach Entscheidung 7.
2. Ein manipuliertes MCPB wird abgelehnt: ein geändertes Byte, Daten hinter der Signatur, ein Signaturblock mit
   falscher Länge. Danach sind `extensions/`, `mcp/`, `skills/` und die `mcp`-Config byte-gleich.
3. Ein MCP-Server, nur für Agent A aktiviert: A sieht die Tools beim nächsten Turn, B nicht. Nach dem Deaktivieren ist
   der Prozess beendet.
4. Ein Tool mit der Wirkung `destructive` steht zuerst auf „fragen“. Eine Server-Annotation senkt das nicht.
5. Ein Remote-Server mit `auth: header` bleibt `needs-setup`, bis das Geheimnis gesetzt ist. Mit `auth: oauth` greift
   die Leiter, und eine Antwort ohne `iss` wird abgelehnt (RFC 9207).
6. Ein Claude-Code-Plugin wird zum Bundle. Die übersprungenen Teile stehen im Bericht. Ein Plugin ohne `plugin.json`
   funktioniert auch.
7. Ein Bundle schaltet alle nicht optionalen Mitglieder gemeinsam. Ein Update, das Rechte erweitert, fragt erneut.
8. Rechte und Upload:
   - Ein Browser-Nutzer mit der Rolle Member bekommt bei jedem `ext.*` `E_DENIED` und sieht keinen Knopf.
   - Ein Admin kann hochladen, prüfen, installieren und „Installieren und aktivieren“ wählen.
   - `source.path` aus dem Browser wird immer abgewiesen.
9. Grenzen des Uploads:
   - Ein Upload über dem Limit bricht ab, ohne dass der Speicher wächst.
   - Die Upload-ID eines anderen Nutzers wird abgewiesen.
   - Nach 10 Minuten ist die Datei weg.
10. Der Import im Browser:
    - Erkennen, Planen, Vorprüfung, Apply mit Fortschritt, Ergebnis.
    - Danach läuft der Core wieder, und `memory recall` findet die importierten Karten.
    - Ein Rollback stellt den Stand vorher wieder her.
11. Während eines Imports wird ein zweiter mit `busy` abgewiesen. Ein abgebrochener Lauf lässt sich wieder aufnehmen.
12. Freie Pfade nach Entscheidung 8:
    - Der Owner kann remote einen freien Pfad angeben, ein Admin remote nicht, ein Admin über Loopback schon.
    - Ein Symlink, der aus dem erlaubten Bereich führt, wird abgewiesen, ebenso ein Gerät oder Socket.
13. Kein Geheimnis erscheint in einem Bericht, Log, Event oder RPC-Ergebnis, auch nicht der private SSH-Schlüssel. Der
    Leck-Test läuft über alle neuen Wege.
14. Desktop: Ein `.p1x` öffnet die Bestätigung mit dem Ursprung. Ohne Klick auf Bestätigen wird nichts installiert.
15. Vorprüfung und Wartungslauf:
    - Eine fehlschlagende Vorprüfung (zu wenig Platz, geänderte Quelle, ungültige Config) stoppt den Core nie und
      nennt jeden Grund.
    - Ein Fehler mitten im Wartungslauf führt zum automatischen Rollback. Danach läuft der Core mit dem Stand vorher.
16. Ablage nach Entscheidung 5: Zwei Versionen eines MCP-Servers liegen unter `mcp/<name>/<version>/`. Ein Update
    schaltet atomar um. Nach einem Abbruch mitten im Update stellt `recover` einen konsistenten Stand her.
17. SSH-Schlüssel und Host-Key:
    - Der Schlüssel wird erzeugt, der öffentliche Teil angezeigt; der private erscheint nirgends.
    - Der erste Host-Key muss bestätigt werden. Ein geänderter Host-Key bricht ab, bevor etwas gelesen wird.
18. SSH-Suche und Import:
    - Gegen den SFTP-Testserver findet die Suche den OpenClaw- und den Hermes-Agenten samt Skills, Plugins (mit
      Einstufung) und MCP-Servern.
    - Der Import daraus läuft wie ein lokaler.
    - `remote-fs` hat keine Schreibmethode, auch nicht über einen Umweg.


## Corrective task execution

- **M-A2-v2:** replaces the superseded M v1 MCP location with the shared, versioned package store. `activeVersion` is canonical, the existing `version` mirrors it, immutable retained versions and metadata remain available, and the per-agent version map is reserved without a selector. The supervisor reuses the package store transaction while package parsing stays in its worker. Recovery finishes or rolls back interrupted publication and migrates already prepared M v1 records. Provider library behavior and existing RPC/CLI document shapes stay intact. Validation is recorded with the task commit.
- **M-A3-v2:** decision 3 makes a first-party installation active for all agents, including an installation that supplies a narrower agent list. Later enable/disable actions can narrow activation. Other trust tiers still require explicit activation and the existing capability approval; capability widening and downgrades retain their approval checks. A required-secret module is held before code publication or synchronous configuration reconciliation can spawn it. A7 replaces this conservative hold with fresh Core metadata and short-lived leased spawn credentials. Existing disabled-state tests use explicit lower-trust fixtures so their approval and rollback assertions remain meaningful.

- **M-A7 native:** one operation lazily reads fresh secret-name metadata; declarations remain intact. Packaged module/channel spawns clear ambient variables and use a private authenticated, bounded binary lease channel immediately around spawn, with a redacted non-Clone environment, revision recheck and ACK/disconnect release. MCP publication, activation and removal use synchronous Core holds; a private names-only hold journal survives uncertain acknowledgments and is settled only after disk recovery under the mutation guard. Secret-store changes reconcile enabled children without enabling disabled ones. Purge checks Core availability before filesystem changes, deletes only declared slots and explicitly discloses that secret values cannot be restored.


- **M-A10:** bundles remain inert and disclose every individually verified direct member; nested bundles, provider members over RPC, digest/name mismatches and operational wrapper rights are refused. Optional selection is bound to exact approved children. One mutation/skills lock, one rollback stack and a private durable journal cover code, cache, state, index, configuration and restore source trash. Pending recovery holds execution and later mutations. Required children use group operations; optional children can be toggled separately and show partial activation. A selected member's full trust, capabilities, scripts and runtime plus the wrapper artifact bind `consentSha256`, checked under the native lock before activation. Updates transfer only an existing identical approved grant, preserve prior scopes and optional disabled flags, and still require consent for wider rights. CLI member selection and complete nested disclosures use the same backend; bundle enable supplies the fresh consent digest. MCP executable trees continue to use only `mcp/<name>/<version>/`.

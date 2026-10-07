# Laufzeit-Pfade des PLUR1BUS-Harness

Scope: every file or directory that the harness creates or reads at runtime, from packages/*/src, crates/*/src, apps/desktop/src-tauri/src, hosts/, deploy/ and Dockerfile. `<state-root>` is the resolved home (see the Linux section). Paths are relative to `<state-root>` unless stated otherwise. Items marked "unklar – prüfen" are listed in the final section.

## Linux

Linux and macOS share the POSIX state layout. The macOS section only lists the differences.

| Pfad / Muster | Zweck | Angelegt von / gelesen von | Quelle |
|---|---|---|---|
| `<state-root>` = `$PLUR1BUS_HOME`, sonst `~/.plur1bus` (`--home` überschreibt) | Home-Wurzel; leerer `PLUR1BUS_HOME` gilt als nicht gesetzt; relative Werte werden gegen cwd aufgelöst | setup legt Unterverzeichnisse an; alle Prozesse lesen | packages/core/src/paths.ts:7-17; crates/plur1bus/src/paths.rs:116-152; crates/plur1bus/src/cli.rs:23 |
| `<state-root>/config.json` | Konfiguration; der Supervisor besitzt die Datei, Schreiben atomar über `config.json.tmp-<pid>` | Supervisor schreibt; core.ts:335 und setup.rs:919 lesen; Leser legt sie nie an | packages/core/src/paths.ts:36; crates/plur1bus/src/paths.rs:169-171; crates/plur1bus-config/src/lib.rs:249, 287-345 |
| `<state-root>/manifest.json` | Install-Manifest (Profil, Node, Module) | setup schreibt; update, repair, ext, firstaid lesen | crates/plur1bus/src/paths.rs:244-247; crates/plur1bus/src/install/setup.rs:313 |
| `<state-root>/run/` (0700) | Laufzeitdateien: Sockets, Tokens, PIDs, Locks | setup legt an und setzt 0700 (setup.rs:403-409); core.ts:272 sichert per securePath; Clients prüfen Vertrauen über plur1bus-rpc trust | crates/plur1bus/src/paths.rs:184-186; crates/plur1bus/src/install/setup.rs:403-409; packages/core/src/core.ts:271-272 |
| `run/core.sock` | Core-RPC-Socket (POSIX) | core öffnet; Clients (plur1bus-rpc, API, Desktop) verbinden | crates/plur1bus/src/paths.rs:318-347; packages/module-api/src/paths.ts:17-20; packages/core/src/paths.ts:43-45 |
| `run/core.token` | Core-RPC-Token; laut Kommentar bei jedem Core-Start neu geschrieben | Lesen: crates/plur1bus/src/paths.rs:195-197 (Layout::core_token), packages/module-api/src/paths.ts:47-49; Schreiber nicht gefunden (siehe Zu prüfen) | crates/plur1bus/src/paths.rs:195-197; packages/module-api/src/paths.ts:47-49 |
| `run/core.pid` | `<pid> <instanceId>` des laufenden Core | core schreibt; Supervisor/Clients lesen (expected_server_pid) | crates/plur1bus/src/paths.rs:198-200, 212-224; packages/module-api/src/paths.ts:32-35 |
| `run/supervisor.sock` | Supervisor-RPC-Socket | Supervisor öffnet; CLI und Desktop verbinden | crates/plur1bus/src/paths.rs:324-326; packages/module-api/src/paths.ts:51-56 |
| `run/supervisor.token` | Supervisor-RPC-Token; Nonce für core.adopt | Supervisor schreibt; Adoption liest (supervisor/adopt.rs:88) | crates/plur1bus/src/paths.rs:202-204; packages/module-api/src/paths.ts:27-30 |
| `run/supervisor.pid` | `<pid> <instanceId>` des Supervisors | Supervisor schreibt; CLI liest | crates/plur1bus/src/paths.rs:206-208; packages/module-api/src/paths.ts:37-40 |
| `run/supervisor.lock` | Single-Instance-Guard: exklusiver OS-Lock für die gesamte Lebensdauer des Supervisors | Supervisor hält, daemon.rs und module.rs prüfen | crates/plur1bus/src/paths.rs:225-228; crates/plur1bus/src/supervisor/mod.rs; crates/plur1bus/src/commands/daemon.rs |
| `run/module-<name>.sock` | Socket eines Moduls | Supervisor startet Modul, Module öffnen Socket | crates/plur1bus/src/paths.rs:293-306, 328-331; packages/module-api/src/paths.ts:17-20 |
| `run/module-<name>.token` | RPC-Token eines Moduls | Supervisor schreibt (child.rs:531 übergibt), Modul liest | crates/plur1bus/src/paths.rs:301-303; crates/plur1bus/src/supervisor/child.rs:531; packages/module-api/src/paths.ts:58-61 |
| `run/module-<name>.pid` | `<pid> <instanceId>` eines Moduls | Modul schreibt, Supervisor liest | crates/plur1bus/src/paths.rs:303; packages/module-api/src/paths.ts:58-61 |
| `run/module-<name>.lock` | Lock-Datei eines Moduls | Modul-Prozess | packages/module-api/src/paths.ts:58-61 |
| `run/api-owner.token` | Owner-Token des Web-Logins (32 Zufallsbytes als 64 Hex, `wx`, 0600) | API erzeugt beim Start (`ensureOwnerToken`); API liest | packages/api/src/owner-token.ts:6-31; packages/api/src/bin.ts |
| `run/api.json` | Discovery-Datei für die native Desktop-Anbindung (`pid`, `instanceId`, `installationId`, `apiVersion`) | Lesen: apps/desktop/src-tauri/src/discovery.rs:39; Schreiber im Repo nicht gefunden (siehe Zu prüfen) | apps/desktop/src-tauri/src/discovery.rs:1, 39 |
| `run/inspect/` | X1-Inspektionsdateien `<inspectionId>.{p1x,json}` mit TTL | ext-Code schreibt und räumt auf | crates/plur1bus/src/ext/paths.rs:20-35 |
| `state/` | Zustandsverzeichnis | setup und core legen an (core.ts:258) | crates/plur1bus/src/paths.rs:172-173; packages/core/src/paths.ts:36 |
| `state/core.lock` | Core-Lock; vom Backup ausgenommen | core | packages/core/src/paths.ts:38; packages/core/src/backup-ops.ts:138 |
| `state/approvals.sqlite` | Approval-Store: grants, approvals, approval_chain in einer Datei (PRAGMA user_version) | core öffnet über approvalsDbPath | packages/core/src/approvals/db.ts:4-11; packages/core/src/core.ts:487 |
| `state/budget.sqlite` | Budget-Service | core | packages/core/src/core.ts:408 |
| `state/sessions.sqlite` | Session-Store | core | packages/core/src/core.ts:460 |
| `state/identity.sqlite` | Identity-Store (Human, Link, Pairing) | core | packages/core/src/core.ts:469 |
| `state/dreams/dreams.db` | Dreaming-Store | core (dreams/index.ts) | packages/core/src/dreams/index.ts:25-26 |
| `state/metrics.token` | Bearer-Token für den Metrics-Endpunkt (0600, Verzeichnis 0700) | core erzeugt beim ersten Start oder liest | packages/core/src/core.ts:551; packages/core/src/metrics/token.ts:16-19 |
| `state/secrets/store.json`, `state/secrets/store.key` | Dateibasierter Secret-Store (Fallback, wenn kein OS-Keyring) | core über createFileBackend | packages/core/src/paths.ts:42; packages/core/src/secrets/file-backend.ts:37-38; packages/core/src/secrets/runtime.ts:45 |
| `state/journal/<agentId>.jsonl` | CLI-Fallback-Journal für memory add ohne erreichbaren Core; Core spielt beim Start nach | CLI schreibt (crates/plur1bus/src/journal.rs:30-49); Core-Replay | crates/plur1bus/src/paths.rs:175-177; crates/plur1bus/src/journal.rs:1-3, 30-49 |
| `state/system-jobs/ledger.jsonl` | Ledger der System-Jobs | core | packages/core/src/core.ts:436; packages/core/src/core.ts:258 |
| `state/reembed/migration.json` | Checkpoint der Re-Embedding-Migration (atomar ersetzt) | core (embedding-migrate/state.ts) | packages/core/src/embedding-migrate/state.ts:76-77 |
| `state/backup-staging/` | Scratch für admin.backup.snapshot; wird vom CLI gepackt und entfernt; verwaiste Staging-Verzeichnisse werden gefegt | core (backup-ops.ts), CLI (create.rs) | packages/core/src/backup-ops.ts:25, 123; crates/plur1bus/src/backup/create.rs:202, 442 |
| `state/lancedb/` | LanceDB-Speicher des Gedächtnisses | Engine (externe Dependency, siehe Zu prüfen) | packages/core/src/paths.ts:20, 36 |
| `state/embedding.sock` | Embedding-IPC-Adresse (Unix-Socket) | Nur Definition ohne Aufrufer im Repo (siehe Zu prüfen) | packages/core/src/platform.ts:18-21 |
| `logs/` | Log-Verzeichnis | setup und core legen an | crates/plur1bus/src/paths.rs:229-231; packages/core/src/paths.ts:40 |
| `logs/<role>.log` | JSON-Lines-Log je Rolle (core, supervisor, api, Module); Rotation nach maxBytes/keep | core, supervisor, api schreiben | crates/plur1bus/src/paths.rs:232-235; packages/core/src/logs/sink.ts:14; packages/api/src/bin.ts:22 |
| `logs/<role>.out.log`, `logs/module-<name>.out.log` | stdout/stderr eines Kindprozesses (Core, Module) | Supervisor-Output-Pump | crates/plur1bus/src/supervisor/child.rs:510-511; crates/plur1bus/src/paths.rs:236-240 |
| `logs/audit.log` | Audit-Stream (JSONL) | core (createJsonlAuditSink, createAuditWriter) | packages/core/src/core.ts:467, 478; crates/plur1bus/src/paths.rs:286-290 |
| `logs/audit-chain.jsonl`, `logs/audit-chain.anchor`, `logs/audit-chain.lock`, `logs/audit-chain.<10-stellige-Nummer>.jsonl` | Hash-verkettete Audit-Kette; rotierte Dateien ab 8 MiB; Anker und Lock | core (core.ts:465), API (api/src/bin.ts:27) | packages/core/src/audit/chain.ts:14-22 |
| `logs/payload.log` | Opt-in-Inhalts-Capture des payload-Streams; wird von der Diagnose-Leseschicht nie gelesen | core-Logger (Stream payload) | packages/log-schema/schema/catalogue.json:4040; packages/core/src/logs/files.ts:3; packages/core/src/logs/writer.ts:69 |
| `agents/<id>/`, `agents/<id>/workspace/` | Agent-Verzeichnis und Workspace | setup legt `agents/` an; core und Import schreiben pro Agent | crates/plur1bus/src/paths.rs:178-183; packages/core/src/paths.ts:37; crates/plur1bus/src/install/setup.rs:398-399, 947 |
| `models/` | Embedding- und Reranker-Modellcache (im Container eigenes Volume) | setup und core legen an; Engine befüllt | crates/plur1bus/src/paths.rs:269-271; crates/plur1bus/src/install/setup.rs:397; packages/core/src/core.ts:258; deploy/compose.yaml:35 |
| `catalog/`, `catalog/models.json` | Modellkatalog (Verzeichnis 0700) | core (createCatalogStore) | packages/core/src/core.ts:384-390; packages/core/src/discovery/catalog-store.ts:113-122; crates/plur1bus/src/paths.rs:274-280 |
| `modules/<name>/module.json`, `modules/<name>.tmp-<pid>/` | Installierte Module; Install staged in `.tmp-<pid>` und benennt um | install schreibt, Supervisor scannt (tmp wird übersprungen) | crates/plur1bus/src/paths.rs:281-285; crates/plur1bus/src/modules/install.rs:1-5, 241-250; crates/plur1bus/src/modules/manifest.rs:144 |
| `skills/<name>/SKILL.md`, `skills/index.json` | Installierte Skills | setup kopiert (setup.rs:967-973); Skill-Registry schreibt index.json | crates/plur1bus/src/paths.rs:248-252; packages/core/src/import/skills-registry.ts:16-17; crates/plur1bus/src/install/setup.rs:396 |
| `imports/<runId>/` (`snapshot/`, `replaced/`, `rolled-back/status.json`, `ledger.jsonl`, `report.json`, `report.txt`) und `imports/.lock` | Import-Läufe mit Snapshot, Rollback-Daten und Report; Lock wird auch von ext-Code genommen | Import-Engine (openclaw.ts, hermes.ts, rollback.ts, skills-import.ts) | crates/plur1bus/src/paths.rs:263-267; packages/core/src/import/importers/openclaw.ts:131-197; packages/core/src/import/importers/hermes.ts:175-284; packages/core/src/import/rollback.ts:170-198; packages/core/src/import/skills-registry.ts:69, 167; packages/core/src/import/skills-import.ts:107-110 |
| `extensions/state.json` | Zustand der installierten Extensions; unlesbar heißt Module werden zurückgehalten | Supervisor und ext-Code | crates/plur1bus/src/ext/paths.rs:26-30; crates/plur1bus/src/supervisor/ext.rs:190-279 |
| `extensions/cache/<sha256>.p1x`, `extensions/cache/<sha256>.json` | Paket-Cache | ext-Code | crates/plur1bus/src/ext/paths.rs:30, 40-47 |
| `extensions/staging/`, `extensions/trash/` | Staging für Installationen; Papierkorb | ext-Code | crates/plur1bus/src/ext/paths.rs:31-32 |
| `extensions/catalog/revocations.json` | Sperrliste der Extension-Katalogs | ext-Code | crates/plur1bus/src/ext/paths.rs:33; crates/plur1bus/src/paths.rs:253-257 |
| `data/ext/<name>/` | Daten einer Extension; bleibt bei Deinstallation erhalten | Kein Aufrufer gefunden (siehe Zu prüfen) | crates/plur1bus/src/paths.rs:258-262 |
| `runtime/node-<version>/bin/node` | Gebündelte Node-Laufzeit; Installation über tmp-Verzeichnis | setup (Installation); Supervisor und commands/core.rs (Lesen) | crates/plur1bus/src/install/setup.rs:440-452, 504-524; crates/plur1bus/src/install/targets.rs:74; crates/plur1bus/src/commands/core.rs:33, 111 |
| `runtime/core/` (`core.js`, `modules/`, `skills/`), `runtime/core.prev/` | Core-Bundle; `core.prev` ist die Vorgängerversion für Rollback | setup und update schreiben; Supervisor startet core.js (child.rs:56) | crates/plur1bus/src/install/setup.rs:598, 617-680, 758, 967; crates/plur1bus/src/supervisor/child.rs:56 |
| `update/state.json`, `update/snapshot/`, `update/staging/` | Update-Zustand, Snapshot (`snapshot.json`, config, manifest, Binary) für Rollback, Staging | update | crates/plur1bus/src/update/state.rs:79-89; crates/plur1bus/src/update/snapshot.rs:13, 44, 52-54; crates/plur1bus/src/update/mod.rs:150, 289-291 |
| `backups/plur1bus-backup-<UTC-Stempel>.tar.gz` | Backup-Archiv (Standard-Ausgabe); `backups/.staging-<ms>-<id>/` ist das Arbeitsverzeichnis | CLI backup create | crates/plur1bus/src/backup/create.rs:72-90, 227-228 |
| `bundles/1staid-bundle-<ms>.zip` | Diagnose-Bundle (Verzeichnis 0700), wenn kein --out angegeben | CLI firstaid bundle | crates/plur1bus/src/firstaid_bundle/mod.rs:345-359 |
| `hosts/hermes-bindings.json`, `hosts/.hermes-bindings.lock` | Registry der Hermes-Bindings (agentId → realpath(HERMES_HOME)) und ihr Lock | Hermes-Host und Installer | hosts/hermes/plur1bus/binding.py:64, 337-338, 380, 396 |
| `$XDG_CONFIG_HOME/systemd/user/<name>.service` (Fallback `~/.config/systemd/user/`) | systemd-User-Unit des Supervisors | CLI setup/service install | crates/plur1bus/src/service/systemd.rs:7-13; crates/plur1bus/src/service/mod.rs:193 |
| `~/.local/bin/plur1bus` | CLI-Binary nach Installation | install.sh; Desktop sucht dort (pair.rs:86) | scripts/install/install.sh:100; apps/desktop/src-tauri/src/pair.rs:86 |

## macOS

macOS uses the POSIX layout above. `<state-root>` is `~/.plur1bus`, not `~/Library/Application Support`. Every row in `## Linux` applies unchanged.

| Pfad / Muster | Zweck | Angelegt von / gelesen von | Quelle |
|---|---|---|---|
| `~/.plur1bus` (= `<state-root>`) | Gleiche Home-Logik wie Linux; kein Application-Support-Pfad | wie Linux | crates/plur1bus/src/paths.rs:139; packages/core/src/paths.ts:16 |
| `~/Library/LaunchAgents/dev.plur1bus.supervisor.plist` (Suffix `-<hash8>` bei Nicht-Standard-Home) | launchd-Agent des Supervisors | CLI setup/service install | crates/plur1bus/src/service/mod.rs:60, 193-197, 485-500; crates/plur1bus/src/service/launchd.rs |
| `<state-root>/logs/supervisor.stderr` | stderr des Supervisors unter launchd | launchd schreibt | crates/plur1bus/src/service/mod.rs:230; crates/plur1bus/src/service/launchd.rs:200, 238 |
| `~/MochiDiffusion/models` (Default, konfigurierbar `modelDir`) | Modellverzeichnis des CoreML-Helpers | Media-Provider `coreml-local` lesen; Helper-Binary separat | packages/media/src/coreml.ts:8, 52 |
| `$TMPDIR/plur1bus-media-*` | Ausgabe-Scratch des CoreML-Helpers, pro Aufruf | Media-Provider | packages/media/src/coreml.ts:65 |
| macOS-Keychain (Dienst `plur1bus:<sha16(home)>` und `app.plur1bus.desktop`) | OS-Keyring für Secrets | core (keyring-backend), Desktop | packages/core/src/secrets/runtime.ts:40-41; packages/core/src/secrets/keyring-backend.ts:8, 25; apps/desktop/src-tauri/src/secrets.rs:76-81 |

## Windows

| Pfad / Muster | Zweck | Angelegt von / gelesen von | Quelle |
|---|---|---|---|
| `%LOCALAPPDATA%\PLUR1BUS` = `<state-root>` (Fallback `<home>\AppData\Local\PLUR1BUS`) | Home-Wurzel unter Windows | setup und alle Prozesse | crates/plur1bus/src/paths.rs:131-138; packages/core/src/paths.ts:12-14; apps/desktop/src-tauri/src/discovery.rs:26 |
| `\\.\pipe\plur1bus-<sha256(lower(home))[0:16]>-core` | Core-RPC-Named-Pipe; Hash über das kleingeschriebene Home | core; Clients | crates/plur1bus/src/paths.rs:333-347, 431-434 (Testvektor `741b3e0a44818d49` für `C:\Users\c\AppData\Local\PLUR1BUS`); packages/module-api/src/paths.ts:7-9 |
| `\\.\pipe\plur1bus-<hash16>-supervisor` | Supervisor-RPC-Pipe | Supervisor; CLI | crates/plur1bus/src/paths.rs:324-326; packages/module-api/src/paths.ts:23-25 |
| `\\.\pipe\plur1bus-<hash16>-module-<name>` | RPC-Pipe eines Moduls | Supervisor startet, Modul öffnet | crates/plur1bus/src/paths.rs:328-331; packages/module-api/src/paths.ts:52-56 |
| `\\.\pipe\plur1bus-embed-<hex(stateRoot)[0:32]>` | Embedding-IPC-Pipe | Nur Definition ohne Aufrufer im Repo (siehe Zu prüfen) | packages/core/src/platform.ts:18-19 |
| `<state-root>\run\<service>.xml` | Task-Scheduler-Definition (XML, UTF-16LE mit BOM) | CLI service install; Task Scheduler liest | crates/plur1bus/src/service/mod.rs:198, 319; crates/plur1bus/src/service/schtasks.rs |
| Task Scheduler: Aufgabe `PLUR1BUS Supervisor` (Suffix `-<hash8>` bei Nicht-Standard-Home) | Registrierung des Supervisors; die Registrierung liegt im Task Scheduler, nicht als Datei | CLI service install | crates/plur1bus/src/service/mod.rs:61, 490-500 |
| `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe` | CLI-Binary nach Installation | install.ps1 (Zeilen 86-88); Desktop sucht dort (pair.rs:84) | scripts/install/install.ps1:85-88; apps/desktop/src-tauri/src/pair.rs:84 |
| `%LOCALAPPDATA%\PLUR1BUS\` und `\bin\` | Verzeichnisse, die der Installer vor dem setup anlegt | install.ps1 | scripts/install/install.ps1:85-88 |
| `%LOCALAPPDATA%\app.plur1bus.desktop\spa-tmp\<zufalls-leaf>\` (mit `.lease`) | WebView2-User-Data-Profile der Desktop-App; nur dieses Modul darf `spa-tmp`-Leaves entfernen | Desktop (windows_spa_profile.rs) | apps/desktop/src-tauri/src/windows_spa_profile.rs:1-2, 595, 1236, 1249-1274, 1312 |
| Windows Credential Manager (Dienste `plur1bus:<sha16(home)>` und `app.plur1bus.desktop`) | OS-Keyring für Secrets | core, Desktop | packages/core/src/secrets/runtime.ts:40-41; packages/core/src/secrets/keyring-backend.ts:25; apps/desktop/src-tauri/src/secrets.rs:76-81 |
| `<state-root>\run\*` (DACL über securePath) | Laufzeitdateien mit benutzerbeschränkter DACL statt 0700 | core (core.ts:271-272); API (api/src/bin.ts:27 wirft, wenn nicht angewendet) | packages/core/src/core.ts:271-272; packages/api/src/bin.ts:27 |
| `%LOCALAPPDATA%\hermes` (Hermes-Default; `HERMES_HOME` überschreibt) | Quelle für den Import und für die Hermes-Host-Bindung | Import (lesend) | packages/core/src/import/sources/hermes.ts:20-27 |
| `\\wsl.localhost\<distro>\…` | Lesezugriff auf WSL-Homes für den Import | Import (lesend) | packages/core/src/import/wsl.ts:437 |

## Alle Plattformen / Container

| Pfad / Muster | Zweck | Angelegt von / gelesen von | Quelle |
|---|---|---|---|
| `$PLUR1BUS_HOME` | Überschreibt den Home-Pfad; wirkt auch in `--home`-losen Aufrufen | Alle Prozesse, Clients, Desktop | packages/core/src/paths.ts:9-10; crates/plur1bus/src/paths.rs:128-130; apps/desktop/src-tauri/src/discovery.rs:22-24 |
| `$PLUR1BUS_CORE_JS` | Pfad des Core-Bundles; Override für `runtime/core/core.js` | Supervisor (child.rs:1512, 1617) | crates/plur1bus/src/supervisor/child.rs:56, 1512, 1617 |
| `$PLUR1BUS_NODE` | Node-Binary für den Core; im Container `/usr/local/bin/node` | Supervisor; systemd/launchd-Unit setzt es | Dockerfile:83; crates/plur1bus/src/service/systemd.rs:143; crates/plur1bus/src/service/launchd.rs:237 |
| Container: `/var/lib/plur1bus` (= `PLUR1BUS_HOME`), Verzeichnisse 10001:10001, 0700, mit `models/` | Zustand im Container | Dockerfile:75-76, 80-82 | Dockerfile:75-82, 88-90 |
| Container: `/var/lib/plur1bus` und `/var/lib/plur1bus/models` als VOLUME; Compose-Volumes `plur1bus-state` und `plur1bus-models` | Persistenz in Docker/Podman-Compose | Docker/Compose | Dockerfile:88; deploy/compose.yaml:31-36, 43-45 |
| Container: `/opt/plur1bus/core/dist/core.js`, `/opt/plur1bus/healthcheck.mjs`, `/usr/local/bin/plur1bus`, `/usr/local/bin/node` | Core-Bundle, Healthcheck, CLI, Node im Image | Dockerfile:77-79, 81-83 | Dockerfile:77-83 |
| Container: `/tmp` als tmpfs (64 MB, noexec, nosuid), `TMPDIR=/tmp` | Einziges beschreibbares Temp-Verzeichnis bei `read_only: true` | deploy/compose.yaml:21; Dockerfile:85 | deploy/compose.yaml:17-23; Dockerfile:85 |
| Container: Healthcheck ruft das `plur1bus`-CLI | Gesundheitsprüfung | deploy/container/healthcheck.mjs:6 | deploy/container/healthcheck.mjs:3-6 |
| `$PLUR1BUS_CONTAINER=1` | Container-Modus: setup und update verweigern | CLI | crates/plur1bus/src/container.rs:5-7 |
| `$PLUR1BUS_DESKTOP_CONFIG_DIR` (nur Debug-Build) | Ersetzt die Desktop-Config-Wurzel: `<dir>/native` als State-Root, `<dir>/logs`, `<dir>/bin/plur1bus(.exe)` | Desktop | apps/desktop/src-tauri/src/discovery.rs:12-17; apps/desktop/src-tauri/src/diagnostics.rs:78; apps/desktop/src-tauri/src/pair.rs:60-70; apps/desktop/src-tauri/src/commands.rs:146-147 |
| `$PLUR1BUS_SECRETS_KEYRING` (nur mit `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) | Test-Keyring (`off` oder `memory`) statt OS-Keyring | core (Tests) | packages/core/src/secrets/runtime.ts:31-36 |
| `$OPENCLAW_STATE_DIR`, `$OPENCLAW_PROFILE`, `$OPENCLAW_HOME`, `~/.openclaw` (Fallback `~/.clawdbot`, `~/.openclaw-<profil>`) | OpenClaw-Quelle für den Import (nur lesend) | Import | packages/core/src/import/sources/openclaw.ts:55-72 |
| `$HERMES_HOME` (Default `~/.hermes`; Windows siehe oben) | Hermes-Quelle für den Import (lesend) und Hermes-Host-Home | Import, Hermes-Host | packages/core/src/import/sources/hermes.ts:20-27 |
| `$HERMES_HOME/plur1bus/journal.ndjson`, `state.json`, `dead-letter.ndjson`, `.lock` | Capture-Journal des Hermes-Hosts (Verzeichnis `plur1bus/`) | hosts/hermes (Journal) | hosts/hermes/plur1bus/journal.py:48-51, 195-206 |
| `$HERMES_HOME/plur1bus.json` (Modus 0600) | Hermes-Binding: nennt das PLUR1BUS-Home und die agentId | hosts/hermes (binding.py) | hosts/hermes/plur1bus/binding.py:62, 156-157, 334 |
| `<dir>/telegram-offset.json` | Persistenter Telegram-Update-Offset; `dir` kommt vom Aufrufer | channels-telegram (FileOffsetStore) | packages/channels-telegram/src/offset.ts:7-9 (siehe Zu prüfen) |
| `os.tmpdir()/p1b-import-sqlite-*`, `os.tmpdir()/p1b-adopt-probe-*` | Temporäre SQLite-Kopien und Adoptions-Probe; werden wieder entfernt | Import | packages/core/src/import/readonly.ts:264; packages/core/src/import/importers/hermes-stores.ts:109 |
| `os.tmpdir()/p1b-acl-*` | ACL-Probe beim Windows-Berechtigungscheck (securePath) | module-api | packages/module-api/src/secure-path.ts:174 |
| Desktop-App-Config (`settings.json`, `connections.json`) über `app_config_dir()` | Desktop-Einstellungen und Verbindungen; Ort folgt der Tauri-Konvention (identifier `app.plur1bus.desktop`) | Desktop | apps/desktop/src-tauri/src/commands.rs:143-148; apps/desktop/src-tauri/src/settings.rs:59, 82, 136; apps/desktop/src-tauri/src/connections.rs:273-276; apps/desktop/src-tauri/tauri.conf.json:5 (siehe Zu prüfen) |
| Desktop-Log und Crash-Dumps über `app_log_dir()` | Native Desktop-Logs (logging::Writer) und Crash-Berichte | Desktop | apps/desktop/src-tauri/src/diagnostics.rs:81-84; apps/desktop/src-tauri/src/logging.rs:137-155 (siehe Zu prüfen) |

## Zu prüfen

- unklar – prüfen: `state/lancedb/`, `state/memory/.snapshots` und der Modell-Cache-Inhalt gehören zur externen Engine `@cyb3rb1ade/plur1bus-memory` (Git-Dependency in packages/core/package.json:14). Nur die Layout-Definitionen liegen im Repo (packages/core/src/paths.ts:36; packages/core/src/backup-ops.ts:138); die Schreibpfade sind nicht verifizierbar.
- unklar – prüfen: `run/api.json`: Die Desktop-App liest es (apps/desktop/src-tauri/src/discovery.rs:39), ein Schreiber im Repo wurde nicht gefunden (auch nicht in packages/api oder crates).
- unklar – prüfen: `run/core.token` und `run/core.pid`: Layout-Accessoren vorhanden (crates/plur1bus/src/paths.rs:195-200; packages/module-api/src/paths.ts:32-49), der Schreibpfad beim Core-Start wurde nicht verifiziert.
- unklar – prüfen: `state/embedding.sock` und `\\.\pipe\plur1bus-embed-…`: `ipcAddress` in packages/core/src/platform.ts:18-21 hat keinen Aufrufer im Repo; die Nutzung liegt vermutlich in der Engine.
- unklar – prüfen: `data/ext/<name>/` (crates/plur1bus/src/paths.rs:258-262) hat keinen Aufrufer; `ext_data(` hat 0 Treffer.
- unklar – prüfen: `catalog/checkpoint.json` und `catalog/snapshot.json` (packages/core/src/catalog/store.ts:44-49): Der `dir`-Parameter wird nicht bis zu seinem Aufrufer verfolgt. Der Modellkatalog (`catalog/models.json`) ist dagegen verifiziert.
- unklar – prüfen: Desktop-Tauri-Pfade (`app_config_dir`, `app_log_dir`, Keychain-Dienstname): Der OS-Ort ergibt sich aus Tauri-Konventionen, nicht aus Repo-Code. Die WebView2-SPA-Profile werden nur unter Windows angelegt; ein Aufruf außerhalb von Windows ist nicht bestätigt.
- unklar – prüfen: `<dir>/telegram-offset.json` (packages/channels-telegram/src/offset.ts:7-9): `FileOffsetStore` wird im Repo nur in Tests instanziert; das produktive Verzeichnis liegt bei einem Aufrufer außerhalb.
- unklar – prüfen: Standard-Unitname des systemd-Services (crates/plur1bus/src/service/mod.rs:51-61, 485-500). Die Tests zeigen Suffixe für Nicht-Standard-Homes; der Default-Name wurde nicht eindeutig verifiziert.

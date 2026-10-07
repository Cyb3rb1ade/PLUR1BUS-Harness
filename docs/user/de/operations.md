# Betriebshandbuch

Wie eine Installation aufgebaut ist, wo ihre Logs liegen, wie man sie je Betriebssystem als Dienst betreibt und wie
man herausfindet, was nicht stimmt. Jeder Befehl existiert in diesem Build (`docs/cli.md`). Die Reparaturleiter für
Agenten steht in `docs/operations.md`; die englische Fassung dieser Seite ist [../en/operations.md](../en/operations.md).
Beginne mit [quickstart.md](quickstart.md), falls noch nichts installiert ist.

## Verzeichnisse

Das Home-Verzeichnis ist, in dieser Reihenfolge: `--home <Pfad>`, die Umgebungsvariable `PLUR1BUS_HOME` (leer gilt
als nicht gesetzt), dann `~/.plur1bus` (Linux, macOS) oder `%LOCALAPPDATA%\PLUR1BUS` (Windows).

| Pfad im Home | Inhalt |
|---|---|
| `config.json` | Die Konfiguration. Ändern mit `plur1bus config set`, nicht von Hand, solange der Supervisor läuft. Beschädigte Fassungen bleiben als `config.json.bak-*`. |
| `manifest.json` | Das Installationsmanifest, das `setup` schreibt. Ohne es antwortet `update --check` mit `E_NOT_AVAILABLE` (reason `not-installed`). |
| `state/` | Die Speicher des Cores und das Write-ahead-Journal (`state/journal`). Nie bearbeiten. |
| `agents/<id>/workspace` | Der Arbeitsbereich eines Agenten. |
| `run/` | Sockets, Tokens und Pid-Dateien der laufenden Prozesse (`core.token`, `core.pid`, `supervisor.token`, `supervisor.pid`, `supervisor.lock`, `module-<name>.token`). Nur für den Besitzer; wird beim Start neu angelegt. |
| `logs/` | Logs, siehe unten. |
| `runtime/` | Die von `setup` installierte Node-Laufzeit und der Core. |
| `skills/` | Installierte Skills, je ein Verzeichnis `<name>/SKILL.md`. |
| `modules/` | Installierte Module. |
| `extensions/` | Erweiterungszustand, Paket-Cache, Staging und Papierkorb (Befehle `skill`, `plugin`, `ext`). |
| `data/ext/<name>` | Eigene Daten einer Erweiterung, bleiben bei der Deinstallation erhalten. |
| `imports/` | Importer-Zustand (`plur1bus import`). |
| `models/`, `catalog/` | Modell-Cache und Modellkatalog (`catalog/models.json`). |

## Logs

Alle unter `<home>/logs/`:

| Datei | Inhalt |
|---|---|
| `supervisor.log`, `core.log`, `<modul>.log` | Die eigenen strukturierten Einträge eines Prozesses, ein JSON-Objekt pro Zeile. |
| `supervisor.out.log`, `core.out.log`, `<modul>.out.log` | Was der Prozess auf stdout und stderr ausgegeben hat. |
| `audit.log` | Nur anhängendes Audit-Log: eine Zeile pro privilegierter Aktion. Lesen, nie ändern. |
| `supervisor.stderr` | Nur macOS: was der Supervisor des launchd-Jobs auf stderr ausgibt. |

Logs rotieren nach Größe: Die neueste rotierte Datei heißt `<datei>.1`, dann `<datei>.2` usw. Systemd führt die
Ausgabe des Supervisors zusätzlich im Benutzer-Journal (siehe unten).

## Dienstverwaltung

`plur1bus service install` meldet den Supervisor beim Dienstmanager des Betriebssystems im eigenen Benutzerkontext
an (keine Administratorrechte) und startet ihn; mit `--no-start` wird nur angemeldet, der Dienst startet dann beim
nächsten Login. `service status` zeigt, ob er angemeldet ist und läuft; `service uninstall` entfernt ihn. `setup`
erledigt das, außer du übergibst `--no-service`.

| | Linux | macOS | Windows |
|---|---|---|---|
| Manager | systemd-Benutzereinheit | launchd-Agent | Aufgabe in der Aufgabenplanung |
| Name (Standard-Home) | `plur1bus` | `dev.plur1bus.supervisor` | `PLUR1BUS Supervisor` |
| Name (anderes Home) | `plur1bus-<8 hex>` | `dev.plur1bus.supervisor-<8 hex>` | `PLUR1BUS Supervisor-<8 hex>` |
| Registrierungsdatei | `$XDG_CONFIG_HOME/systemd/user/<name>.service` (Standard `~/.config/systemd/user/`) | `~/Library/LaunchAgents/<name>.plist` | `<home>\run\<name>.xml` (die Aufgabe selbst liegt in der Aufgabenplanung) |
| Neustart nach Absturz | `Restart=on-failure` | `KeepAlive`, außer bei sauberem Ende | `RestartOnFailure` (jede Minute, bis 999-mal); Logon-Auslöser |

Das Suffix wird aus dem Home-Pfad abgeleitet, damit mehrere Homes je einen Dienst haben können.

```sh
plur1bus service install
plur1bus service status
plur1bus service uninstall
```

Im Alltag nimmst du die Daemon-Befehle; gehört das Home einem angemeldeten Dienst, startet `daemon start` diesen
Dienst:

```sh
plur1bus daemon start
plur1bus daemon status
plur1bus daemon restart
plur1bus daemon stop
```

Unter Linux ist das Log der Einheit auch mit dem üblichen systemd-Werkzeug lesbar: `journalctl --user -u plur1bus`.
Windows und macOS sind aus dem Code dieses Repositorys beschrieben; sie werden nicht bei jedem Release praktisch
durchgespielt.

## Fehlersuche

### Herausfinden, was nicht stimmt

In dieser Reihenfolge; jeder Schritt ist bis `repair` schreibgeschützt:

```sh
plur1bus daemon status
plur1bus 1staid check
plur1bus 1staid repair --dry-run
plur1bus 1staid repair
```

Zu den `1staid check`-Ids gehören `config.valid`, `run.permissions`, `run.stale-files`, `supervisor.state`,
`core.state`, `models.warm`, `core.lock`, `modules.state`, `service.registration`, `journal.backlog`,
`jobs.last-runs`, `runtime.node`, `runtime.core`, `models.cache` und `extensions.integrity`. Bei `warn` oder `fail`
steht ein Hinweis auf den nächsten Befehl dabei. `1staid repair` zeigt einen Plan mit Risikostufe je Schritt, fragt
je Schritt nach (`--yes` bestätigt alle; außerhalb eines Terminals Pflicht), lässt sich mit `--only <step-id>`
eingrenzen und fasst `state/` nie an. Nach dem Anwenden führt es die Prüfungen erneut aus.

Für ein einzelnes Modul `plur1bus module restart <name>`; für alles `plur1bus daemon restart`.

### Exit-Codes

`0` Erfolg; `1` ein Fehler; `2` `E_NOT_AVAILABLE` oder `E_APPROVAL_REQUIRED` (so antwortet auch ein noch nicht
gebauter Befehl); `3` `E_LOCKED`. Mit `--json` ist ein Fehler `{"error": "<code>", "message": ..., "schema": "error/1"}`,
oft mit einem `reason`.

### Fehlercodes

| Code | Typische Bedeutung hier | Was tun |
|---|---|---|
| `E_AGENT_UNKNOWN` | Die Agent-Id ist nicht registriert (`agent main is not registered`). | `plur1bus agent list`, dann `plur1bus agent create <id>`. |
| `E_INVALID_PARAMS` | Ungültige Eingabe, z. B. eine Agent-Id, die nicht aufs Muster passt, oder reason `agent-exists`. | Argument korrigieren. |
| `E_NOT_AVAILABLE` | Ein `reason` nennt den Grund. `not-installed`: kein Installationsmanifest. `config-unavailable`: keine gültige Konfiguration läuft. `container-managed`: ein Container besitzt den Lebenszyklus, das ist erwartet. `foreign-host-store-path`: `setup` lehnte einen Speicherpfad ab, der sich mit dem Zustand eines anderen Hosts überschneidet. Ein Modul kann `manifest-invalid`, `api-version-unsupported`, `disabled`, `needs-unavailable` melden. | `reason` lesen; bei `not-installed` `plur1bus setup`; bei `config-unavailable` `config.json` reparieren (`1staid repair`). |
| `E_CORE_UNAVAILABLE` | Nichts erreicht den Core. | `plur1bus daemon status`, dann `plur1bus daemon start`; `logs/core.log` lesen. |
| `E_CONFIG_INVALID` | Ein Wert, den das Schema ablehnt; das Detail nennt die Fehler. | Vorher mit `plur1bus config set <key> <value> --dry-run` prüfen. |
| `E_CONFLICT` | z. B. reason `config-changed`: Die Konfiguration hat sich seit dem Lesen geändert. | Neu lesen und wiederholen. |
| `E_MODULE_UNKNOWN` | Kein Modul dieses Namens installiert. | `plur1bus module list`. |
| `E_LOCKED` | Ein anderer Prozess hält eine Sperre: die der Engine, des Supervisors oder (reason `skills-locked`) des Skills-Index. | `plur1bus daemon status`; keinen zweiten Supervisor für dasselbe Home starten. |
| `E_UNAUTHORIZED` | Der Client weigerte sich, mit dem Prozess zu sprechen: reason `run-dir-untrusted`, `socket-untrusted` oder `peer-uid-mismatch`. | `plur1bus 1staid check` (`run.permissions`), dann `1staid repair`. |
| `E_RPC_VERSION` | Client und Core sprechen verschiedene RPC-Versionen. | Zusammenpassende Versionen von `plur1bus` und Core betreiben; `plur1bus update --check`. |
| `E_NOT_FOUND`, `E_DENIED`, `E_APPROVAL_REQUIRED`, `E_STORAGE`, `E_INTERNAL` | Wie benannt. | Felder `message` und `reason`; dann `logs/core.log` und `logs/audit.log`. |

Die vollständige Liste mit den Methoden, die den jeweiligen Code auslösen, steht in `docs/rpc.md` („Error codes“).

### Häufige Situationen

- **Supervisor läuft nicht.** `daemon status` zeigt `supervisor: stopped`. Mit `plur1bus daemon start` starten.
  Stoppt er immer wieder, lies `logs/supervisor.log` und `logs/supervisor.out.log`.
- **Core `crashed` oder `degraded`.** `daemon status` nennt den Grund (z. B. `unresponsive`). `logs/core.log` lesen,
  dann `plur1bus daemon restart`.
- **Dienst nicht angemeldet.** `1staid check` zeigt `service.registration` als `warn`. `plur1bus service install`
  (oder der `1staid repair`-Schritt, der ihn erneuert).
- **Eine Konfigurationsänderung bewirkt nichts.** Jeder Schlüssel hat eine Neustartklasse (live, Core oder ein
  Modul); `plur1bus config set <key> <value> --dry-run` zeigt, was neu starten würde.
- **Veraltete Dateien nach einem Absturz.** `1staid check` meldet `run.stale-files`; `1staid repair` entfernt nur
  Dateien, für die kein lebender Prozess mehr einsteht.

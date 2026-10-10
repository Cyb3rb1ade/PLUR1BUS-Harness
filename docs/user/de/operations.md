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

## Aktualisieren

Ein Update spielt ein signiertes Release ein. Der Ablauf ist immer gleich: Plan prüfen, zustimmen, einspielen. Dabei
prüft Plur1bus den Zustand nach dem Einspielen. Schlägt etwas fehl, stellt Plur1bus den vorherigen Stand wieder her.

### Plan prüfen

```sh
plur1bus update --check
plur1bus update --plan
plur1bus update --plan --lang de
```

`--check` vergleicht deine Installation mit dem Release-Manifest und zeigt den Plan. `--plan` zeigt denselben Plan
ausführlicher: die Versionen, die Neuerungen, die Hinweise mit dem, was du tun musst, die Neustarts, die Migrationen,
die Add-ons und die Download-Größe. Beide ändern nichts. Die Sprache des Plans richtet sich nach `--lang en|de`. Ohne
diese Angabe zählt die Systemsprache; beginnt sie mit „de“, ist der Plan deutsch.

### Einspielen

```sh
plur1bus update
plur1bus update --yes
```

Im Terminal fragt Plur1bus nach, bevor es etwas ändert. In einem Skript brauchst du `--yes`, sonst bricht der Befehl ab.
Der Daemon stoppt für das Update kurz.

### Offline einspielen

```sh
plur1bus update --from <datei.tar.zst> --yes
```

Die Datei kann ein `.tar.zst` oder ein `.zip` sein. Sie muss `manifest.json`, `manifest.json.minisig` und die Dateien des
Releases enthalten. Plur1bus prüft die Signatur, dann jede Datei per SHA-256 und Größe. Gehört die Datei zu einem anderen
Kanal als dem installierten, weigert sich der Befehl, außer du nennst den Kanal mit `--channel`.

### Status und Rollback

```sh
plur1bus update status
plur1bus update --rollback
```

`update status` zeigt die Phase und das Ergebnis des letzten Updates und ob ein Rollback möglich ist. `update --rollback`
stellt Programm, `config.json`, das Installationsmanifest und den Core von vor dem letzten Update wieder her. Den
Gedächtnisspeicher berührt das nicht.

### Add-ons

Vor dem Einspielen prüft Plur1bus jeden installierten Skill, jedes Modul und jeden Kanal gegen die neue Version.

- Ein **inkompatibles** Add-on schaltet Plur1bus für die neue Version aus. Eine spätere Version, mit der es wieder passt,
  schaltet es wieder ein. Ein Rollback stellt den vorherigen Zustand her.
- Ein Add-on, das du als **benötigt** markierst, bricht das Update ab, wenn es nicht passt (`addon-incompatible`). Mit
  `--force` aktualisierst du trotzdem; das Add-on wird dann deaktiviert.

```sh
plur1bus update --require-addon <name>
plur1bus update --unrequire-addon <name>
```

### In Firmennetzen

Hinter einem Proxy liest Plur1bus `HTTPS_PROXY` (oder `ALL_PROXY`). `NO_PROXY` ist eine kommagetrennte Liste von
Ausnahmen. Ein ungültiger Proxy-Wert bricht den Vorgang ab; Plur1bus verbindet sich dann nicht direkt.

Nutzt dein Netz eine eigene Zertifizierungsstelle, etwa bei einem prüfenden Proxy, gibst du deren Zertifikate als
PEM-Datei an. Sie ersetzen dann den Zertifikatsspeicher des Systems für HTTPS, nicht nur ergänzen ihn:

```sh
plur1bus update --ca-bundle <pfad>/firmen-ca.pem --check
```

Alternativ setzt du die Umgebungsvariable `PLUR1BUS_CA_BUNDLE` auf denselben Pfad.

## Deinstallieren

`plur1bus uninstall` entfernt die Installation. Deine Daten bleiben standardmäßig erhalten.

```sh
plur1bus uninstall --dry-run
plur1bus uninstall
```

Zuerst zeigst du den Plan mit `--dry-run`; der Befehl ändert dabei nichts. Ohne Angabe fragt Plur1bus im Terminal nach.
Mit `--yes` (kurz `-y`) überspringst du die Rückfrage, etwa in einem Skript. Außerhalb eines Terminals verweigert der
Befehl die Ausführung ohne `--yes` mit Exit-Code 2.

Entfernt werden: der Daemon, die Dienstregistrierung, das Programm selbst, `runtime/`, `update/`, `manifest.json` und
`run/`.

Bleiben erhalten: `config.json`, `agents/`, `skills/`, `modules/`, `extensions/`, `catalog/`, `models/`, `state/`, `data/`,
`logs/` und `backups/`. Installierst du mit `plur1bus setup` im selben Home neu, sind alle Daten wieder da.

Geheimnisse im Schlüsselbund bleiben bei einer normalen Deinstallation ebenfalls. Willst du sie entfernen, lösche sie
vorher:

```sh
plur1bus secret ls
plur1bus secret rm <name>
```

### Alles entfernen

```sh
plur1bus uninstall --purge --backup-out <pfad>/plur1bus-backup.tar.gz
```

`--purge` entfernt das ganze Home-Verzeichnis, Daten inklusive. Vorher schreibt Plur1bus ein Backup neben das Home. Den
Ort wählst du mit `--backup-out`; er darf nicht im Home liegen. Ohne Backup geht es mit `--no-backup`. Kann das Backup
nicht entstehen, etwa weil der Daemon nicht läuft, bricht die Deinstallation ab, bevor sie etwas ändert.

Unter Windows entfernt ein kleines Skript das laufende Programm, sobald der Befehl beendet ist. Die Ausgabe nennt das
Skript. In einem Container verweigert der Befehl die Ausführung, weil das Image die Installation verwaltet.

## Shell-Komfort

`plur1bus completions <shell>` gibt ein Vervollständigungsskript für Bash, Zsh, Fish, PowerShell oder Elvish aus. Du
installierst es dort, wo deine Shell es lädt:

```sh
plur1bus completions bash > ~/.local/share/bash-completion/completions/plur1bus
plur1bus completions zsh > "${fpath[1]}/_plur1bus"
plur1bus completions fish > ~/.config/fish/completions/plur1bus.fish
plur1bus completions powershell | Out-String | Invoke-Expression
```

Öffne danach eine neue Shell. Der PowerShell-Befehl gilt nur für die aktuelle Sitzung. Für dauerhafte Nutzung schreibst du
die Ausgabe in eine Datei und lädst sie aus deinem Profil.

**Manpages** liefert diese Version nicht aus. Die Hilfe bekommst du mit `plur1bus <befehl> --help`.

**Farben.** Mit `--color` bestimmst du, ob die Ausgabe farbig ist:

- `auto` (Standard): farbig nur im Terminal, und nur wenn `NO_COLOR` nicht gesetzt oder leer ist.
- `always`: immer farbig, auch in eine Pipe oder mit gesetztem `NO_COLOR`.
- `never`: nie farbig.

```sh
plur1bus --color never daemon status
```

## Wenn etwas nicht klappt

| Fehler | Bedeutung | Was tun |
|---|---|---|
| `E_NOT_AVAILABLE`, Grund `not-installed` | Es gibt kein Installationsmanifest. | `plur1bus setup` ausführen. |
| `E_NOT_AVAILABLE`, Grund `release-signature-invalid` | Die Signatur passt zu keinem vertrauten Schlüssel. | Nichts erzwingen. Quelle des Releases prüfen. |
| `E_NOT_AVAILABLE`, Grund `digest-mismatch` oder `size-mismatch` | Eine Datei ist beschädigt oder verändert. | Datei neu laden und erneut versuchen. |
| `E_NOT_AVAILABLE`, Grund `release-unreachable` | Der Feed ist nicht erreichbar. | Netzwerk, Proxy und `--ca-bundle` prüfen. |
| `E_NOT_AVAILABLE`, Grund `downgrade-refused` oder `release-replay` | Das Release ist älter als dein Stand. | Nicht erzwingen. Nur wenn du das wirklich willst: `--allow-downgrade`. |
| `E_NOT_AVAILABLE`, Grund `unit-unsupported` | Das Release ändert die Node-Laufzeit oder die Module. | `plur1bus setup` ausführen. |
| `E_NOT_AVAILABLE`, Grund `addon-incompatible` | Ein benötigtes Add-on passt nicht zur neuen Version. | Add-on entfernen oder aktualisieren; sonst `--force`. |
| `E_INVALID_PARAMS`, Grund `ca-bundle-invalid` (Exit 2) | Die PEM-Datei ist nicht lesbar oder enthält kein Zertifikat. | Pfad und Inhalt der Datei prüfen. |
| `E_INVALID_PARAMS`, Grund `confirmation-required` (Exit 2) | Ohne Terminal fehlt `--yes`. | `--yes` angeben. |
| `E_INVALID_PARAMS`, Grund `backup-inside-home` (Exit 2) | Das Backup soll im Home liegen. | Mit `--backup-out` einen anderen Ort wählen. |
| `E_INVALID_PARAMS`, Grund `unsafe-home` oder `not-a-home` (Exit 2) | Das Home-Verzeichnis sieht nicht nach einer Installation aus. | Pfad mit `--home` prüfen; nichts wurde gelöscht. |
| `E_INTERNAL`, Grund `remove-failed` (Exit 1) | Eine Datei ließ sich nicht entfernen. | Ursache beheben und den Befehl erneut ausführen. Die übrigen Teile wurden entfernt. |

Ein Update, das fehlschlägt, stellt den vorherigen Stand selbst wieder her. `plur1bus update status` zeigt, was passiert ist.

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

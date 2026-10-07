# Schnellstart

Diese Seite führt von null zu einer laufenden Installation mit einem Agenten und einer gemerkten Tatsache. Jeder
Befehl unten existiert in diesem Build (`docs/cli.md` ist die vollständige Referenz); wo dieser Build für etwas
keinen Befehl hat, steht das ausdrücklich da. Mit `--json` geben alle Befehle maschinenlesbare Ausgabe. Die
Schwesterseite ist [operations.md](operations.md); die englische Fassung ist [../en/quickstart.md](../en/quickstart.md).

## 1. Installieren

Du brauchst eine `plur1bus`-Programmdatei für deine Plattform (ein Release-Download oder
`cargo build --release -p plur1bus`, das `target/release/plur1bus` erzeugt). Prüfe, dass sie läuft:

```sh
plur1bus --version
```

Die Datei enthält die Kommandozeile und den Supervisor. Die Node-Laufzeit und den Core installiert `setup` im
nächsten Schritt.

## 2. Erster Start: `setup`

```sh
plur1bus setup
```

`setup` führt neun feste Schritte aus: Zustandsverzeichnis, Node-Laufzeit, Core, mitgelieferte Module, Konfiguration,
Skills, OS-Dienst, Start und ein erstes `1staid check`. Es lädt die festgelegte Node-Laufzeit und den Core herunter
und prüft deren SHA-256-Summen. Gefragt wird nur nach dem Grundlegenden (Id des ersten Agenten, Standard `main`, und
die Einbettungs-Nutzungsklasse). Es ist wiederholbar: Ein Schritt, dessen Ergebnis schon installiert ist, wird
übersprungen.

Nützliche Optionen:

```sh
plur1bus setup --non-interactive --agent main --use-class general --accept-nc-licence
plur1bus setup --no-service
plur1bus setup --profile host
```

- `--non-interactive` fragt nie nach; Antworten kommen aus den Flags und Standardwerten (Agent `main`, Klasse `general`).
- `--accept-nc-licence` akzeptiert die nicht-kommerzielle Lizenz der Standardmodelle (wird gefragt, außer bei
  Nutzungsklasse `commercial`).
- `--no-service` überspringt den OS-Dienst; der Supervisor wird für diese Sitzung trotzdem gestartet.
- `--profile host` installiert nur Supervisor und Core (für den Hermes-Host-Modus); `full` ist der Standard.

Wo die Installation liegt: `~/.plur1bus` unter Linux und macOS, `%LOCALAPPDATA%\PLUR1BUS` unter Windows. Mit
`--home <Pfad>` an jedem Befehl oder der Umgebungsvariable `PLUR1BUS_HOME` ändert man das. Siehe
[operations.md](operations.md#verzeichnisse).

Prüfen, ob alles läuft:

```sh
plur1bus daemon status
plur1bus 1staid check
```

`daemon status` zeigt den Zustand von Supervisor und Core; `1staid check` ist schreibgeschützt und meldet jede
Prüfung als `ok`, `warn`, `fail` oder `skip`. Beim allerersten Start kann die Modell-Cache-Prüfung warnen
(„downloads at first warm-up“): Die Einbettungsmodelle werden geladen, wenn der Core sie zum ersten Mal braucht.

## 3. Agent anlegen

`setup` hat den ersten Agenten schon angelegt. Einen weiteren legst du so an:

```sh
plur1bus agent create notes
plur1bus agent list
plur1bus agent status notes
```

Eine Agent-Id passt auf `^[a-z0-9][a-z0-9_-]{0,63}$`. Eine bereits vorhandene Id scheitert mit `E_INVALID_PARAMS`
(reason `agent-exists`). `plur1bus agent remove <id>` entfernt einen Agenten aus dem Register; seine Daten bleiben.

## 4. Erste Unterhaltung

`plur1bus chat` (experimentell) spricht mit einem Agenten: eine Nachricht als Argument oder zeilenweise über stdin bis
EOF. `--agent <id>` wählt den Agenten (Standard: der einzige registrierte), `--session <id>` setzt eine Sitzung fort,
`--no-memory` startet inkognito, sodass nichts vom Chat gemerkt wird:

```sh
plur1bus chat --agent main "Welche Datenbank ist Staging?"
```

Du kannst auch Tatsachen in das Gedächtnis eines Agenten schreiben und sie in jeder späteren Sitzung abrufen:

```sh
plur1bus memory add --agent main "Die Staging-Datenbank heißt orion."
plur1bus memory recall --agent main "welche Datenbank ist Staging?"
```

`memory add` und `memory recall` sind die stabilen Befehle (ADR-016). Ein unbekannter Agent antwortet mit
`E_AGENT_UNKNOWN`. Mehr zu den Gedächtnisbefehlen: `plur1bus memory --help` (list, show, forget, correct, share,
state, propose, proposals).

## 5. Backup und Wiederherstellung

`plur1bus backup` (experimentell) schreibt ein konsistentes Archiv der Installation mit Prüfsummen. `create` braucht
einen laufenden Core; das Archiv enthält nie Geheimnisse (API-Schlüssel bleiben im Schlüsselbund des Betriebssystems,
`run/` wird nie archiviert) und ist weder signiert noch verschlüsselt:

```sh
plur1bus backup create --dry-run          # zeigen, was archiviert würde, nichts schreiben
plur1bus backup create                    # Standard: <home>/backups/plur1bus-backup-<UTC>.tar.gz
plur1bus backup verify <Archiv>           # Manifest und jede SHA-256; Exit 1 bei einem Archiv, das ein Restore ablehnt
```

Zum Wiederherstellen: Daemon stoppen, dann `plur1bus backup restore <Archiv>` ausführen (`--dry-run` zeigt den Plan;
ein Skript braucht `--yes`). Der Befehl prüft zuerst, tauscht jede Einheit per Umbenennen ein und behält Ersetztes in
`<home>/backups/pre-restore-<id>/`; bei einem Fehler wird der alte Stand zurückgelegt. Danach den Daemon starten und
`plur1bus 1staid check` ausführen. `--out <Datei>` wählt den Archivpfad; eine vorhandene Datei wird nie überschrieben.

Automatisch geschieht eines: Ist `config.json` beschädigt, stellt `plur1bus 1staid repair` sie aus der laufenden
Konfiguration oder der neuesten gültigen `config.json.bak-*` daneben wieder her.

## 6. Aktualisieren

`plur1bus update` (experimentell) spielt ein signiertes Release mit Snapshot, Gesundheitsprüfung und automatischem
Rollback ein:

```sh
plur1bus update --check      # mit dem Release-Manifest vergleichen und den Plan zeigen; ändert nichts
plur1bus update              # einspielen (fragt im Terminal nach; ein Skript braucht --yes)
plur1bus update status       # Phase und Ergebnis des letzten Updates, und ob ein Rollback möglich ist
plur1bus update --rollback   # zum Snapshot des zuletzt eingespielten Updates zurückkehren
```

`--channel` (`stable` oder `beta`) wählt den Release-Kanal, `--manifest <Pfad|URL>` ein anderes Manifest als den
signierten Feed des Kanals. Ein Update stoppt den Daemon, sichert Programmdatei, `config.json`, das Installations-
manifest und die Core-Nutzlast (nie den Gedächtnisspeicher), tauscht aus, startet und prüft `--version`, einen
bereiten Core und `1staid check`; bei jedem Fehler wird der Snapshot zurückgelegt. Ein Release, das die Node-Laufzeit
oder den Modulsatz ändert, wird abgelehnt: führe stattdessen `plur1bus setup` aus.

## Weiter

[operations.md](operations.md): Verzeichnisse, Logs, Dienstverwaltung je Betriebssystem und Fehlersuche.

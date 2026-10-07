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

Dieser Build hat keinen `chat`-Befehl. Möglich ist, Tatsachen in das Gedächtnis eines Agenten zu schreiben und sie
in jeder späteren Sitzung abzurufen:

```sh
plur1bus memory add --agent main "Die Staging-Datenbank heißt orion."
plur1bus memory recall --agent main "welche Datenbank ist Staging?"
```

`memory add` und `memory recall` sind die stabilen Befehle (ADR-016). Ein unbekannter Agent antwortet mit
`E_AGENT_UNKNOWN`. Mehr zu den Gedächtnisbefehlen: `plur1bus memory --help` (list, show, forget, correct, share,
state, propose, proposals).

## 5. Backup und Wiederherstellung

Dieser Build hat keinen `backup`-Befehl. Alles, was die Installation besitzt, liegt im Home-Verzeichnis; ein Backup
ist also eine Kopie dieses Verzeichnisses, gemacht, während nichts läuft:

```sh
plur1bus daemon stop
# das gesamte Home-Verzeichnis mit einem Werkzeug deiner Wahl kopieren (siehe operations.md#verzeichnisse)
plur1bus daemon start
```

Zum Wiederherstellen: Daemon stoppen, die Kopie anstelle des Home-Verzeichnisses einspielen, Daemon starten und
`plur1bus 1staid check` ausführen. Zwei Grenzen: `run/` enthält Sockets, Tokens und Pid-Dateien, die beim Start neu
entstehen, also nie ein Home in eine laufende Installation kopieren; und eine Kopie ist nur so konsistent wie der
Moment, in dem du den Daemon gestoppt hast.

Automatisch geschieht eines: Ist `config.json` beschädigt, stellt `plur1bus 1staid repair` sie aus der laufenden
Konfiguration oder der neuesten gültigen `config.json.bak-*` daneben wieder her.

## 6. Aktualisieren

Dieser Build kann auf ein Update prüfen, aber keines einspielen:

```sh
plur1bus update --check
```

`update --check` vergleicht die Installation mit dem Release-Manifest ihres Kanals (`stable` oder `beta`, siehe
`--channel`), zeigt, welche Einheiten sich ändern und neu starten würden, und ändert nichts. Ohne `--check` meldet
`plur1bus update`, dass das Einspielen eines Releases mit M8 kommt, und endet mit Code 2. Um heute auf eine neuere
Version zu wechseln, installiere die neuere Programmdatei und führe `plur1bus setup` erneut aus; Schritte, deren
Ergebnis aktuell ist, werden übersprungen.

## Weiter

[operations.md](operations.md): Verzeichnisse, Logs, Dienstverwaltung je Betriebssystem und Fehlersuche.

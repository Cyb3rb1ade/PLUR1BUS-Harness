# Import rückgängig machen (Import-Rollback)

Wenn du Erinnerungskarten und Skills aus einem externen System (wie Hermes) importierst, protokolliert Plur1bus einen detaillierten Importbericht. Über die Rollback-Funktion lässt sich ein Import sauber rückgängig machen. Die englische Version dieser Seite ist [../en/import-rollback.md](../en/import-rollback.md).

> **Verfügbarkeitshinweis:** Import-Rollback nutzt `memory.unimport` und ist verfügbar ab Engine 1.15.

## So geht's

### Web-UI

1. Öffne die **Einstellungen → Import & Verlauf** (`#/settings`).
2. Wähle den gewünschten Importlauf aus der Historie aus.
3. Klicke auf **Rollback-Vorschau**: Der Dialog berechnet, welche importierten Karten und Skills archiviert werden und welche vom Nutzer bearbeiteten Karten erhalten bleiben.
4. Klicke auf **Rollback anwenden** und bestätige den Vorgang.

### CLI

1. Quelldaten und vorherigen Importstatus prüfen:

```sh
plur1bus import hermes --detect
```

2. Probelauf für den Rollback ausführen (Standard-Vorschau, ändert keine Daten):

```sh
plur1bus import hermes --rollback <REPORT>
```

3. Rollback verbindlich anwenden:

```sh
plur1bus import hermes --rollback <REPORT> --apply
```

## Gut zu wissen

- **Archivieren statt Löschen:** Die Memory-Engine führt `memory.unimport` aus. Importierte Karten werden archiviert, nicht hart gelöscht und nicht mit Tombstones versehen.
- **Vom Nutzer bearbeitete Karten bleiben:** Wenn du oder ein Agent eine importierte Karte nach dem Import bearbeitet, korrigiert oder ergänzt hat, gilt sie als nutzereigen. Der Rollback lässt alle bearbeiteten Karten unverändert bestehen.
- **Quellsystem bleibt unberührt:** Das Quellsystem (z. B. dein Hermes-Verzeichnis) wird während des Imports und des Rollbacks ausschließlich lesend angesprochen.
- **Wiederholung möglich:** Ein Rollback sperrt oder beschädigt den Store nicht. Du kannst den Import jederzeit mit angepassten Pfaden oder Konfliktregeln erneut ausführen.

## Fehlermeldungen

- `E_REPORT_NOT_FOUND`: Die angegebene Import-Berichtsdatei existiert nicht oder kann nicht gelesen werden.
- `E_ENGINE_FEATURE_UNAVAILABLE`: Rollback wurde auf einer Engine-Version vor 1.15 angefordert. Aktualisiere deine Plur1bus Engine auf Version 1.15 oder neuer.
- `E_CONFLICT`: Ein paralleler Schreibvorgang oder eine andere Archivierungsoperation blockiert den Vorgang.

## Weiter

- Betrieb und Wartung: [Betriebshandbuch](operations.md)
- Desktop-Pakete und Migration: [Desktop](desktop.md)
- Schnellstart: [Schnellstart](quickstart.md)

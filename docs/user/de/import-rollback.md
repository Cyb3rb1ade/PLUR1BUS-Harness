# Import rückgängig machen (Import-Rollback)

Jeder Importlauf, den du mit `--apply` anwendest, legt einen Bericht und einen Snapshot des Zustands davor an. Der Rollback nutzt beides, um Plur1bus in diesen Zustand zurückzuversetzen. Die englische Version dieser Seite ist [../en/import-rollback.md](../en/import-rollback.md).

> **Umfang:** Der CLI-Bericht unterscheidet wiederhergestellte Dateien und Konfiguration, wiederhergestellte oder entfernte Stores sowie Engine-Verknüpfungen. Erinnerungskarten ohne wiederherstellbaren Store-Snapshot können als `not-reverted (engine has no undo)` verbleiben. Prüfe den tatsächlichen Bericht; ein Rollback verspricht nicht die Löschung jeder importierten Karte.

## CLI-Ablauf

Der [Web-Import](import.md) enthält Verlauf, Rollback-Vorprüfung und ausdrückliche Bestätigung. Die Prüfung der produktiven Web-Wartung mit angehaltenem Core steht noch aus. Nutze bis zu deren Abschluss den vorhandenen CLI-Ablauf unten. Die Weboberfläche bietet keinen Force-Schalter.

1. Quelle und das, was ein Import fände, ansehen. Das ändert nichts:

```sh
plur1bus import hermes --detect
```

2. Rollback eines Laufs in der Vorschau ansehen. Übergib die `report.json` des Laufs; sie liegt im Ordner `imports` deines Plur1bus-Verzeichnisses unter der Lauf-ID. Ohne `--apply` wird nichts geschrieben.

```sh
plur1bus import hermes --rollback <REPORT>
```

3. Rollback anwenden. Stoppe vorher den Core; ein Rollback läuft nicht, solange der Core läuft.

```sh
plur1bus import hermes --rollback <REPORT> --apply
```

Dasselbe gilt für die andere Import-Quelle: `plur1bus import --help` zeigt die Quellnamen.

## Gut zu wissen

- **Erst die Vorschau:** Der Rollback ist ein Probelauf, solange du nicht `--apply` angibst. Der Bericht listet, was entfernt, wiederhergestellt oder behalten würde.
- **Deine Änderungen bleiben:** Eine Datei, die der Import angelegt und die du danach geändert hast, wird nicht gelöscht. Sie wird gesichert, bleibt liegen und als `kept-modified` gemeldet. Die Option `--force` löscht solche Dateien nach der Sicherung.
- **Erinnerungskarten und Verknüpfungen:** Prüfe den Bericht. Ein gesicherter Store kann wiederhergestellt oder entfernt und gespeicherte Engine-Verknüpfungen können gelöst werden. Karten außerhalb dieses Wiederherstellungsumfangs werden als nicht zurückgenommen gemeldet.
- **Im Zweifel Abbruch:** Ein beschädigtes oder fehlendes Ledger oder ein Snapshot, der nicht zum Bericht passt, stoppt den Rollback, statt Erfolg zu melden und importierte Dateien liegen zu lassen.
- **Die Quelle bleibt unverändert:** Dein Quellverzeichnis (zum Beispiel das Hermes-Verzeichnis) wird beim Import und beim Rollback nur gelesen.
- **Nur einmal:** Ein Lauf, der schon zurückgerollt wurde, wird abgelehnt. Du kannst jederzeit mit anderen Optionen erneut importieren.

## Fehlermeldungen

Der Importer meldet eigene Fehlercodes; der `reason` sagt, was nicht stimmt.

- `E_ROLLBACK_INVALID` mit reason `report-unreadable`, `report-missing` oder `report-outside-home`: Die Berichtsdatei ist nicht lesbar, existiert nicht oder ist nicht die `report.json` ihres Lauf-Ordners. Gib die Datei aus dem Ordner des Laufs an.
- `E_ROLLBACK_INVALID` mit reason `not-an-apply-report`: Der Lauf war nur eine Vorschau, es gibt nichts rückgängig zu machen. `already-rolled-back`: Der Lauf wurde schon zurückgerollt. `source-mismatch`: Der Bericht gehört zu einer anderen Quelle als der im Befehl.
- `E_ROLLBACK_INVALID` mit reason `snapshot-missing`, `snapshot-corrupt`, `snapshot-invalid`, `ledger-corrupt` oder `unsafe-symlink`: Dem gesicherten Zustand ist nicht zu trauen, deshalb wird nichts wiederhergestellt.
- `E_ROLLBACK_STALE` mit reason `skills-changed-since`: Deine Skills haben sich nach diesem Lauf geändert. Rolle zuerst die späteren Läufe zurück.
- Reason `target-running` (eigener Fehler des Importers): Der Core läuft. Stoppe ihn mit `plur1bus daemon stop` und versuche es erneut.

## Weiter

- Quellauswahl, Vorschau und Web-Wartungsgrenzen: [Import](import.md)

- Betrieb und Wartung: [Betriebshandbuch](operations.md)
- Desktop-Pakete und Migration: [Desktop](desktop.md)
- Schnellstart: [Schnellstart](quickstart.md)
